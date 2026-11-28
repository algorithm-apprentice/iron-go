import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { runFeedback } from "./feedback.mjs";

const stage = (name, script, ...args) => ({ name, command: process.execPath, args: ["--input-type=module", "-e", script, ...args] });

async function waitForPath(path) {
  const deadline = Date.now() + 4000;
  while (true) {
    try { await access(path); return; }
    catch (error) { if (Date.now() >= deadline) throw error; }
    await delay(15);
  }
}

async function waitForExit(exited) {
  const timer = new AbortController();
  try {
    return await Promise.race([exited, delay(4000, undefined, { signal: timer.signal, ref: false }).then(() => {
      throw new Error("The disposable process did not exit.");
    })]);
  } finally { timer.abort(); }
}

function killFixtureProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try { process.kill(pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

test("feedback overlaps independent stages and reports failures after they all settle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iron-feedback-"));
  const ready = join(directory, "ready");
  const finished = join(directory, "finished");
  try {
    const results = await runFeedback([
      stage("first", `import { existsSync } from 'node:fs';
        const deadline = Date.now() + 2000;
        while (!existsSync(process.argv[1])) {
          if (Date.now() >= deadline) process.exit(3);
          await new Promise(resolve => setTimeout(resolve, 10));
        }`, ready),
      stage("failure", "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[1], 'ready'); process.exit(17)", ready),
      stage("last", `import { writeFileSync } from 'node:fs';
        await new Promise(resolve => setTimeout(resolve, 70)); writeFileSync(process.argv[1], 'finished');`, finished),
    ], { report() {} });
    assert.deepEqual(results.stages.map(({ name, code }) => [name, code]), [["first", 0], ["failure", 17], ["last", 0]]);
    assert.equal(results.code, 1);
    assert.equal(await readFile(finished, "utf8"), "finished");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("interrupting feedback lets its owned subprocess finish signal cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iron-feedback-signal-"));
  const ready = join(directory, "ready");
  const cleaned = join(directory, "cleaned");
  const normal = join(directory, "normal-finish");
  const nested = `import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => { writeFileSync(process.argv[2], 'wrong group signal'); process.exit(2); });
    process.stdin.resume(); process.stdin.on('end', () => writeFileSync(process.argv[2], 'closed normally'));
    writeFileSync(process.argv[1], JSON.stringify([process.pid, process.ppid]));`;
  const worker = { ...stage("native", `import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(nested)}, ...process.argv.slice(1)],
      { stdio: ['pipe', 'inherit', 'inherit'] });
    process.on('SIGTERM', () => child.stdin.end());
    child.on('exit', code => { process.exitCode = code; });`, ready, cleaned), interrupt: true };
  const independent = stage("checks", `import { existsSync, writeFileSync } from 'node:fs';
    const deadline = Date.now() + 2500;
    while (!existsSync(process.argv[1])) {
      if (Date.now() >= deadline) process.exit(4);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    writeFileSync(process.argv[2], 'finished');`, cleaned, normal);
  const program = `import { runFeedback } from ${JSON.stringify(new URL("./feedback.mjs", import.meta.url).href)};
    process.exitCode = (await runFeedback(${JSON.stringify([worker, independent])}, { report() {} })).code;`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], { stdio: "inherit" });
  const exited = once(child, "exit");
  try {
    await waitForPath(ready);
    child.kill("SIGTERM");
    assert.deepEqual(await waitForExit(exited), [143, null]);
    assert.equal(await readFile(cleaned, "utf8"), "closed normally");
    assert.equal(await readFile(normal, "utf8"), "finished");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      for (const pid of await readFile(ready, "utf8").then(JSON.parse).catch(() => [])) killFixtureProcess(pid);
      child.kill("SIGKILL");
    }
    await waitForExit(exited);
    await rm(directory, { recursive: true, force: true });
  }
});

async function assertNativeBuildInterrupt(beforeAdmission) {
  const directory = await mkdtemp(join(tmpdir(), "iron-feedback-build-"));
  const native = join(directory, "tests", "native");
  const ready = join(directory, "ready");
  const started = join(directory, "started");
  const release = join(directory, "release");
  const done = join(directory, "done");
  let runner, exited;
  try {
    await mkdir(native, { recursive: true });
    for (const name of ["workbench.mjs", "plan.mjs"]) await copyFile(new URL(`./native/${name}`, import.meta.url), join(native, name));
    const build = join(directory, "build.mjs");
    await writeFile(join(directory, "npm"), '#!/bin/sh\nexec "$IRON_TEST_NODE" "$IRON_TEST_BUILD"\n', { mode: 0o700 });
    await writeFile(build, `import { existsSync, writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(started)}, String(process.pid));
      writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      const deadline = Date.now() + 3500;
      while (!existsSync(${JSON.stringify(release)})) {
        if (Date.now() >= deadline) process.exit(4);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      writeFileSync(${JSON.stringify(done)}, 'build finished');`);
    const args = [join(native, "workbench.mjs"), "--group", "go"];
    if (beforeAdmission) {
      const preload = join(directory, "pause-log-open.mjs");
      // Only the disposable runner waits at the async log-open boundary.
      await writeFile(preload, `import { createRequire, syncBuiltinESMExports } from 'node:module';
        import { existsSync, writeFileSync } from 'node:fs';
        const fs = createRequire(import.meta.url)('node:fs/promises');
        const open = fs.open;
        fs.open = async (path, ...args) => {
          if (path.endsWith('/build.log')) {
            writeFileSync(${JSON.stringify(ready)}, 'opening build log');
            const deadline = Date.now() + 3500;
            while (!existsSync(${JSON.stringify(release)})) {
              if (Date.now() >= deadline) throw new Error('test log open expired');
              await new Promise(resolve => setTimeout(resolve, 10));
            }
          }
          return open(path, ...args);
        };
        syncBuiltinESMExports();`);
      args.unshift("--import", preload);
    }
    runner = spawn(process.execPath, args, {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, IRON_TEST_NODE: process.execPath, IRON_TEST_BUILD: build },
      stdio: "ignore",
    });
    exited = once(runner, "exit");
    await waitForPath(ready);
    runner.kill("SIGTERM");
    await delay(80);
    assert.equal(runner.exitCode, null, "The runner must wait for the in-flight operation.");
    await writeFile(release, "release");
    assert.deepEqual(await waitForExit(exited), [1, null]);
    if (beforeAdmission) await assert.rejects(access(started), { code: "ENOENT" });
    else assert.equal(await readFile(done, "utf8"), "build finished");
  } finally {
    if (runner && runner.exitCode === null && runner.signalCode === null) {
      killFixtureProcess(Number(await readFile(started, "utf8").catch(() => "")));
      runner.kill("SIGKILL");
    }
    if (exited) await waitForExit(exited);
    await rm(directory, { recursive: true, force: true });
  }
}

test("an interrupted native build drains before the runner exits", () => assertNativeBuildInterrupt(false));
test("interrupting the runner before admission does not start a build", () => assertNativeBuildInterrupt(true));

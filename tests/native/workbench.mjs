import assert from "node:assert/strict";
import { execFileSync, fork, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { collectGroups, fixtureGroups, nativePlan, runtimeClean, summarizeGroup, validReport, validTerminal } from "./plan.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workerPath = fileURLToPath(new URL("./session.mjs", import.meta.url));
const quitSource = fileURLToPath(new URL("./request-quit.swift", import.meta.url));
const { values, groups } = nativePlan(process.argv.slice(2));
assert.equal(process.platform, "darwin", "Native acceptance requires macOS.");
const artifacts = path.join(root, "test-results/native", `${Date.now()}-${process.pid}`);
await mkdir(artifacts, { recursive: true });
console.log(`Native acceptance artifacts: ${path.relative(root, artifacts)}`);

let interrupt;
let resolveInterrupt;
const interrupted = new Promise(resolve => { resolveInterrupt = resolve; });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { if (!interrupt) { interrupt = signal; resolveInterrupt(signal); } });
}

const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "iron-go-acceptance-")));
const preserve = new Set();
const report = { selected: groups, unselected: fixtureGroups.filter(group => !groups.includes(group)), groups: [] };

function port() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function monitor(child) {
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  exited.catch(() => {});
  return { child, exited };
}

async function logged(executable, args, logfile, env, pipe = false) {
  const log = await open(logfile, "w");
  try {
    const child = spawn(executable, args, { cwd: root, env, stdio: [pipe ? "pipe" : "ignore", log.fd, log.fd] });
    child.stdin?.on("error", () => { /* Exit can race closing the pipe. */ });
    return monitor(child);
  } finally { await log.close(); }
}

async function bounded(promise, ms) {
  const timer = new AbortController();
  try { return await Promise.race([promise, delay(ms, undefined, { signal: timer.signal, ref: false })]); }
  finally { timer.abort(); }
}

async function terminate({ child, exited }) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  let result = await bounded(exited.catch(() => null), 1500);
  if (result === undefined) {
    child.kill("SIGKILL");
    result = await bounded(exited.catch(() => null), 1500);
  }
  return result;
}

function processes() {
  return new Map(execFileSync("ps", ["-axo", "pid=,ppid=,lstart=,comm="], { encoding: "utf8", timeout: 5000 })
    .split("\n").flatMap(row => {
      const entry = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return entry ? [[Number(entry[1]), { pid: Number(entry[1]), parent: Number(entry[2]), stamp: entry[3] }]] : [];
    }));
}

function descendants(pid) {
  const rows = [...processes().values()];
  const lineage = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (lineage.has(row.parent) && !lineage.has(row.pid)) { lineage.add(row.pid); changed = true; }
  }
  return rows.filter(row => row.pid !== pid && lineage.has(row.pid));
}

async function remainingChildren(observed) {
  const end = Date.now() + 4000;
  let remaining = observed;
  while (remaining.length) {
    const current = processes();
    remaining = remaining.filter(row => current.get(row.pid)?.stamp === row.stamp);
    if (!remaining.length || Date.now() >= end) break;
    await delay(80);
  }
  return remaining;
}

async function appCleanup(app, groupReport, directory, group) {
  const alreadyExited = app.child.exitCode !== null || app.child.signalCode !== null;
  const failures = [];
  let observed = [];
  if (!alreadyExited) {
    try { observed = descendants(app.child.pid); }
    catch (error) { failures.push(`Could not observe app descendants: ${error}`); }
  }
  const shutdown = { appPid: app.child.pid, observed, terminal: validTerminal(group, groupReport?.terminal) };
  if (group === "crash") {
    const probe = await readFile(path.join(directory, "crash-probe.json"), "utf8").then(JSON.parse).catch(() => undefined);
    shutdown.crashProbePid = probe?.pid;
    if (!probe || !observed.some(child => child.pid === probe.pid)) failures.push("Crash probe did not observe a live owned Go child.");
  }
  app.child.stdin?.end();
  let exit = await bounded(app.exited, 14_000);
  if (exit === undefined) {
    failures.push("App did not exit after supervision EOF; forced its direct child handle only.");
    exit = await terminate(app);
  }
  shutdown.exit = exit;
  const log = await readFile(path.join(directory, "app.log"), "utf8");
  shutdown.acknowledged = log.split(/\r?\n/).includes("IRON_E2E_SUPERVISOR_STOP_COMPLETE");
  let expectedTerminal = false;
  if (alreadyExited && validReport(group, groupReport) && shutdown.terminal) {
    try {
      const state = JSON.parse(await readFile(path.join(directory, "last-live.json"), "utf8"));
      runtimeClean(state.runtimeErrors);
      expectedTerminal = true;
    } catch (error) { failures.push(`Could not verify the terminal checkpoint: ${error}`); }
  }
  if (exit?.code !== 0 || (!expectedTerminal && !shutdown.acknowledged)) failures.push("Native app teardown was not verified.");
  shutdown.nativeTerminal = expectedTerminal && exit?.code === 0;
  shutdown.remaining = await remainingChildren(observed);
  if (shutdown.remaining.length) failures.push("Observed test-owned descendants remain after app shutdown.");
  await writeFile(path.join(directory, "cleanup.json"), JSON.stringify(shutdown, null, 2));
  return { failure: failures.join(" ") || undefined, nativeTerminal: shutdown.nativeTerminal };
}

async function goEnvironment() {
  const env = { ...process.env, GOENV: "off", GOWORK: "off", GOFLAGS: "", GOTOOLCHAIN: values.project ? process.env.GOTOOLCHAIN || "auto" : "local" };
  const goBin = execFileSync("go", ["env", "GOBIN", "GOPATH"], { encoding: "utf8", timeout: 10_000,
    env: { ...process.env, GOTOOLCHAIN: "local", GOWORK: "off" } }).trimEnd().split("\n");
  env.PATH = [process.env.PATH, goBin[0], ...((goBin[1] ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, "bin"))), path.join(homedir(), "go/bin")].filter(Boolean).join(path.delimiter);
  if (values.project) {
    const cache = execFileSync("go", ["env", "GOMODCACHE", "GOCACHE"], { encoding: "utf8", env: { ...env, GOTOOLCHAIN: "local" }, timeout: 10_000 }).trimEnd().split("\n");
    [env.GOMODCACHE, env.GOCACHE] = cache;
  } else {
    env.GOCACHE = path.join(temporary, "build-cache");
    env.GOMODCACHE = path.join(temporary, "module-cache");
    env.GOBIN = "";
    env.GOCACHEPROG = "";
    await Promise.all([mkdir(env.GOCACHE), mkdir(env.GOMODCACHE)]);
  }
  return env;
}

async function runGroup(executable, env, group, quitHelper) {
  if (interrupt) return { group, result: "not-run", reason: `Interrupted by ${interrupt}.`, cases: [] };
  console.log(`  GROUP ${group}`);
  const directory = path.join(artifacts, group);
  const fixtureRoot = path.join(temporary, group);
  const fixture = path.join(fixtureRoot, "workspace", values.project ? path.basename(path.resolve(values.project)) : "orbit");
  const home = path.join(fixtureRoot, "home");
  let app, worker, workerExit, groupReport, failure, cleanup, nativeTerminal;
  const diagnostics = [];
  try {
    await mkdir(directory);
    await mkdir(home, { recursive: true });
    await mkdir(path.dirname(fixture));
    if (values.project) {
      await mkdir(fixture);
      const snapshot = execFileSync("git", ["-C", path.resolve(values.project), "archive", "--format=tar", "HEAD"], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
      execFileSync("tar", ["-xf", "-", "-C", fixture], { input: snapshot, timeout: 60_000 });
    } else await cp(path.join(root, "tests/fixtures/orbit"), fixture, { recursive: true });
    const groupEnv = { ...env };
    if (group === "files") groupEnv.GOWORK = "auto";
    if (!values.project) {
      groupEnv.GOPATH = path.join(fixtureRoot, "gopath");
      groupEnv.GOTMPDIR = path.join(fixtureRoot, "go-tmp");
      await Promise.all([mkdir(groupEnv.GOPATH), mkdir(groupEnv.GOTMPDIR)]);
    }
    const available = await port();
    app = await logged(executable, [], path.join(directory, "app.log"), {
      ...groupEnv, HOME: home, CFFIXED_USER_HOME: home,
      IRON_GO_E2E_WORKSPACE: fixture, TAURI_WEBDRIVER_PORT: String(available),
      IRON_GO_E2E_WATCH_STDIN: "1", IRON_GO_E2E_EXIT_TIMEOUT_MS: group === "quit" || group === "quit-save" ? "10000" : "",
    }, true);
    const config = { group, values, driver: `http://127.0.0.1:${available}`, artifacts: directory, fixture, home, pid: app.child.pid, quitHelper };
    worker = monitor(fork(workerPath, [JSON.stringify(config)], { cwd: root, execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"] }));
    void app.exited.then(result => {
      if (worker.child.connected) worker.child.send({ type: "app-exit", result }, () => {});
    }, () => {});
    const deadline = values.project ? 8 * 60_000 : 4 * 60_000;
    workerExit = await Promise.race([bounded(worker.exited, deadline), interrupted.then(() => undefined)]);
    if (workerExit === undefined) failure = interrupt ? `Interrupted by ${interrupt}.` : "Native group deadline expired.";
  } catch (error) { failure = String(error.stack ?? error); }
  finally {
    if (worker && workerExit === undefined) {
      try { workerExit = await terminate(worker); }
      catch (error) { diagnostics.push(`Worker termination: ${error}`); }
    }
    groupReport = await readFile(path.join(directory, "report.json"), "utf8").then(JSON.parse).catch(() => undefined);
    if (app) {
      try { ({ failure: cleanup, nativeTerminal } = await appCleanup(app, groupReport, directory, group)); }
      catch (error) {
        cleanup = `Could not verify native app cleanup: ${error}`;
        app.child.stdin?.end();
        await terminate(app).catch(fallback => diagnostics.push(`App fallback: ${fallback}`));
      }
    }
    if (cleanup || (worker && !workerExit)) {
      preserve.add(fixtureRoot);
      diagnostics.push(`Preserved disposable paths: ${fixtureRoot}`);
    } else {
      try { await rm(fixtureRoot, { recursive: true, force: true }); }
      catch (error) { cleanup = `Could not remove disposable group: ${error}`; preserve.add(fixtureRoot); }
    }
  }
  return summarizeGroup(group, { worker: workerExit, report: groupReport, failure, cleanup, nativeTerminal, diagnostics });
}

try {
  const target = path.resolve(root, process.env.CARGO_TARGET_DIR ?? "src-tauri/target");
  const executable = path.join(target, "debug/iron-go-acceptance");
  if (!values["skip-build"]) {
    const build = await logged("npm", ["run", "tauri", "build", "--", "--debug", "--no-bundle", "--features", "e2e", "--config", "src-tauri/tauri.e2e.conf.json"], path.join(artifacts, "build.log"), {
      ...process.env, CARGO_TARGET_DIR: target, VITE_IRON_E2E: "1",
    });
    const result = await Promise.race([bounded(build.exited, 10 * 60_000), interrupted.then(() => undefined)]);
    if (result === undefined) await terminate(build);
    assert.equal(result?.code, 0, `Native build failed or interrupted; see ${artifacts}/build.log`);
  }
  await access(executable, constants.X_OK);
  let quitHelper;
  if (groups.some(group => ["lifecycle", "quit", "quit-save"].includes(group))) {
    quitHelper = path.join(temporary, "request-quit");
    const compiler = await logged("swiftc", [quitSource, "-o", quitHelper], path.join(artifacts, "quit-helper-build.log"), process.env);
    const result = await Promise.race([bounded(compiler.exited, 120_000), interrupted.then(() => undefined)]);
    if (result === undefined) await terminate(compiler);
    assert.equal(result?.code, 0, `Native Quit helper build failed or was interrupted; see ${artifacts}/quit-helper-build.log`);
  }
  const env = await goEnvironment();
  report.groups = await collectGroups(groups, group => runGroup(executable, env, group, quitHelper));
} catch (error) {
  report.failure = String(error.stack ?? error);
  report.groups = groups.map(group => ({ group, result: "not-run", reason: "Build or runner setup failed.", cases: [] }));
} finally {
  if (!preserve.size) {
    try { await rm(temporary, { recursive: true, force: true }); }
    catch (error) { report.cleanup = String(error); }
  } else report.preserved = [...preserve];
  await writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
}
if (report.failure) console.error(report.failure);
if (report.cleanup) console.error(report.cleanup);
for (const group of report.groups) {
  if (group.result !== "pass") console.error(`${group.result}: ${group.group}: ${group.failure ?? group.reason}`);
}
if (report.failure || report.cleanup || report.groups.some(group => group.result !== "pass")) process.exitCode = 1;

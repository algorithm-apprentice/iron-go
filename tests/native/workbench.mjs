import assert from "node:assert/strict";
import { execFileSync, fork, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectGroups, fixtureGroups, nativePlan, runtimeClean, summarizeGroup, validReport, validTerminal } from "./plan.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workerPath = fileURLToPath(new URL("./session.mjs", import.meta.url));
const quitSource = fileURLToPath(new URL("./request-quit.swift", import.meta.url));
const accessibilitySource = fileURLToPath(new URL("./accessibility.swift", import.meta.url));
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

function requireNotInterrupted() {
  if (interrupt) throw new Error(`Native acceptance interrupted (${interrupt}).`);
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
    requireNotInterrupted();
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

async function appCleanup(app, groupReport, directory, group, beforeCrash) {
  const alreadyExited = app.child.exitCode !== null || app.child.signalCode !== null;
  const failures = [];
  let observed = beforeCrash ?? [];
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
  const expectedCrash = expectedTerminal && groupReport?.terminal?.action === "crash with completed draft";
  if (expectedCrash && beforeCrash === undefined) failures.push("The runner did not capture app descendants before the deliberate crash.");
  const expectedExit = expectedCrash ? exit?.signal === "SIGKILL" : exit?.code === 0;
  if (!expectedExit || (!expectedTerminal && !shutdown.acknowledged)) failures.push("Native app teardown was not verified.");
  shutdown.nativeTerminal = expectedTerminal && expectedExit;
  shutdown.remaining = await remainingChildren(observed);
  if (shutdown.remaining.length) failures.push("Observed test-owned descendants remain after app shutdown.");
  await writeFile(path.join(directory, "cleanup.json"), JSON.stringify(shutdown, null, 2));
  const processEvidence = failures.length ? undefined : shutdown.nativeTerminal ?
    (expectedCrash ? "observed_crash" : "native_quit") : shutdown.acknowledged ? "supervised" : undefined;
  return { failure: failures.join(" ") || undefined, nativeTerminal: shutdown.nativeTerminal, processEvidence };
}

async function goEnvironment() {
  requireNotInterrupted();
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

async function prepareGoSourceDependency(fixture, fixtureRoot, env) {
  const module = "example.test/sourcefixture";
  const version = "v1.0.0";
  const staging = path.join(fixtureRoot, "source-dependency");
  const moduleDir = path.join(staging, `${module}@${version}`);
  const proxy = path.join(fixtureRoot, "source-proxy");
  const versions = path.join(proxy, module, "@v");
  const manifest = `module ${module}\n\ngo 1.22\n`;
  await Promise.all([mkdir(moduleDir, { recursive: true }), mkdir(versions, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(moduleDir, "go.mod"), manifest),
    writeFile(path.join(moduleDir, "source.go"), "package sourcefixture\n\nfunc FromCache() string { return \"local proxy fixture\" }\n"),
    writeFile(path.join(versions, `${version}.mod`), manifest),
    writeFile(path.join(versions, `${version}.info`), JSON.stringify({ Version: version, Time: "2024-01-01T00:00:00Z" })),
  ]);
  execFileSync("/usr/bin/zip", ["-q", path.join(versions, `${version}.zip`), `${module}@${version}/go.mod`, `${module}@${version}/source.go`], { cwd: staging, timeout: 10_000 });
  const downloaded = JSON.parse(execFileSync("go", ["mod", "download", "-json", `${module}@${version}`], {
    cwd: staging, encoding: "utf8", timeout: 15_000,
    env: { ...env, GOWORK: "off", GOFLAGS: "-modcacherw", GOPROXY: pathToFileURL(proxy).href, GONOPROXY: "none", GOSUMDB: "off" },
  }));
  const manifestPath = path.join(fixture, "go.mod");
  await writeFile(manifestPath, `${await readFile(manifestPath, "utf8")}\nrequire ${module} ${version}\n`);
  await writeFile(path.join(fixture, "go.sum"), `${module} ${version} ${downloaded.Sum}\n${module} ${version}/go.mod ${downloaded.GoModSum}\n`);
}

async function runGroup(executable, env, group, quitHelper, reopen = false, accessibilityHelper) {
  if (interrupt) return { group, result: "not-run", reason: `Interrupted by ${interrupt}.`, cases: [] };
  const phase = reopen === "after-quit" ? `${group}-after-quit` : reopen ? `${group}-reopen` : group;
  console.log(`  GROUP ${phase}`);
  const directory = path.join(artifacts, phase);
  const fixtureRoot = path.join(temporary, group);
  const volume = group === "trash" ? path.join(fixtureRoot, "volume") : undefined;
  const trashRoot = volume ? path.join(volume, ".Trashes", String(process.getuid())) : undefined;
  const fixture = path.join(volume ?? fixtureRoot, "workspace", values.project ? path.basename(path.resolve(values.project)) : "orbit");
  const home = path.join(fixtureRoot, "home");
  let app, peer, peerDirectory, worker, workerExit, groupReport, failure, cleanup, nativeTerminal, processEvidence, mounted = false;
  const beforeCrash = new Map();
  const diagnostics = [];
  try {
    await mkdir(directory);
    if (!reopen) {
      await mkdir(home, { recursive: true });
      if (volume) {
        const image = path.join(fixtureRoot, "trash-fixture.dmg");
        await mkdir(volume);
        execFileSync("/usr/bin/hdiutil", ["create", "-quiet", "-size", "64m", "-fs", "APFS", "-volname", "IronGoTrashFixture", "-o", image], { timeout: 30_000 });
        execFileSync("/usr/bin/hdiutil", ["attach", "-quiet", "-nobrowse", "-noautoopen", "-mountpoint", volume, image], { timeout: 30_000 });
        mounted = true;
        await mkdir(trashRoot, { recursive: true, mode: 0o700 });
      }
      await mkdir(path.dirname(fixture));
      if (values.project) {
        await mkdir(fixture);
        requireNotInterrupted();
        const snapshot = execFileSync("git", ["-C", path.resolve(values.project), "archive", "--format=tar", "HEAD"], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
        execFileSync("tar", ["-xf", "-", "-C", fixture], { input: snapshot, timeout: 60_000 });
      } else await cp(path.join(root, "tests/fixtures/orbit"), fixture, { recursive: true });
    }
    const groupEnv = { ...env };
    if (["files", "go", "debug", "terminal"].includes(group)) groupEnv.GOWORK = "auto";
    if (!values.project) {
      groupEnv.GOPATH = path.join(fixtureRoot, "gopath");
      groupEnv.GOTMPDIR = path.join(fixtureRoot, "go-tmp");
      if (!reopen) await Promise.all([mkdir(groupEnv.GOPATH), mkdir(groupEnv.GOTMPDIR)]);
      if (group === "go" && !reopen) {
        await prepareGoSourceDependency(fixture, fixtureRoot, groupEnv);
        Object.assign(groupEnv, { GOPROXY: "off", GONOPROXY: "none" });
      }
    }
    const available = await port();
    const appEnv = {
      ...groupEnv, HOME: home, CFFIXED_USER_HOME: home,
      IRON_GO_E2E_WORKSPACE: fixture, TAURI_WEBDRIVER_PORT: String(available),
      IRON_GO_E2E_TRASH_ROOT: trashRoot ?? "",
      IRON_GO_E2E_WATCH_STDIN: "1", IRON_GO_E2E_EXIT_TIMEOUT_MS: group === "quit" || group === "quit-save" ? "10000" : group === "recovery" ? "4000" : "",
    };
    app = await logged(executable, [], path.join(directory, "app.log"), appEnv, true);
    const config = { group, reopen, values, driver: `http://127.0.0.1:${available}`, artifacts: directory, fixture, home, pid: app.child.pid, quitHelper, trashRoot, accessibilityHelper };
    if (group === "recovery" && reopen === true) {
      peerDirectory = path.join(directory, "second-writer");
      await mkdir(peerDirectory);
      const peerPort = await port();
      peer = await logged(executable, [], path.join(peerDirectory, "app.log"), { ...appEnv, TAURI_WEBDRIVER_PORT: String(peerPort) }, true);
      config.peer = { pid: peer.child.pid, driver: `http://127.0.0.1:${peerPort}`, artifacts: peerDirectory };
    }
    requireNotInterrupted();
    worker = monitor(fork(workerPath, [JSON.stringify(config)], { cwd: root, execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"] }));
    worker.child.on("message", message => {
      if (message?.type !== "observe-before-crash" || group !== "recovery" || ![app.child.pid, peer?.child.pid].includes(message.pid)) return;
      try {
        beforeCrash.set(message.pid, descendants(message.pid));
        if (worker.child.connected) worker.child.send({ type: "crash-observed", pid: message.pid }, () => {});
      } catch (error) {
        if (worker.child.connected) worker.child.send({ type: "crash-observed", pid: message.pid, error: String(error) }, () => {});
      }
    });
    void app.exited.then(result => {
      if (worker.child.connected) worker.child.send({ type: "app-exit", result }, () => {});
    }, () => {});
    if (peer) void peer.exited.then(result => {
      if (worker.child.connected) worker.child.send({ type: "peer-exit", result }, () => {});
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
    if (peer) {
      const peerReport = await readFile(path.join(peerDirectory, "report.json"), "utf8").then(JSON.parse).catch(() => undefined);
      try {
        const result = await appCleanup(peer, peerReport, peerDirectory, "recovery", beforeCrash.get(peer.child.pid));
        if (result.failure) cleanup = `Secondary app: ${result.failure}`;
      } catch (error) {
        cleanup = `Could not verify the secondary recovery app's exit: ${error}`;
        peer.child.stdin?.end();
        await terminate(peer).catch(fallback => diagnostics.push(`Secondary app fallback: ${fallback}`));
      }
    }
    if (app) {
      try {
        const result = await appCleanup(app, groupReport, directory, group, beforeCrash.get(app.child.pid));
        nativeTerminal = result.nativeTerminal;
        processEvidence = result.processEvidence;
        cleanup = [cleanup, result.failure].filter(Boolean).join(" ") || undefined;
      }
      catch (error) {
        cleanup = `Could not verify native app cleanup: ${error}`;
        app.child.stdin?.end();
        await terminate(app).catch(fallback => diagnostics.push(`App fallback: ${fallback}`));
      }
    }
    const pendingRun = await readFile(path.join(directory, "pending-run-directory.txt"), "utf8").catch(() => undefined);
    if (pendingRun && await access(pendingRun).then(() => true, error => error.code !== "ENOENT")) {
      cleanup = [cleanup, `Executable directory survived app exit: ${pendingRun}`].filter(Boolean).join(" ");
    }
    if (mounted) {
      try { execFileSync("/usr/bin/hdiutil", ["detach", "-quiet", volume], { timeout: 30_000 }); }
      catch (error) { cleanup = [cleanup, `Could not detach the disposable Trash volume: ${error}`].filter(Boolean).join(" "); }
    }
    if (cleanup || (worker && !workerExit)) {
      preserve.add(fixtureRoot);
      diagnostics.push(`Preserved disposable paths: ${fixtureRoot}`);
    } else if (!["go", "recovery", "recent"].includes(group) || (group !== "recovery" && reopen) || reopen === "after-quit") {
      try { await rm(fixtureRoot, { recursive: true, force: true }); }
      catch (error) { cleanup = `Could not remove disposable group: ${error}`; preserve.add(fixtureRoot); }
    }
  }
  return summarizeGroup(group, { worker: workerExit, report: groupReport, failure, cleanup, nativeTerminal, processEvidence, diagnostics,
    reopen, requireGopls: values["require-gopls"] });
}

try {
  const target = path.resolve(root, process.env.CARGO_TARGET_DIR ?? "src-tauri/target");
  const executable = path.join(target, "debug/iron-go-acceptance");
  if (!values["skip-build"]) {
    const build = await logged("npm", ["run", "tauri", "build", "--", "--debug", "--no-bundle", "--features", "e2e", "--config", "src-tauri/tauri.e2e.conf.json"], path.join(artifacts, "build.log"), {
      ...process.env, CARGO_TARGET_DIR: target, VITE_IRON_E2E: "1",
    });
    // Let an admitted build finish on interrupt. Signaling its launcher can
    // leave Cargo descendants running after the launcher itself exits.
    const result = await bounded(build.exited, 10 * 60_000);
    if (result === undefined) await terminate(build);
    if (interrupt) throw new Error(`Native acceptance interrupted after the build (${interrupt}).`);
    assert.equal(result?.code, 0, `Native build failed; see ${artifacts}/build.log`);
  }
  await access(executable, constants.X_OK);
  let quitHelper;
  let accessibilityHelper;
  if (groups.some(group => ["lifecycle", "quit", "quit-save"].includes(group))) {
    quitHelper = path.join(temporary, "request-quit");
    const compiler = await logged("swiftc", [quitSource, "-o", quitHelper], path.join(artifacts, "quit-helper-build.log"), process.env);
    const result = await bounded(compiler.exited, 120_000);
    if (result === undefined) await terminate(compiler);
    if (interrupt) throw new Error(`Native acceptance interrupted after building the Quit helper (${interrupt}).`);
    assert.equal(result?.code, 0, `Native Quit helper build failed; see ${artifacts}/quit-helper-build.log`);
  }
  if (groups.includes("accessibility")) {
    accessibilityHelper = path.join(temporary, "accessibility-driver");
    execFileSync("swiftc", [accessibilitySource, "-o", accessibilityHelper], { timeout: 60_000 });
  }
  const env = await goEnvironment();
  report.groups = await collectGroups(groups, async group => {
    const initial = await runGroup(executable, env, group, quitHelper, false, accessibilityHelper);
    if (!["go", "recovery", "recent"].includes(group) || initial.result !== "pass") return initial;
    const reopened = await runGroup(executable, env, group, quitHelper, true);
    if (group === "recovery" && reopened.result === "pass") {
      const afterQuit = await runGroup(executable, env, group, quitHelper, "after-quit");
      return { ...afterQuit, cases: [...initial.cases, ...reopened.cases, ...afterQuit.cases] };
    }
    return { ...reopened, cases: [...initial.cases, ...reopened.cases] };
  });
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

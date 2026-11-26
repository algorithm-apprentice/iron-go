import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({ options: { "skip-build": { type: "boolean" }, "require-gopls": { type: "boolean" } } });
if (process.platform !== "darwin") throw new Error("Native acceptance requires macOS.");
const artifacts = path.join(root, "test-results/native", `${Date.now()}-${process.pid}`);
await mkdir(artifacts, { recursive: true });
console.log(`Native acceptance artifacts: ${path.relative(root, artifacts)}`);
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "iron-go-acceptance-")));
const fixture = path.join(temporary, "orbit");
const home = path.join(temporary, "home");
const report = { cases: [] };
let app, driver, sid;

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

async function eventually(label, read, predicate = Boolean, timeout = 15_000) {
  const end = Date.now() + timeout;
  let last;
  do {
    try { last = await read(); if (predicate(last)) return last; }
    catch (error) { last = String(error); }
    await delay(80);
  } while (Date.now() < end);
  throw new Error(`${label}: condition did not become true. Last value: ${JSON.stringify(last)?.slice(0, 1000)}`);
}

async function w3c(endpoint, input, method = input ? "POST" : "GET") {
  const reply = await fetch(`${driver}${endpoint}`, {
    method, signal: AbortSignal.timeout(6000),
    ...(input ? { headers: { "content-type": "application/json" }, body: JSON.stringify(input) } : {}),
  });
  const { value } = await reply.json();
  if (!reply.ok) throw new Error(`${endpoint}: ${value?.message ?? reply.status}`);
  return value;
}

const js = (script, ...args) => w3c(`/session/${sid}/execute/sync`, { script, args });
const click = selector => js("const el = document.querySelector(arguments[0]); if (!el || el.disabled) return false; el.click(); return true;", selector)
  .then(clicked => assert.equal(clicked, true, `Click ${selector}`));
const text = selector => js("return document.querySelector(arguments[0])?.textContent ?? '';", selector);
const set = (selector, value) => js("const el = document.querySelector(arguments[0]); el.value = arguments[1]; el.dispatchEvent(new Event('input', { bubbles: true })); return true;", selector, value);
const current = () => js("return window.__ironTest.snapshot();");
const replace = content => js("return window.__ironTest.replace(arguments[0]);", content);
const output = () => text("#output-log");

async function record(name, run) {
  const started = Date.now();
  try {
    await run();
    report.cases.push({ name, result: "pass", ms: Date.now() - started });
    console.log(`  PASS ${name}`);
  } catch (error) {
    report.cases.push({ name, result: "fail", error: error.stack, ms: Date.now() - started });
    throw error;
  }
}

async function processLogged(executable, args, logfile, env) {
  const log = await open(path.join(artifacts, logfile), "w");
  try {
    const child = spawn(executable, args, { cwd: root, env, stdio: ["ignore", log.fd, log.fd] });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    exited.catch(() => {});
    return { child, exited };
  } finally { await log.close(); }
}

try {
  await cp(path.join(root, "tests/fixtures/orbit"), fixture, { recursive: true });
  await mkdir(home);
  const goTestEnv = { ...process.env, GOTOOLCHAIN: "local", GOENV: "off", GOWORK: "off", GOFLAGS: "" };
  const configuredGoBin = execFileSync("go", ["env", "GOBIN", "GOPATH"], { encoding: "utf8" }).trimEnd().split("\n");
  const searchPath = [process.env.PATH, configuredGoBin[0], ...((configuredGoBin[1] ?? "").split(":").filter(Boolean).map(dir => path.join(dir, "bin"))), path.join(homedir(), "go/bin")].filter(Boolean).join(":");

  const target = path.resolve(root, process.env.CARGO_TARGET_DIR ?? "src-tauri/target");
  const executable = path.join(target, "debug/iron-go-acceptance");
  if (!values["skip-build"]) {
    const build = await processLogged("npm", ["run", "tauri", "build", "--", "--debug", "--no-bundle", "--features", "e2e", "--config", "src-tauri/tauri.e2e.conf.json"], "build.log", {
      ...process.env, CARGO_TARGET_DIR: target, VITE_IRON_E2E: "1",
    });
    const result = await build.exited;
    assert.equal(result.code, 0, `Native build failed; see ${artifacts}/build.log`);
  }

  const available = await port();
  driver = `http://127.0.0.1:${available}`;
  app = await processLogged(executable, [], "app.log", {
    ...goTestEnv, PATH: searchPath, HOME: home, CFFIXED_USER_HOME: home,
    IRON_GO_E2E_WORKSPACE: fixture, TAURI_WEBDRIVER_PORT: String(available),
  });
  await eventually("embedded macOS WebDriver", () => w3c("/status"), value => value?.ready);
  ({ sessionId: sid } = await w3c("/session", { capabilities: { alwaysMatch: {} } }));

  const source = path.join(fixture, "cmd/orbit/main.go");
  const original = await readFile(source, "utf8");
  const checkTheme = () => record("native theme switches both the editor and workbench", async () => {
    await eventually("workbench boot", () => js("return !!window.__ironTest && document.body.classList.contains('desktop');"));
    await click("#settings");
    const selectTheme = value => js(`
      const select = document.querySelector('#theme-setting');
      if (!select) return 'Color Theme selector missing';
      let error = null;
      const onError = event => { error = [event.message, event.error?.stack].filter(Boolean).join("\\n"); };
      window.addEventListener('error', onError);
      try {
        select.value = arguments[0];
        select.dispatchEvent(new Event('change'));
        return error;
      } finally { window.removeEventListener('error', onError); }
    `, value);
    const colors = () => js("return ['.monaco-editor-background', '.sidebar', '.bottom-panel'].map(selector => getComputedStyle(document.querySelector(selector)).backgroundColor);");
    assert.equal(await selectTheme("light"), null);
    await eventually("native VS Code Light colors", colors, value => value?.join("/") === "rgb(255, 255, 255)/rgb(250, 250, 253)/rgb(250, 250, 253)");
    assert.equal(await selectTheme("dark"), null);
    await eventually("native VS Code Dark colors", colors, value => value?.join("/") === "rgb(18, 19, 20)/rgb(25, 26, 27)/rgb(25, 26, 27)");
    await click('[data-dialog-close="settings-dialog"]');
  });
  await record("native welcome does not open or offer a bundled project", async () => {
    await eventually("workbench boot", () => js("return !!window.__ironTest && document.body.classList.contains('desktop');"));
    await eventually("project welcome", () => js("return document.querySelector('#project-welcome')?.hidden === false;"), Boolean, 5000);
    assert.equal((await current()).path ?? null, null);
    assert.equal((await current()).root ?? null, null);
    assert.equal(await js("return document.querySelector('#run').disabled;"), true);
    assert.equal(await js("return document.querySelector('.titlebar').getBoundingClientRect().height;"), 36);
    assert.doesNotMatch(await text("#project-welcome"), /orbit/i);
    assert.match(await text("#project-welcome"), /Open Project/);
    assert.match(await text("#project-welcome"), /New Project/);
  });
  await record("native workbench opens a disposable folder", async () => {
    await eventually("workbench boot", () => js("return !!window.__ironTest && document.body.classList.contains('desktop');"));
    await click("#open-folder");
    const state = await eventually("native folder and Monaco file", current, state => state?.path === "cmd/orbit/main.go" && state?.root === fixture);
    assert.equal(state.text, original);
    assert.equal(await text("#module-name"), "example.com/orbit");
    await eventually("Go toolchain reported", () => text("#tool-version"), value => /go?\s*\d+\.\d+/i.test(value));
    await eventually("sole executable selected without typing", () => js("return document.querySelector('#run-target')?.value;"), value => value === "./cmd/orbit", 5000);
  });
  await checkTheme();

  await record("formats only the buffer, then saves actual disk bytes", async () => {
    const ugly = original.replace("const version =", "const     version=     ") + "\n// Native acceptance\n";
    await replace(ugly);
    assert.equal((await current()).dirty, true);
    await click("#format");
    const formatted = await eventually("gofmt result", current, state => state?.text.includes("const version =") && state?.text.includes("Native acceptance"));
    assert.equal(await readFile(source, "utf8"), original, "format must not write to disk");
    await click("#save");
    await eventually("real disk write", () => readFile(source, "utf8"), value => value === formatted.text);
    await eventually("tab clean after save", current, state => !state.dirty);
  });

  await record("protects externally edited files from overwrite", async () => {
    const saved = await readFile(source, "utf8");
    const external = saved + "\n// External change\n";
    await writeFile(source, external);
    await replace(saved + "\n// Unsaved buffer\n");
    await click("#save");
    await eventually("save conflict message", () => text("#toast"), value => value.includes("changed on disk"));
    assert.equal(await readFile(source, "utf8"), external);
    await writeFile(source, saved);
    await replace(saved);
  });

  await record("builds, runs, and tests the actual Go module", async () => {
    await click('[data-view="tasks"]');
    await click('[data-task="build"]');
    await eventually("Go build", output, value => /go build \.\/\.\.\.[\s\S]*exit code 0/i.test(value), 30_000);
    await click("#run");
    await eventually("Orbit prints its service report", output, value => /orbit v0\.1\.0 is online[\s\S]*exit code 0/i.test(value), 30_000);
    await click('[data-task="test"]');
    await eventually("real go test output", output, value => /PASS: TestSummary[\s\S]*exit code 0/i.test(value), 45_000);
  });

  await record("chooses between two actual Go targets and stops the inferior", async () => {
    await mkdir(path.join(fixture, "cmd/wait"));
    await writeFile(path.join(fixture, "cmd/wait/entry.go"), 'package main\nimport ("fmt"; "os"; "time")\nfunc main(){fmt.Printf("agent-ready %d\\n", os.Getpid()); time.Sleep(time.Minute)}\n');
    await click("#open-folder");
    await eventually("both discovered targets", () => js("return Array.from(document.querySelector('#run-target').options).map(option => option.value);"), values => values?.includes("./cmd/orbit") && values?.includes("./cmd/wait"));
    await eventually("workspace ready", () => js("return !document.querySelector('#run').disabled;"));
    assert.equal(await js("return document.querySelector('#run-target').value;"), "");
    await click("#run");
    await eventually("run requires an explicit selection", () => text("#toast"), value => /choose a run target/i.test(value));
    await js("const select = document.querySelector('#run-target'); select.value = './cmd/wait'; select.dispatchEvent(new Event('change')); return true;");
    await click("#run");
    const ready = await eventually("long-running Go program", output, value => /agent-ready \d+/.test(value), 30_000);
    const pid = Number(ready.match(/agent-ready (\d+)/)[1]);
    await click("#panel-stop");
    await eventually("task cancellation", output, value => /task stopped/i.test(value));
    await eventually("Go inferior exited", () => {
      try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
    });
  });

  const languageServer = await js("return window.__ironTest.snapshot().gopls;");
  if (languageServer === "missing" && !values["require-gopls"]) {
    console.log("  SKIP gopls diagnostics/completion (gopls not installed)");
    report.cases.push({ name: "gopls diagnostics/completion", result: "skip", reason: "gopls not installed" });
  } else {
    await record("gopls publishes/clears real errors and completes a Go symbol", async () => {
      await eventually("gopls ready", current, state => state?.gopls === "ready", 30_000);
      const clean = (await current()).text;
      await replace(clean + "\nvar _ = ironGoUndefinedSymbol\n");
      await eventually("undefined-symbol diagnostic", current, state => state?.markers.some(marker => marker.message.includes("ironGoUndefinedSymbol")), 30_000);
      await replace(clean);
      await eventually("diagnostic clears", current, state => state?.markers.every(marker => !marker.message.includes("ironGoUndefinedSymbol")), 30_000);
      const partial = clean.replace("status.NewReport", "status.NewRep");
      const lines = partial.split("\n");
      const index = lines.findIndex(line => line.includes("status.NewRep"));
      await replace(partial);
      await js("return window.__ironTest.suggest(arguments[0], arguments[1]);", index + 1, lines[index].indexOf("NewRep") + "NewRep".length + 1);
      await eventually("NewReport suggestion", () => js("return Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')).map(row => row.textContent);"), items => items?.some(item => item.includes("NewReport")), 20_000);
      await replace(clean);
    });
    await record("gopls hover and definition work through Monaco", async () => {
      const source = (await current()).text.split("\n");
      const line = source.findIndex(value => value.includes("status.NewReport"));
      const column = source[line].indexOf("NewReport") + 3;
      const action = id => js("return window.__ironTest.action(arguments[0], arguments[1], arguments[2]);", id, line + 1, column);
      await action("editor.action.showHover");
      await eventually("gopls hover signature", () => text(".monaco-hover"), value => /NewReport/.test(value), 20_000);
      await action("editor.action.revealDefinition");
      const result = await eventually("definition opened in workspace", current, state => state?.path === "internal/status/report.go", 20_000);
      assert.match(result.text, /func NewReport\(/);
    });
    await record("runs exactly one Go test from its editor action", async () => {
      const file = path.join(fixture, "internal/status/report_test.go");
      await writeFile(file, (await readFile(file, "utf8")) + "\nfunc TestAnother(t *testing.T) {}\n");
      await click("#quick-open");
      await set("#palette-text", "report_test.go");
      await click("#palette-options button");
      await eventually("test file is active", current, state => state?.path === "internal/status/report_test.go");
      await eventually("the two CodeLens actions", () => js("return document.querySelectorAll('.codelens-decoration a').length;"), count => count === 2);
      assert.equal(await js(`
        const action = document.querySelector('.codelens-decoration a');
        if (!action) return false;
        const bounds = action.getBoundingClientRect();
        // Monaco's CodeLens executes on pointer down, not HTMLElement.click().
        action.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true, cancelable: true, view: window, button: 0, buttons: 1,
          clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2,
        }));
        return true;
      `), true);
      const result = await eventually("test completed from CodeLens", output, value => /PASS: TestSummary[\s\S]*exit code 0/.test(value));
      assert.doesNotMatch(result, /PASS: TestAnother/);
    });
  }
  await record("closing a project returns to welcome", async () => {
    await click("#workspace-actions");
    await set("#palette-text", "close project");
    await click("#palette-options button");
    await eventually("back at welcome", () => js("return document.querySelector('#project-welcome').hidden === false;"));
    assert.equal((await current()).root ?? null, null);
    assert.equal(await js("return document.querySelector('#run').disabled;"), true);
  });
} catch (error) {
  report.failure = error.stack;
  if (sid) {
    try {
      const screenshot = await w3c(`/session/${sid}/screenshot`);
      await writeFile(path.join(artifacts, "workbench.png"), Buffer.from(screenshot, "base64"));
    } catch { /* The WebView may not be available. */ }
    try {
      await writeFile(path.join(artifacts, "workbench.json"), JSON.stringify({ state: await current(), output: await output(), status: await text("#status"), toast: await text("#toast") }, null, 2));
    } catch { /* The backend/build logs remain available. */ }
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  if (sid) await js("window.__ironTest?.quit(); return true;").catch(() => {});
  if (sid) await w3c(`/session/${sid}`, undefined, "DELETE").catch(() => {});
  if (app) {
    await Promise.race([app.exited.catch(() => {}), delay(1000, undefined, { ref: false })]);
    if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill("SIGTERM");
    const exited = await Promise.race([app.exited.then(() => true, () => true), delay(1200, false, { ref: false })]);
    if (!exited) { app.child.kill("SIGKILL"); await app.exited.catch(() => {}); }
  }
  await rm(temporary, { recursive: true, force: true });
  await writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
}

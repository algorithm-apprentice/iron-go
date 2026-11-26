import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({ options: {
  "skip-build": { type: "boolean" }, "require-gopls": { type: "boolean" },
  "require-delve": { type: "boolean" },
  "trace-editor": { type: "boolean" },
  project: { type: "string" }, "test-file": { type: "string" }, "debug-test": { type: "string" },
} });
if (process.platform !== "darwin") throw new Error("Native acceptance requires macOS.");
if (values["debug-test"] && (!values.project || !values["test-file"])) throw new Error("--debug-test requires --project and --test-file.");
const artifacts = path.join(root, "test-results/native", `${Date.now()}-${process.pid}`);
await mkdir(artifacts, { recursive: true });
console.log(`Native acceptance artifacts: ${path.relative(root, artifacts)}`);
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "iron-go-acceptance-")));
const fixture = path.join(temporary, values.project ? path.basename(path.resolve(values.project)) : "orbit");
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

async function chooseCommand(command) {
  await click("#quick-open");
  await set("#palette-text", `>${command}`);
  await click("#palette-options button");
}

async function assertLineAlignment() {
  const { text: source } = await current();
  const lines = source.split(/\r?\n/);
  const interesting = lines.flatMap((line, index) => /^\s*func\s+(Test\w+|\w+)\(/.test(line) ? [index + 1] : []);
  const targets = [...new Set([interesting[0] ?? 1, interesting[Math.floor(interesting.length / 2)] ?? 1, interesting.at(-1) ?? lines.length])];
  for (const number of targets) {
    await js("window.__ironTest.revealLine(arguments[0]); window.__ironTest.refreshView(); return true;", number);
    const sample = await eventually(`line ${number} is rendered`, () => js(`
      const number = String(arguments[0]);
      const source = arguments[1];
      const clean = text => text.replace(/\\s+/g,' ').trim();
      const gutter = [...document.querySelectorAll('#editor .line-numbers')].find(row => row.textContent.trim() === number);
      const rows = [...document.querySelectorAll('#editor .view-lines .view-line')];
      const active = document.querySelector('#editor .view-overlays .current-line');
      if (!gutter || !active) return null;
      const top = node => node.getBoundingClientRect().top;
      const expected = clean(source);
      const row = rows.find(node => {
        const rendered = clean(node.textContent);
        return rendered === expected || (rendered.length > 10 && expected.startsWith(rendered));
      });
      if (!row) return null;
      return { gutter: top(gutter), body: top(row), active: top(active), number: gutter.textContent, code: row.textContent };
    `, number, lines[number - 1]), Boolean, 5000);
    assert.ok(Math.abs(sample.gutter - sample.body) <= 1,
      `line ${number} gutter and body: ${JSON.stringify(sample)}`);
    assert.ok(Math.abs(sample.active - sample.body) <= 1,
      `line ${number} active highlight and body: ${JSON.stringify(sample)}`);
  }
}

async function clickCodeLens(title) {
  await eventually(`${title} CodeLens`, () => js("return [...document.querySelectorAll('.codelens-decoration a')].some(a => a.title === arguments[0]);", title));
  assert.equal(await js(`
    const action = [...document.querySelectorAll('.codelens-decoration a')].find(a => a.title === arguments[0]);
    if (!action) return false;
    const r = action.getBoundingClientRect();
    action.dispatchEvent(new MouseEvent('mousedown', {bubbles:true,cancelable:true,view:window,button:0,buttons:1,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));
    return true;
  `, title), true);
}

async function placeBreakpoint(line) {
  await eventually("Monaco layout matches the visible editor after panel and tab changes", () => js(`
    const element = document.querySelector('#editor');
    const editor = window.__ironTest.snapshot().editor;
    return { matches: !!editor && editor.width === element.clientWidth && editor.height === element.clientHeight, layout: editor, box: [element.clientWidth, element.clientHeight] };
  `), result => result?.matches);
  const key = await js(`
    const visibleBefore = document.querySelectorAll('.view-line').length;
    window.__ironTest.revealLine(arguments[0]);
    const visibleAfterReveal = document.querySelectorAll('.view-line').length;
    const press = new KeyboardEvent('keydown', {key:'F9', bubbles:true,cancelable:true});
    document.dispatchEvent(press);
    const rect = document.querySelector('#editor').getBoundingClientRect();
    return { prevented: press.defaultPrevented, dialog: document.querySelector('dialog[open]')?.id, top:rect.top, height:rect.height, visibleBefore, visibleAfterReveal, visible:document.querySelectorAll('.view-line').length, side:document.querySelectorAll('.line-numbers').length, cursor:document.querySelector('#cursor').textContent };
  `, line);
  assert.equal(key.prevented, true, `F9 should be handled while editing a Go file: ${JSON.stringify(key)}`);
  await eventually(`pending breakpoint in the editor gutter (${JSON.stringify(key)})`, () => js(`
    if (document.querySelector('#editor .debug-breakpoint')) return true;
    return { scroll: window.scrollY, viewport: window.innerHeight, editor: document.querySelector('#editor').getBoundingClientRect().toJSON(), visible:document.querySelectorAll('.view-line').length, gutters:document.querySelectorAll('.line-numbers').length, cursor:document.querySelector('#cursor').textContent };
  `), value => value === true);
}

async function record(name, run) {
  const started = Date.now();
  try {
    await run();
    const entry = { name, result: "pass", ms: Date.now() - started };
    if (values["trace-editor"] && sid) {
      entry.editor = await js(`
        const editor = window.__ironTest?.snapshot();
        return { path: editor?.path, layout: editor?.editor, visibility: document.visibilityState,
          rows: document.querySelectorAll('.view-line').length, numbers: document.querySelectorAll('.line-numbers').length,
          lenses: document.querySelectorAll('.codelens-decoration').length, panel: !document.querySelector('#panel').hidden };
      `).catch(error => ({ error: String(error) }));
    }
    report.cases.push(entry);
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

async function externalProjectSmoke() {
  const module = (await readFile(path.join(fixture, "go.mod"), "utf8")).match(/^module\s+(\S+)/m)?.[1];
  assert.ok(module, "The project smoke expects a root go.mod");
  await record(`opens the committed ${module} snapshot as a real Go project`, async () => {
    await eventually("workbench ready", () => js("return !!window.__ironTest && document.querySelector('#project-welcome')?.hidden === false;"));
    await click("#open-folder");
    await eventually("external module editor", current, state => state?.root === fixture && state.path?.endsWith(".go"), 30_000);
    assert.equal(await text("#module-name"), module);
  });
  await record("discovers Go package metadata for the external project", async () => {
    await eventually("Go package metadata", () => text("#run-target-status"), value => /Run target:|Choose a run target|No executable Go package found/.test(value), 30_000);
  });
  await record("runs the actual project tests from Iron Go", async () => {
    await click('[data-view="tasks"]');
    await click('[data-task="test"]');
    const finished = await eventually("Go tests complete", output, value => /exit code \d+/i.test(value), 180_000);
    assert.match(finished, /exit code 0/i);
    await writeFile(path.join(artifacts, "go-test-output.log"), finished);
  });
  if (values["test-file"]) {
    await record("opens a real test file with gopls test actions", async () => {
      await eventually("gopls ready", current, state => state?.gopls === "ready", 30_000);
      await click("#quick-open");
      await set("#palette-text", values["test-file"]);
      await click("#palette-options button");
      await eventually("requested test file active", current, state => state?.path === values["test-file"]);
      await eventually("editor test actions available", () => js("return document.querySelectorAll('.codelens-decoration a').length;"), count => count > 0, 30_000);
    });
    await record("gutter, Go rows and active highlight align through scrolling and CodeLens", assertLineAlignment);
    await record("editor lines remain aligned after resizing and enabling wrapping", async () => {
      await js("void window.__ironTest.resize(760, 600); return true;");
      await eventually("narrow native window", () => js("return window.innerWidth;"), width => width === 760);
      await click("#settings");
      await click("#wrap-setting");
      await click('[data-dialog-close="settings-dialog"]');
      await assertLineAlignment();
    });
    if (values["debug-test"]) {
      await record(`Delve hits a real ${values["debug-test"]} breakpoint in this project`, async () => {
        const { text: source } = await current();
        const lines = source.split(/\r?\n/);
        const header = lines.findIndex(line => line.startsWith(`func ${values["debug-test"]}(`));
        assert.ok(header >= 0, "The named Go test must exist in the requested file");
        const firstStatement = lines.findIndex((line, index) => index > header && line.trim() && !line.trim().startsWith("//"));
        assert.ok(firstStatement > header);
        const place = `${path.basename(values["test-file"])}:${firstStatement + 1}`;
        await placeBreakpoint(firstStatement + 1);
        await clickCodeLens(`Debug ${values["debug-test"]}`);
        await eventually(`breakpoint at ${place}`, () => text("#status"), value => value.includes("Breakpoint hit") && value.includes(place), 90_000);
        await click("#debug-continue");
        await eventually("project test debugger finishes", () => text("#status"), value => /Debug session finished/i.test(value), 30_000);
      });
    }
  }
}

try {
  if (values.project) {
    await mkdir(fixture);
    const snapshot = execFileSync("git", ["-C", path.resolve(values.project), "archive", "--format=tar", "HEAD"], { maxBuffer: 64 * 1024 * 1024 });
    execFileSync("tar", ["-xf", "-", "-C", fixture], { input: snapshot });
  } else {
    await cp(path.join(root, "tests/fixtures/orbit"), fixture, { recursive: true });
  }
  await mkdir(home);
  const toolchain = values.project ? process.env.GOTOOLCHAIN || "auto" : "local";
  const goTestEnv = { ...process.env, GOTOOLCHAIN: toolchain, GOENV: "off", GOWORK: "off", GOFLAGS: "" };
  if (values.project) {
    const cache = execFileSync("go", ["env", "GOMODCACHE", "GOCACHE"], { encoding: "utf8", env: { ...goTestEnv, GOTOOLCHAIN: "local" } }).trimEnd().split("\n");
    [goTestEnv.GOMODCACHE, goTestEnv.GOCACHE] = cache;
  }
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
  await eventually("workbench test adapter", () => js("return !!window.__ironTest;"));

  if (values.project) await externalProjectSmoke();
  else await standardWorkbenchSmoke();
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

async function standardWorkbenchSmoke() {
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
  await record("native chrome suppresses browser-only keys, not editor keys", async () => {
    const result = await js(`
      const keys = [
        {key:'r',metaKey:true}, {key:'R',metaKey:true,shiftKey:true}, {key:'F5'},
        {key:'l',metaKey:true}, {key:'=',metaKey:true}, {key:'-',metaKey:true}, {key:'0',metaKey:true},
        {key:'f',metaKey:true}, {key:'[',metaKey:true}, {key:'c',metaKey:true}, {key:'ArrowLeft',altKey:true},
      ];
      return keys.map(options => {
        const event = new KeyboardEvent('keydown', {...options,bubbles:true,cancelable:true});
        document.dispatchEvent(event); return event.defaultPrevented;
      });
    `);
    assert.deepEqual(result, [true, true, true, true, true, true, true, false, false, false, false]);
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
    await js("window.__ironTest.action('undo', 1, 1); return true;");
    await eventually("format can be undone", current, state => state?.text === ugly);
    await click("#format");
    await eventually("format reapplied", current, state => state?.text === formatted.text);
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
    // The test controls the confirmation answer, not the reload or its disk I/O.
    await js("window.__realConfirm = window.confirm; window.confirm = () => false; return true;");
    try {
      await chooseCommand("reload file from disk");
      assert.match((await current()).text, /Unsaved buffer/);
      await js("window.confirm = () => true; return true;");
      await chooseCommand("reload file from disk");
      await eventually("confirmed reload reads the real disk", current, state => state?.text === external && !state.dirty);
    } finally { await js("window.confirm = window.__realConfirm; delete window.__realConfirm; return true;"); }
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
      await eventually("the two Run Test actions", () => js("return Array.from(document.querySelectorAll('.codelens-decoration a')).filter(action => action.textContent.trim() === 'Run Test').length;"), count => count === 2);
      assert.equal(await js(`
        const action = Array.from(document.querySelectorAll('.codelens-decoration a')).find(node => node.textContent.trim() === 'Run Test');
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
    if (values["require-delve"]) {
      await record("Delve pauses at a real editor breakpoint and continues the test", async () => {
        await placeBreakpoint(9);
        await clickCodeLens("Debug TestSummary");
        await eventually("debuggee stops on line 9", () => text("#status"), value => /Breakpoint hit.*report_test\.go:9/.test(value), 60_000);
        await click("#debug-next");
        await eventually("stepped to the next source line", () => text("#status"), value => /Paused.*report_test\.go:(10|11)/.test(value), 15_000);
        await click("#debug-continue");
        await eventually("debug test finished", () => text("#status"), value => /Debug session finished/i.test(value), 15_000);
      });
    }
  }
  await record("cancelling a dirty close preserves the buffer, accepting returns to welcome", async () => {
    const unsaved = (await current()).text + "\n// unsaved close acceptance\n";
    await replace(unsaved);
    const active = await current();
    assert.equal(active.dirty, true);
    await js("window.__realConfirm = window.confirm; window.confirm = () => false; return true;");
    try {
      await chooseCommand("close project");
      const state = await current();
      assert.equal(state.root, fixture);
      assert.equal(state.text, unsaved);
      assert.equal(state.dirty, true);
      await js("window.confirm = () => true; return true;");
      await chooseCommand("close project");
      await eventually("back at welcome", () => js("return document.querySelector('#project-welcome').hidden === false;"));
      assert.equal((await current()).root ?? null, null);
      assert.equal(await js("return document.querySelector('#run').disabled;"), true);
      assert.doesNotMatch(await readFile(path.join(fixture, active.path), "utf8"), /unsaved close acceptance/);
    } finally { await js("window.confirm = window.__realConfirm; delete window.__realConfirm; return true;"); }
  });
  await record("a project without an executable offers Test as its primary action", async () => {
    await rename(path.join(fixture, "cmd"), path.join(fixture, ".hidden-cmd"));
    await click("#open-folder");
    await eventually("library Test toolbar action", () => text("#run"), value => value.trim() === "Test", 5000);
    await click("#run");
    await eventually("library tests run from the toolbar", output, value => /PASS: TestSummary[\s\S]*exit code 0/.test(value), 60_000);
  });
  await record("New Project creates and opens a real Go module", async () => {
    await chooseCommand("close project");
    await eventually("welcome before creating a project", () => js("return document.querySelector('#project-welcome').hidden === false;"));
    await click("#welcome-new");
    await set("#form-name", "fresh-go");
    await set("#form-module", "example.com/fresh-go");
    await click("#form-submit");
    const newRoot = path.join(temporary, "fresh-go");
    await eventually("created Go module opens in Monaco", current, state => state?.root === newRoot && state?.path === "main.go", 8000);
    assert.match(await readFile(path.join(newRoot, "go.mod"), "utf8"), /^module example\.com\/fresh-go\n/);
    assert.match(await readFile(path.join(newRoot, "main.go"), "utf8"), /func main\(\)/);
    await eventually("new main package selected", () => js("return document.querySelector('#run-target').value === '.' && !document.querySelector('#run').disabled;"));
    await click("#run");
    await eventually("new project executes", output, value => /Hello from Iron Go![\s\S]*exit code 0/.test(value));
  });
}

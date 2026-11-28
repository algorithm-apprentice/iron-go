import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runtimeClean } from "./plan.mjs";

import { terminalSuite } from "./suites/terminal.mjs";
import { recoverySuite } from "./suites/recovery.mjs";
import { nativeSaveQuit, nativeQuitSmoke } from "./suites/quit.mjs";
import { debugSuite } from "./suites/debug.mjs";
import { goSuite, reopenGoSuite } from "./suites/go.mjs";
import { fileSuite } from "./suites/files.mjs";
import { lifecycleSuite } from "./suites/lifecycle.mjs";
import { recentSuite } from "./suites/recent.mjs";
import { trashSuite } from "./suites/trash.mjs";
import { accessibilitySuite } from "./suites/accessibility.mjs";

if (!process.send) throw new Error("Run native acceptance through workbench.mjs.");
const { group, reopen, values, driver, artifacts, fixture, home, pid, quitHelper, trashRoot, accessibilityHelper, peer } = JSON.parse(process.argv[2]);
const report = { version: 1, group, cases: [] };
const app = { child: { pid }, exited: new Promise(resolve => {
  process.on("message", message => { if (message?.type === "app-exit") resolve(message.result); });
}) };
const peerExited = peer && new Promise(resolve => {
  process.on("message", message => { if (message?.type === "peer-exit") resolve(message.result); });
});
let sid;
let finishing = false;
process.on("disconnect", () => { if (!finishing) process.exit(1); });

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

async function w3c(endpoint, input, method = input ? "POST" : "GET", base = driver) {
  const reply = await fetch(`${base}${endpoint}`, {
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

async function openProjectControl(expected) {
  const visible = await js(`return ['#welcome-open', '#open-folder'].filter(selector => {
    const box = document.querySelector(selector).getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });`);
  assert.equal(visible.length, 1, "exactly one Open Project control is visible");
  if (expected) assert.equal(visible[0], expected);
  await click(visible[0]);
}

async function refreshThroughProjectActions() {
  await click('[data-view="explorer"]');
  await click("#workspace-actions");
  await set("#palette-text", "refresh project");
  await eventually("project menu exposes Refresh Project", () => text("#palette-options"), value => value.includes("Refresh Project"));
  await click("#palette-options button");
}

async function prepareKeyboardCommand(command) {
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', metaKey: true, shiftKey: true, bubbles: true, cancelable: true })); return true;");
  await eventually("keyboard command palette focused", () => js("return document.activeElement?.id === 'palette-text';"));
  await set("#palette-text", `>${command}`);
  await eventually("keyboard command selected", () => js("return document.querySelector('#palette-options [aria-current=true]')?.textContent?.toLowerCase();"), value => value?.includes(command));
}

const enterKeyboardCommand = () => js("document.querySelector('#palette-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true;");

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

async function clickGlyphBreakpoint(line) {
  const hit = await js(`
    const line = arguments[0];
    window.__ironTest.revealLine(line);
    const gutter = document.querySelector('#editor .glyph-margin').getBoundingClientRect();
    const number = [...document.querySelectorAll('#editor .line-numbers')].find(row => row.textContent.trim() === String(line))?.getBoundingClientRect();
    if (!number) return null;
    const x = gutter.left + gutter.width / 2;
    const y = number.top + number.height / 2;
    const target = document.elementFromPoint(x, y);
    const options = { bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y };
    target.dispatchEvent(new MouseEvent('mousedown', { ...options, buttons: 1 }));
    target.dispatchEvent(new MouseEvent('mouseup', { ...options, buttons: 0 }));
    return { width: gutter.width, hit: window.__ironTest.gutterTrace().hit };
  `, line);
  assert.deepEqual(hit, { width: 18, hit: { line, type: "GUTTER_GLYPH_MARGIN" } });
  await eventually("clicked glyph created breakpoint", () => js("return !!document.querySelector('#editor .debug-breakpoint');"));
}

async function traceGutterClick(line) {
  const trace = await js(`
    const line = arguments[0];
    window.__ironTest.revealLine(line);
    const before = window.__ironTest.gutterTrace([line, line + 1]);
    const number = [...document.querySelectorAll('#editor .line-numbers')].find(row => row.textContent.trim() === String(line));
    if (!number) return { before, error: 'gutter number is not visible' };
    const bounds = number.getBoundingClientRect();
    const options = { bubbles:true, cancelable:true, view:window, detail:1, button:0,
        clientX:bounds.x + bounds.width/2, clientY:bounds.y + bounds.height/2 };
    const rowDelta = Math.min(...[...document.querySelectorAll('#editor .view-lines .view-line')]
      .map(row => Math.abs(row.getBoundingClientRect().top - bounds.top)));
    number.dispatchEvent(new MouseEvent('mousedown', { ...options, buttons:1 }));
    number.dispatchEvent(new MouseEvent('mouseup', { ...options, buttons:0 }));
    window.__ironTest.refreshView();
    const after = window.__ironTest.gutterTrace([line, line + 1]);
    window.__ironTest.revealLine(line + 1);
    const moved = window.__ironTest.gutterTrace([line, line + 1]);
    return { requestedLine:line, rowDelta, before, after, moved };
  `, line);
  await writeFile(path.join(artifacts, "gutter-click.json"), JSON.stringify(trace, null, 2));
  if (values["gutter-line"] || values["trace-editor"]) console.log(JSON.stringify(trace, null, 2));
  assert.equal(trace.after?.hit?.type, "GUTTER_LINE_NUMBERS", "the diagnostic must use the number column, not the breakpoint gutter");
  assert.equal(trace.after.hit.line, line, "Monaco should hit the number clicked");
  assert.ok(trace.rowDelta <= 1, "gutter and code geometry should align before the click");
  assert.deepEqual(trace.after.selection, { start: { lineNumber: line, column: 1 }, end: { lineNumber: line + 1, column: 1 }, empty: false });
  assert.deepEqual(trace.after.caret, { lineNumber: line + 1, column: 1 }, "keep Monaco's whole-line selection endpoint");
  assert.deepEqual(trace.after.highlightedNumbers, [String(line)]);
  assert.equal(trace.after.numberColors[line], trace.before.numberColors[line], "selected number uses the active foreground");
  assert.equal(trace.after.numberColors[line + 1], trace.before.numberColors[line + 1], "selection endpoint number uses the normal foreground");
  assert.deepEqual(trace.moved.highlightedNumbers, [String(line + 1)], "normal caret moves restore the active number");
  assert.ok(trace.moved.selection.empty);
}

async function record(name, run, id) {
  const started = Date.now();
  try {
    assert.ok(!report.terminal, "Cannot start another case after a terminal checkpoint.");
    await run();
    if (!report.terminal) await assertRuntime();
    const entry = { name, ...(id ? { id } : {}), result: "pass", ms: Date.now() - started };
    if (values["trace-editor"] && sid && !report.terminal) {
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
    report.cases.push({ name, ...(id ? { id } : {}), result: "fail", error: String(error.stack ?? error), ms: Date.now() - started });
    throw error;
  }
}

const recordCase = (id, name, run) => record(name, run, id);
const setGoCapability = gopls => { report.goplsAvailable = gopls; };
const skipCase = (name, reason) => {
  console.log(`  SKIP ${name} (${reason})`);
  report.cases.push({ name, result: "skip", reason });
};

const runtimeErrors = () => js("return window.__ironTestRuntimeErrors?.();");
const assertRuntime = async () => runtimeClean(await runtimeErrors());

async function captureState(name) {
  const state = await js(`return {
    state: window.__ironTest?.snapshot(), runtimeErrors: window.__ironTestRuntimeErrors?.(),
    output: document.querySelector('#output-log')?.textContent ?? '',
    status: document.querySelector('#status')?.textContent, toast: document.querySelector('#toast')?.textContent,
  };`);
  await writeFile(path.join(artifacts, name), JSON.stringify(state, null, 2));
  return state;
}

async function terminalCheckpoint(action) {
  const state = await captureState("last-live.json");
  runtimeClean(state.runtimeErrors);
  await assertRuntime();
  report.terminal = { action, rendererObserved: "through last live checkpoint before requesting exit" };
}

async function observeBeforeCrash(pid) {
  let receive;
  const observed = new Promise(resolve => {
    receive = message => { if (message?.type === "crash-observed" && message.pid === pid) resolve(message); };
    process.on("message", receive);
  });
  try {
    process.send({ type: "observe-before-crash", pid });
    const result = await Promise.race([observed, delay(4000, { error: "Timed out observing the disposable app's descendants." }, { ref: false })]);
    assert.equal(result.error, undefined);
  } finally { process.off("message", receive); }
}

async function probeTools({ gopls = false, delve = false } = {}) {
  await js(`window.__groupToolProbe = undefined;
    void window.__ironTest.toolProbe().then(tools => window.__groupToolProbe = { tools }, error => window.__groupToolProbe = { error: String(error) });
    return true;`);
  const result = await eventually("tool capability probe resolved", () => js("return window.__groupToolProbe;"));
  if (result.error) throw new Error(`Tool capability probe failed: ${result.error}`);
  assert.equal(typeof result.tools?.gopls, "boolean", "probe did not report gopls availability");
  if (gopls) assert.ok(result.tools.gopls, "This group requires an installed and working gopls.");
  if (delve) assert.ok(result.tools.delve, "This group requires an installed and working Delve.");
  return result.tools;
}

async function externalProjectSmoke() {
  if (values["test-file"]) await probeTools({ gopls: true, delve: !!values["debug-test"] });
  const module = (await readFile(path.join(fixture, "go.mod"), "utf8")).match(/^module\s+(\S+)/m)?.[1];
  assert.ok(module, "The project smoke expects a root go.mod");
  await record(`opens the committed ${module} snapshot as a real Go project`, async () => {
    await eventually("workbench ready", () => js("return !!window.__ironTest && document.querySelector('#project-welcome')?.hidden === false;"));
    await openProjectControl("#welcome-open");
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
    if (values["gutter-line"]) await record("trace a real Monaco gutter click", () => traceGutterClick(Number(values["gutter-line"])));
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

const context = {
  accessibilityHelper, addWaitTarget, app, artifacts, assertLineAlignment, checkTheme,
  chooseCommand, click, clickCodeLens, clickGlyphBreakpoint, current, driver,
  enterKeyboardCommand, eventually, fixture, holdConfiguredBuild, home, js, observeBeforeCrash,
  openOrbit, openProjectControl, openTestFile, output, peer, peerExited, pid, placeBreakpoint,
  prepareKeyboardCommand, probeTools, record, recordCase, refreshThroughProjectActions, reopen,
  replace, requestNativeQuit, selectTarget, set, setGoCapability, setNativeTheme, skipCase,
  terminalCheckpoint, text, traceGutterClick, trashRoot, values, w3c,
};

try {
  await eventually("embedded macOS WebDriver", () => w3c("/status"), value => value?.ready);
  ({ sessionId: sid } = await w3c("/session", { capabilities: { alwaysMatch: {} } }));
  await eventually("workbench test adapter", () => js("return !!window.__ironTest;"));
  await assertRuntime();

  if (group === "recovery") await recoverySuite(context);
  else if (group === "recent") await recentSuite(context);
  else if (group === "trash") await trashSuite(context);
  else if (group === "terminal") await terminalSuite(context);
  else if (group === "accessibility") await accessibilitySuite(context);
  else if (reopen) await reopenGoSuite(context);
  else if (group === "external") await externalProjectSmoke();
  else if (group === "quit") await nativeQuitSmoke(context);
  else if (group === "quit-save") await nativeSaveQuit(context);
  else if (group === "crash") await crashWorkerWithLiveChild();
  else await ({ lifecycle: lifecycleSuite, files: fileSuite, go: goSuite, debug: debugSuite })[group](context);
} catch (error) {
  report.failure = String(error.stack ?? error);
  report.diagnostics = [];
  if (sid) {
    try {
      const screenshot = await w3c(`/session/${sid}/screenshot`);
      await writeFile(path.join(artifacts, "workbench.png"), Buffer.from(screenshot, "base64"));
    } catch (capture) { report.diagnostics.push(`Screenshot: ${capture}`); }
    try {
      await captureState("workbench.json");
    } catch (capture) { report.diagnostics.push(`Workbench: ${capture}`); }
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
  finishing = true;
  process.disconnect();
}

function requestNativeQuit() {
  assert.ok(quitHelper, "A compiled native Quit helper is required");
  execFileSync(quitHelper, [String(app.child.pid)], { timeout: 10_000 });
}

function selectNativeTheme(value) {
  return js(`
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
}

async function setNativeTheme(theme) {
  await click("#settings");
  assert.equal(await selectNativeTheme(theme), null);
  await click('[data-dialog-close="settings-dialog"]');
  await eventually("Settings finishes restoring focus", () => js(`
    return !document.querySelector('#settings-dialog').open && document.activeElement?.id === 'settings';`));
}

async function checkTheme() {
  await record("native theme switches both the editor and workbench", async () => {
    await eventually("workbench boot", () => js("return !!window.__ironTest && document.body.classList.contains('desktop');"));
    const colors = () => js("return ['.monaco-editor-background', '.sidebar', '.bottom-panel', '#run'].map(selector => getComputedStyle(document.querySelector(selector)).backgroundColor);");
    await click("#settings");
    assert.equal(await selectNativeTheme("light"), null);
    await eventually("native Light Modern colors", colors, value => value?.join("/") === "rgb(255, 255, 255)/rgb(248, 248, 248)/rgb(248, 248, 248)/rgb(0, 95, 184)");
    assert.equal(await selectNativeTheme("dark"), null);
    await eventually("native Dark Modern colors", colors, value => value?.join("/") === "rgb(31, 31, 31)/rgb(24, 24, 24)/rgb(24, 24, 24)/rgb(0, 120, 212)");
    await click('[data-dialog-close="settings-dialog"]');
  });
}

async function openOrbit() {
  await openProjectControl("#welcome-open");
  return eventually("native folder and Monaco file", current, state => state?.path === "cmd/orbit/main.go" && state?.root === fixture);
}

async function addWaitTarget() {
  await mkdir(path.join(fixture, "cmd/wait"));
  await writeFile(path.join(fixture, "cmd/wait/entry.go"), 'package main\nimport ("fmt"; "os"; "time")\nfunc main(){fmt.Printf("agent-ready %d\\n", os.Getpid()); time.Sleep(time.Minute)}\n');
}

async function selectTarget() {
  await eventually("wait target discovered", () => js("return [...document.querySelector('#run-target').options].some(option => option.value === './cmd/wait');"));
  await js("const select = document.querySelector('#run-target'); select.value = './cmd/wait'; select.dispatchEvent(new Event('change')); return true;");
  await eventually("wait target can be run", () => js("return document.querySelector('#run-target').value === './cmd/wait' && !document.querySelector('#run').disabled;"));
}

async function crashWorkerWithLiveChild() {
  await addWaitTarget();
  await openOrbit();
  await selectTarget();
  await click("#run");
  const ready = await eventually("live Go child for the crash probe", output, value => /agent-ready \d+/.test(value), 30_000);
  await assertRuntime();
  await writeFile(path.join(artifacts, "crash-probe.json"), JSON.stringify({ pid: Number(ready.match(/agent-ready (\d+)/)[1]) }));
  process.kill(process.pid, "SIGKILL");
}

async function holdConfiguredBuild(launch = () => click("#run")) {
  await js(`window.__handoffArmed = false; window.__handoffDirectory = null;
    void window.__ironTest.runHandoff(true).then(() => window.__handoffArmed = true); return true;`);
  await eventually("the native handoff barrier is armed", () => js("return window.__handoffArmed;"));
  await launch();
  return eventually("the configured build succeeds and waits before executable admission", () => js(`
    void window.__ironTest.runHandoff().then(directory => window.__handoffDirectory = directory);
    return window.__handoffDirectory;
  `), Boolean, 30_000);
}

async function openTestFile() {
  await click("#quick-open");
  await set("#palette-text", "report_test.go");
  await click("#palette-options button");
  await eventually("test file is active", current, state => state?.path === "internal/status/report_test.go");
}

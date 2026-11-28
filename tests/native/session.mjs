import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expectedGoSyntax, goSyntaxSample, renderedGoSyntax } from "../go-syntax-sample.mjs";
import { runtimeClean } from "./plan.mjs";

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

async function record(name, run) {
  const started = Date.now();
  try {
    assert.ok(!report.terminal, "Cannot start another case after a terminal checkpoint.");
    await run();
    if (!report.terminal) await assertRuntime();
    const entry = { name, result: "pass", ms: Date.now() - started };
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
    report.cases.push({ name, result: "fail", error: String(error.stack ?? error), ms: Date.now() - started });
    throw error;
  }
}

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

try {
  await eventually("embedded macOS WebDriver", () => w3c("/status"), value => value?.ready);
  ({ sessionId: sid } = await w3c("/session", { capabilities: { alwaysMatch: {} } }));
  await eventually("workbench test adapter", () => js("return !!window.__ironTest;"));
  await assertRuntime();

  if (group === "recovery") await recoverySuite();
  else if (group === "recent") await recentSuite();
  else if (group === "trash") await trashSuite();
  else if (group === "terminal") await terminalSuite();
  else if (group === "accessibility") await accessibilitySuite();
  else if (reopen) await reopenGoSuite();
  else if (group === "external") await externalProjectSmoke();
  else if (group === "quit") await nativeQuitSmoke();
  else if (group === "quit-save") await nativeSaveQuit();
  else if (group === "crash") await crashWorkerWithLiveChild();
  else await ({ lifecycle: lifecycleSuite, files: fileSuite, go: goSuite, debug: debugSuite })[group]();
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

async function accessibilitySuite() {
  const native = request => JSON.parse(execFileSync(accessibilityHelper, [String(pid)], { input: JSON.stringify(request), encoding: "utf8", timeout: 6000 }));
  const keys = (...keys) => native({ action: "keys", keys });
  await record("native Command-N opens New Project from Welcome", async () => {
    await eventually("native New Project is ready", () => js("return window.__ironTest.menuItem('File', 'New Project…');"), value => value === true);
    await js("return window.__ironTest.focusWindow().then(() => true);");
    native({ action: "activate" });
    keys({ code: 45, modifiers: ["command"] });
    await eventually("the native accelerator opens the New Project form", () => js("return document.querySelector('#form-dialog').open;"));
    assert.equal(await text("#form-title"), "New Project");
    await click('[data-dialog-close="form-dialog"]');
    await eventually("Welcome is still open", () => js("return !document.querySelector('#project-welcome').hidden;"));
  });
  await record("native keyboard input preserves Unicode and workbench focus", async () => {
    const source = path.join(fixture, "cmd/orbit/main.go");
    const original = "package main\n\nfunc main() {}\n";
    await writeFile(source, original);
    await openOrbit();
    await js("window.__ironTest.revealLine(1); return true;");
    await click("#settings");
    assert.equal(await js("return !!document.querySelector('#screen-reader-setting');"), false, "VoiceOver support is deferred");
    assert.deepEqual(await js("return window.__ironTest.editorInputOptions();"), { accessibilitySupport: "off", editContext: false });
    await click('[data-dialog-close="settings-dialog"]');
    await eventually("Settings restores the initiating control", () => js("return document.activeElement?.id;"), value => value === "settings");
    await js("return window.__ironTest.focusWindow().then(() => true);");
    native({ action: "activate" });
    await js("window.__ironTest.revealLine(4); return true;");
    await js(`window.__axInputTrace = [];
      for (const type of ['keydown', 'beforeinput', 'input']) document.addEventListener(type, event => {
        if (document.querySelector('#editor').contains(event.target) && window.__axInputTrace.length < 100) {
          window.__axInputTrace.push({ type, key: event.key, data: event.data, inputType: event.inputType });
        }
      }, true); return true;`);
    keys(...Array.from("// Text あ😀!").map(text => ({ code: 0, text })));
    try { await eventually("hardware-style Unicode input reaches Monaco", current, entry => entry?.text === original + "// Text あ😀!"); }
    finally { await writeFile(path.join(artifacts, "accessibility-input.json"), JSON.stringify(await js("return window.__axInputTrace;"), null, 2)); }
    keys({ code: 123 }, { code: 123, modifiers: ["shift"] }, { code: 51 });
    const expected = original + "// Text あ!";
    await eventually("native cursor navigation and selection remove the full emoji", current, entry => entry?.text === expected);
    const ax = await eventually("WKWebView exposes named workbench controls to the native accessibility client", () => native({ action: "tree" }),
      value => ["Open Project", "Save File"].every(label => value.nodes.some(node => node.AXRole === "AXButton" &&
        [node.AXTitle, node.AXDescription].includes(label))));
    const caret = await js("return window.__ironTest.gutterTrace().caret;");
    keys({ code: 43, modifiers: ["command"] });
    await eventually("Settings can be opened from the editor with a real keystroke", () => js("return document.querySelector('#settings-dialog').open;"));
    await click('[data-dialog-close="settings-dialog"]');
    await eventually("the same editor regains focus after Settings closes", () => js("return document.querySelector('#editor').contains(document.activeElement);"));
    assert.deepEqual(await js("return window.__ironTest.gutterTrace().caret;"), caret);
    assert.equal((await current()).text, expected);
    assert.equal((await current()).dirty, true);
    await writeFile(path.join(artifacts, "accessibility-tree.json"), JSON.stringify(ax, null, 2));
    keys({ code: 1, modifiers: ["command"] });
    await eventually("the native save writes the edited Unicode bytes", () => readFile(source, "utf8"), bytes => bytes === expected);
    keys({ code: 0, text: "X" });
    await eventually("a later native edit makes the confirmation applicable", current, entry => entry?.dirty);
    await js("document.querySelector('#tabs [data-tab-path=\"cmd/orbit/main.go\"] .tab-close').focus(); return true;");
    keys({ code: 36 });
    await eventually("the dirty close confirmation is displayed", () => js("return document.querySelector('#file-decision-dialog').open;"));
    const decision = await eventually("the native AX tree names the confirmation and its options", () => native({ action: "tree" }),
      value => ["Close unsaved file?", "Save and Close", "Discard", "Cancel"].every(label => value.nodes.some(node => Object.values(node).includes(label))));
    await writeFile(path.join(artifacts, "accessibility-confirmation.json"), JSON.stringify(decision, null, 2));
    keys({ code: 53 });
    await eventually("Escape restores focus to the initiating close control", () => js("return document.activeElement?.classList.contains('tab-close');"));
    await js("window.__ironTest.revealLine(3); return true;");
    const departure = await js("return window.__ironTest.codeLocation();");
    keys({ code: 14, modifiers: ["shift", "command"] });
    await eventually("the existing keyboard shortcut moves focus out of Monaco into Explorer", () => js("return document.querySelector('#explorer').contains(document.activeElement);"));
    keys({ code: 119 }, { code: 36 });
    await eventually("opening a focused file returns to the editor", () => js("return document.querySelector('#editor').contains(document.activeElement);"));
    const arrival = (await current()).path;
    assert.notEqual(arrival, departure.path);
    keys({ code: 27, modifiers: ["control"] });
    await eventually("Control-Minus returns to the original editor", current, entry => entry?.path === departure.path);
    assert.deepEqual(await js("return window.__ironTest.codeLocation();"), departure);
    keys({ code: 27, modifiers: ["control", "shift"] });
    await eventually("Control-Shift-Minus goes forward", current, entry => entry?.path === arrival);
  });
}

async function terminalSuite() {
  const snapshot = () => js("return window.__ironTest.terminalSnapshot();");
  const observation = () => js("return window.__ironTest.terminalObservation();");
  const send = text => js("window.__ironTest.terminalInput(arguments[0]); return true;", text);
  const close = async () => {
    await click("#terminal-close");
    await eventually("the active terminal has an explicit close decision", () => js("return document.querySelector('#terminal-close-dialog')?.open || document.querySelector('#terminal-tab').hidden;"));
    if (await js("return document.querySelector('#terminal-close-dialog')?.open === true;")) await click("#terminal-close-confirm");
    await eventually("the terminal slot is inactive", snapshot, state => !state?.active);
  };
  await record("a real macOS PTY shell accepts input, resizes, interrupts and closes", async () => {
    await openOrbit();
    await click("#quick-open");
    await set("#palette-text", ">start shell");
    await eventually("the workbench can start a real local shell", () => text("#palette-options"), value => /Start Shell/.test(value));
    await click("#palette-options button");
    await eventually("the terminal starts and is visible", () => js("return !!document.querySelector('#terminal-pane .xterm');"));
    await send("printf 'shell-cwd:%s\\n' \"$PWD\"; printf 'shell-unicode:\\343\\201\\202\\n'\r");
    await eventually("real shell output contains the workspace and Unicode", snapshot,
      state => state?.text.includes(`shell-cwd:${fixture}`) && state.text.includes("shell-unicode:あ"));
    const before = await snapshot();
    await js("return window.__ironTest.resize(840, 620).then(() => true);");
    const resized = await eventually("the terminal follows the actual native window resize", snapshot,
      state => state?.cols > 0 && state.cols !== before.cols);
    await send("printf 'tty-size:'; stty size\r");
    await eventually("the macOS kernel reports the resized PTY", snapshot, state => state?.text.includes(`tty-size:${resized.rows} ${resized.cols}`));
    await send("/bin/sh -c 'printf \"owned-foreground:%s\\n\" \"$$\"; exec /bin/sleep 120'\r");
    const ready = await eventually("a separate foreground process is running", snapshot, state => /owned-foreground:\d+/.test(state?.text));
    const foreground = Number(ready.text.match(/owned-foreground:(\d+)/)[1]);
    await send("\x03");
    await eventually("Ctrl-C interrupts the actual foreground process", () => {
      try { process.kill(foreground, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
    });
    await send("printf 'back-at-prompt\\n'\r");
    await eventually("the shell survives its foreground job", snapshot, state => /(?:^|\n)back-at-prompt/.test(state?.text));
    await eventually("the ordinary target is ready", () => js("return document.querySelector('#run-target').value === './cmd/orbit' && !document.querySelector('#run').disabled;"));
    await click("#run");
    await eventually("ordinary Go Run still uses Task Output while a shell is open", output, value => /orbit v0\.1\.0 is online[\s\S]*exit code 0/.test(value), 30_000);
    assert.equal((await snapshot()).active, true);
    await click("#terminal-tab");
    await close();
  });
  await record("full terminal output credit does not block resize or foreground teardown", async () => {
    await chooseCommand("start shell");
    const old = await eventually("a fresh shell is admitted", snapshot, state => state?.active && state.id && state.text.includes("%"));
    await js("window.__ironTest.holdTerminalAck(true); return true;");
    try {
      await send("/bin/sh -c 'printf \"burst-process:%s\\n\" \"$$\"; exec /bin/dd if=/dev/zero bs=65536 count=32'\r");
      // The process marker can scroll out of xterm's bounded history once the
      // credit fills. Read the actual native child from this shell tree.
      const foreground = await eventually("the foreground output fixture is live", () => {
        const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n");
        const shell = rows.flatMap(row => { const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/); return match ? [{ id: Number(match[1]), parent: Number(match[2]), command: match[3] }] : []; });
        const owner = shell.find(row => row.parent === pid && row.command.includes("zsh"));
        return owner && shell.find(row => row.parent === owner.id && row.command.includes("dd if=/dev/zero bs=65536 count=32"))?.id;
      });
      const full = await eventually("64 KiB of unacknowledged renderer output is held", snapshot, state => state?.heldBytes === 64 * 1024);
      await js("return window.__ironTest.resize(970, 680).then(() => true);");
      const resized = await eventually("resize still reaches xterm while native output is backpressured", snapshot, state => state?.cols > 0 && state.cols !== full.cols);
      await eventually("the kernel PTY resizes without needing output credit", observation,
        state => state?.credit === 0 && state.cols === resized.cols && state.rows === resized.rows);
      await close();
      await eventually("closing during backpressure reaps the actual foreground job", () => {
        try { process.kill(foreground, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
      });
      await chooseCommand("start shell");
      const replacement = await eventually("a distinct terminal generation is admitted", snapshot, state => state?.active && state.id && state.id !== old.id && state.text.includes("%"));
      assert.notEqual(replacement.id, old.id);
      const newCredit = await eventually("the new prompt has its own pending receipt", observation, state => state?.credit < 64 * 1024);
      await js("return window.__ironTest.attemptTerminalAck(arguments[0], 1).then(() => true);", old.id);
      await delay(80);
      assert.equal((await observation()).credit, newCredit.credit, "Rust must ignore stale receipts even if their sequence matches the new terminal");
    } finally { await js("window.__ironTest.holdTerminalAck(false); return true;"); }
    await send("printf 'replacement-shell\\n'\r");
    await eventually("late old credits cannot disrupt the replacement", snapshot, state => /(?:^|\n)replacement-shell/.test(state?.text));
    const startShellEnabled = () => js("return window.__ironTest.menuItem('Run', 'Start Shell');");
    await eventually("native Start Shell is disabled while the shell is active", startShellEnabled, value => value === false);
    await send("exit\r");
    await eventually("native Start Shell becomes available after a natural shell exit", startShellEnabled, value => value === true);
    await close();
  });
  await record("a foreground survivor after leader exit keeps the terminal slot reserved", async () => {
    await chooseCommand("start shell");
    const owner = await eventually("the shell leader is observed", observation, state => state?.leader > 0);
    await send("/bin/sh -c 'trap \"\" HUP; printf \"surviving-foreground:%s\\n\" \"$$\"; exec /bin/sleep 120'\r");
    const ready = await eventually("the fixture reports its actual foreground PID", snapshot, state => /surviving-foreground:\d+/.test(state?.text));
    const foreground = Number(ready.text.match(/surviving-foreground:(\d+)/)[1]);
    const alive = processId => {
      try { process.kill(processId, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
    };
    try {
      await eventually("Rust observes the shell's separate foreground", observation, state => state?.foreground.includes(foreground));
      process.kill(owner.leader, "SIGKILL");
      await eventually("the native shell leader exits while a different process survives", () => !alive(owner.leader) && alive(foreground));
      await click("#terminal-close");
      await eventually("the unresolved terminal still needs an explicit close decision", () => js("return document.querySelector('#terminal-close-dialog').open;"));
      await click("#terminal-close-confirm");
      await eventually("cleanup timeout is reported without releasing the terminal", () => text("#toast"), value => /Terminal cleanup could not be confirmed/.test(value));
      assert.equal((await snapshot()).active, true);
      await chooseCommand("start shell");
      await eventually("a new shell is refused while the old foreground survives", () => text("#toast"), value => /Close the active terminal/.test(value));
    } finally {
      if (alive(foreground)) {
        const command = execFileSync("ps", ["-p", String(foreground), "-o", "command="], { encoding: "utf8" });
        assert.match(command, /sleep 120/);
        process.kill(foreground, "SIGKILL");
      }
    }
    await eventually("the slot retires once the observed foreground exits", snapshot, state => !state?.active);
  });
  await record("interactive Go uses configured cwd, args, environment and a real stdin", async () => {
    const module = path.join(fixture, "interactive-module");
    const runtime = path.join(fixture, "interactive-runtime");
    await Promise.all([mkdir(module), mkdir(runtime)]);
    await writeFile(path.join(fixture, "go.work"), "go 1.22\n\nuse (\n\t.\n\t./interactive-module\n)\n");
    await writeFile(path.join(module, "go.mod"), "module example.test/interactive-module\n\ngo 1.22\n");
    await writeFile(path.join(module, "main.go"), `package main
import ("bufio"; "encoding/json"; "fmt"; "os"; "strings")
func main() {
  cwd, _ := os.Getwd()
  data, _ := json.Marshal(map[string]any{"cwd":cwd,"args":os.Args[1:],"gowork":os.Getenv("GOWORK"),"env":os.Getenv("TERMINAL_FIXTURE")})
  fmt.Printf("terminal-context %s\\n", data)
  answer, _ := bufio.NewReader(os.Stdin).ReadString('\\n')
  fmt.Printf("received-answer:%s\\n", strings.TrimSpace(answer))
}
`);
    await openProjectControl("#open-folder");
    await eventually("the nested executable is discovered", () => js("return Array.from(document.querySelector('#run-target').options, option => option.value);"), targets => targets.includes("./interactive-module"));
    await click('[data-view="tasks"]');
    await click("#run-configurations");
    await set("#run-config-name", "Terminal fixture");
    await set("#run-config-package", "./interactive-module");
    await set("#run-config-directory", "interactive-runtime");
    const args = ["", "two words"];
    await set("#run-config-arguments", JSON.stringify(args));
    await set("#run-config-session", "GOWORK=invalid-for-build\nTERMINAL_FIXTURE=visible only in program");
    await click("#run-config-save");
    await eventually("the configured target is selected", () => js("return document.querySelector('#run-target').selectedOptions[0]?.textContent;"), value => value?.includes("Terminal fixture"));
    const launch = () => chooseCommand("run go program in terminal");
    const release = () => js("return window.__ironTest.runHandoff(false).then(() => true);");
    try {
      const cancelled = await holdConfiguredBuild(launch);
      await js(`window.__ordinaryTask = ''; void window.__ironTest.attemptConfiguredRun('./cmd/orbit', { directory: '.', args: [], environment: {} })
        .then(() => window.__ordinaryTask = 'unexpected admission', error => window.__ordinaryTask = String(error)); return true;`);
      await eventually("the native Go lane is reserved during terminal build", () => js("return window.__ordinaryTask;"), value => /already running/.test(value));
      await close();
      await eventually("cancellation removes the terminal build directory", async () => {
        try { await stat(cancelled); return false; } catch (error) { return error.code === "ENOENT"; }
      });
    } finally { await release(); }
    await launch();
    const began = await eventually("the Go executable starts inside the PTY", snapshot, state => /terminal-context \{[^\n]+\}/.test(state?.text), 30_000);
    assert.deepEqual(JSON.parse(began.text.match(/terminal-context (\{[^\n]+\})/)[1]),
      { cwd: runtime, args, gowork: "invalid-for-build", env: "visible only in program" });
    await send("actual terminal input あ\r");
    await eventually("Go reads native interactive input", snapshot, state => state?.text.includes("received-answer:actual terminal input あ"));
    await eventually("natural exit frees both terminal and Go reservations", snapshot, state => !state?.active);
    assert.equal(await js("return !document.querySelector('#run').disabled;"), true);
  });
  await record("actual project switch and Quit retire a live terminal foreground", async () => {
    const alive = processId => {
      try { process.kill(processId, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
    };
    const start = async () => {
      await chooseCommand("start shell");
      const owner = await eventually("a shell leader is alive", observation, state => state?.leader > 0);
      await send("/bin/sh -c 'printf \"closing-foreground:%s\\n\" \"$$\"; exec /bin/sleep 120'\r");
      const began = await eventually("a real foreground is active", snapshot, state => /closing-foreground:\d+/.test(state?.text));
      const processId = Number(began.text.match(/closing-foreground:(\d+)/)[1]);
      assert.ok(alive(owner.leader) && alive(processId));
      return () => !alive(owner.leader) && !alive(processId);
    };
    const old = await start();
    const workspace = await js("return window.__ironTest.workspaceId();");
    const switchProject = async () => {
      await openProjectControl("#open-folder");
      await eventually("switch warns about the active terminal", () => text("#project-transition-description"), value => /terminal.*foreground/.test(value));
      await click("#project-transition-continue");
      await eventually("the workbench settles the project picker", () => js("return !document.querySelector('#open-folder').disabled;"));
    };
    await js("return window.__ironTest.cancelNextPicker().then(() => true);");
    await switchProject();
    assert.equal(await js("return window.__ironTest.workspaceId();"), workspace);
    assert.equal(old(), false, "a cancelled picker must preserve the terminal");
    await switchProject();
    assert.notEqual(await js("return window.__ironTest.workspaceId();"), workspace);
    assert.equal(old(), true, "cutover must wait for leader and foreground cleanup");

    const shutdown = await start();
    await terminalCheckpoint("Quit with PTY");
    try { await js("void window.__ironTest.quitMenu(); return true;"); }
    catch (error) { if (error.cause?.code !== "UND_ERR_SOCKET") throw error; }
    const exit = await Promise.race([app.exited, delay(10_000, { timedOut: true }, { ref: false })]);
    assert.equal(exit.code, 0);
    assert.equal(shutdown(), true, "AppKit Quit waits for PTY and foreground retirement");
  });
}

async function trashSuite() {
  await record("actual macOS Trash preserves disk bytes on an isolated APFS volume", async () => {
    assert.ok(trashRoot && trashRoot.startsWith(path.dirname(path.dirname(fixture)) + path.sep));
    const relative = "trash-fixture.txt";
    const file = path.join(fixture, relative);
    const original = "The disposable disk bytes for Trash.\n";
    await writeFile(file, original);
    await openOrbit();
    await click("#quick-open");
    await set("#palette-text", relative);
    await click("#palette-options button");
    await eventually("the disposable file is open", current, entry => entry?.path === relative);
    await replace("Unsaved text to discard only after confirming Trash.\n");
    await chooseCommand("move to trash");
    await eventually("dirty Trash requires a discard decision", () => text("#form-submit"), value => /Discard and Move to Trash/.test(value));
    await click('[data-dialog-close="form-dialog"]');
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal((await current()).dirty, true);
    await chooseCommand("move to trash");
    await eventually("Trash reopens the explicit discard decision", () => text("#form-submit"), value => /Discard and Move to Trash/.test(value));
    await click("#form-submit");
    await eventually("the app reports the actual Trash operation", () => text("#status"), value => /Moved trash-fixture\.txt to Trash/.test(value));
    await assert.rejects(stat(file), { code: "ENOENT" });
    assert.equal(await js("return !!document.querySelector('#tabs [data-path=\"trash-fixture.txt\"]');"), false);
    const contained = (await readdir(trashRoot)).filter(name => name.startsWith("trash-fixture"));
    assert.equal(contained.length, 1);
    assert.equal(await readFile(path.join(trashRoot, contained[0]), "utf8"), original);
  });
}

async function recentSuite() {
  const paths = ["session-one.txt", "session-deleted.txt", "session-two.txt"];
  const oracle = path.join(home, "editor-session-oracle.json");
  const view = () => js("const session = window.__ironTest.editorSession(); return session.tabs.find(tab => tab.path === session.active);");
  const activate = async relative => {
    await click(`#tabs [data-path="${relative}"]`);
    await eventually(`the ${relative} tab is active`, current, state => state?.path === relative);
  };
  if (!reopen) {
    await record("ordinary Quit captures active and inactive editor positions", async () => {
      const source = Array.from({ length: 180 }, (_, index) => `Line ${index + 1} of the disposable session fixture`).join("\n") + "\n";
      await Promise.all(paths.map(relative => writeFile(path.join(fixture, relative), source)));
      await openOrbit();
      const expected = {};
      for (const [index, relative] of paths.entries()) {
        await click("#quick-open");
        await set("#palette-text", relative);
        await click("#palette-options button");
        await eventually(`indexed ${relative} opens`, current, state => state?.path === relative);
        const line = 55 + index * 25;
        await js("window.__ironTest.revealLine(arguments[0]); window.__ironTest.position(arguments[0], arguments[1]); return true;", line, index + 3);
        expected[relative] = await eventually("the editor viewport moves", view, state => state?.line === line && state.firstLine > 1);
      }
      const history = path.join(home, "Library/Application Support/dev.irongo.e2e/recent-v1/index.json");
      const stored = async () => JSON.parse(await readFile(history, "utf8")).entries[0]?.editor;
      const earlier = await eventually("the old viewport was durably recorded", stored, data => data?.tabs.find(tab => tab.path === paths[2])?.line === expected[paths[2]].line);
      await js("window.__ironTest.holdEditorSession(true); window.__ironTest.revealLine(146); window.__ironTest.position(146, 8); return true;");
      expected[paths[2]] = await eventually("a distinct final viewport is present before Quit", view, state => state?.line === 146 && state.firstLine !== earlier.tabs.find(tab => tab.path === paths[2]).firstLine);
      assert.deepEqual(await stored(), earlier);
      await writeFile(oracle, JSON.stringify(expected));
      await terminalCheckpoint("Quit with editor session");
      try { await js("void window.__ironTest.quitMenu(); return true;"); }
      catch (error) { if (error.cause?.code !== "UND_ERR_SOCKET") throw error; }
      const exit = await Promise.race([app.exited, delay(6000, { timedOut: true }, { ref: false })]);
      assert.equal(exit.code, 0);
      await rename(path.join(fixture, paths[1]), path.join(home, paths[1]));
    });
    return;
  }
  await record("Open Recent restores surviving editor tabs and viewports after relaunch", async () => {
    assert.equal((await current()).path ?? null, null);
    await eventually("Welcome offers Open Recent without automatically loading a project", () => js("return document.querySelector('#welcome-recent')?.checkVisibility() === true;"));
    await click("#welcome-recent");
    await eventually("the remembered fixture is available", () => text("#recent-list"), value => /orbit/.test(value));
    await click("#recent-list .recent-open");
    await eventually("the previously active surviving tab is restored", current, state => state?.path === paths[2]);
    const tabs = await js("return Array.from(document.querySelectorAll('#tabs [data-tab-path]'), tab => tab.dataset.tabPath);");
    assert.deepEqual(tabs, ["cmd/orbit/main.go", paths[0], paths[2]]);
    const expected = JSON.parse(await readFile(oracle, "utf8"));
    for (const relative of [paths[2], paths[0]]) {
      await activate(relative);
      await eventually(`the exact restored caret and first visible line of ${relative} agree`, view,
        state => state?.line === expected[relative].line && state.column === expected[relative].column && state.firstLine === expected[relative].firstLine);
    }
    await eventually("the missing file is summarized", () => text("#toast"), value => /skipped.*1|1.*skipped/i.test(value));
    await refreshThroughProjectActions();
    assert.deepEqual(await view(), expected[paths[0]]);
    assert.deepEqual(await js("return Array.from(document.querySelectorAll('#tabs [data-tab-path]'), tab => tab.dataset.tabPath);"), tabs);
    await openProjectControl("#open-folder");
    await eventually("deliberate same-root reopen starts with a fresh editor", current, entry => entry?.path === "cmd/orbit/main.go");
    assert.deepEqual(await js("return Array.from(document.querySelectorAll('#tabs [data-tab-path]'), tab => tab.dataset.tabPath);"), ["cmd/orbit/main.go"]);
  });
}

async function recoverySuite() {
  const file = path.join(fixture, "cmd/orbit/main.go");
  const original = await readFile(file, "utf8");
  const local = original + "\n// Uncommitted crash recovery marker.\n";
  if (!reopen) {
    await record("a completed unsaved draft survives abrupt process termination", async () => {
      await openOrbit();
      await replace(local);
      await eventually("the native writer has committed the draft", () => text("#draft-state"), value => /Draft saved/.test(value));
      assert.equal(await readFile(file, "utf8"), original);
      await terminalCheckpoint("crash with completed draft");
      await observeBeforeCrash(app.child.pid);
      process.kill(app.child.pid, "SIGKILL");
      const exit = await Promise.race([app.exited, delay(6000, { timedOut: true }, { ref: false })]);
      assert.equal(exit.signal, "SIGKILL", "the test crashed the app process, not its worker");
      const substitute = `${file}.replacement`;
      await writeFile(substitute, original);
      await rename(substitute, file);
    });
    return;
  }
  if (reopen === "after-quit") {
    await record("ordinary Discard and Quit retires only that writer's draft", async () => {
      assert.equal((await current()).path ?? null, null);
      await openOrbit();
      await chooseCommand("recover drafts");
      await eventually("only the original crashed writer's draft remains", () => text("#draft-list"), value => /Detached writer/.test(value));
      assert.equal(await js("return document.querySelectorAll('#draft-list .draft-row').length;"), 1);
      await click('[data-dialog-close="draft-dialog"]');
      const moved = `${fixture}-moved`;
      await rename(fixture, moved);
      try {
        await chooseCommand("close project");
        await eventually("a moved project can still be closed", () => js("return !document.querySelector('#project-welcome').hidden;"));
        await chooseCommand("manage recovery drafts");
        await eventually("management lists the old location without opening it", () => text("#draft-list"), value => value.includes(fixture));
        const remove = '#draft-list .draft-row button';
        await click(remove);
        await eventually("removal requires a separate confirmation", () => text(remove), value => value === "Confirm Removal");
        await click(remove);
        await eventually("explicit removal retires the detached snapshot", () => text("#draft-dialog-note"), value => /No detached drafts/.test(value));
      } finally { await rename(moved, fixture); }
      assert.equal(await readFile(file, "utf8"), original);
    });
    return;
  }
  await record("recovery after a same-byte replacement retains the original disk expectation", async () => {
    assert.equal((await current()).path ?? null, null);
    assert.equal(await js("return !document.querySelector('#project-welcome').hidden;"), true);
    await openOrbit();
    await chooseCommand("recover drafts");
    await eventually("the detached draft is offered for explicit recovery", () => text("#draft-list"), value => /cmd\/orbit\/main\.go/.test(value));
    await click("#draft-list button");
    await eventually("the recovered content is a dirty editor buffer", current, entry => entry?.text === local && entry.dirty);
    assert.equal(await readFile(file, "utf8"), original);
    await click("#save");
    await eventually("normal Save refuses a replaced baseline even when the bytes match", () => text("#toast"), value => /disk version changed/i.test(value));
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal((await current()).dirty, true);
  });
  await record("a reviewed reload held during retirement preserves the draft if disk changes again", async () => {
    await eventually("the recovered draft copy is published", () => text("#draft-state"), value => /Draft saved/.test(value));
    await click("#compare-disk");
    await eventually("the reviewed reload action is ready", () => js("return document.querySelector('#disk-compare-dialog').open && !document.querySelector('#disk-compare-reload').disabled;"));
    await js("return window.__ironTest.holdSave(true, 'cmd/orbit/main.go').then(() => true);");
    try {
      await click("#disk-compare-reload");
      await eventually("the native reviewed retirement is held", () => js("return window.__ironTest.holdSave();"));
      await writeFile(file, original + "\n// Changed during recovery retirement.\n");
    } finally { await js("return window.__ironTest.holdSave(false).then(() => true);"); }
    await eventually("the reviewed reload reports the changed disk version", () => text("#toast"), value => /Compare again before reloading/.test(value));
    assert.equal((await current()).text, local);
    assert.equal((await current()).dirty, true);
    await chooseCommand("recover drafts");
    await eventually("the active copy's recovery entry remains published", () => text("#draft-list"), value => /Open writer/.test(value));
    await click('[data-dialog-close="draft-dialog"]');
    await writeFile(file, original);
  });
  await record("two live workbenches cannot remove an active writer or its newer detached draft", async () => {
    assert.ok(peer && peerExited);
    const request = (endpoint, payload) => w3c(endpoint, payload, undefined, peer.driver);
    await eventually("the second native workbench is ready", () => request("/status"), value => value?.ready);
    const { sessionId } = await request("/session", { capabilities: { alwaysMatch: {} } });
    const fromPeer = (script, ...args) => request(`/session/${sessionId}/execute/sync`, { script, args });
    await eventually("the second workbench has its own native adapter", () => fromPeer("return !!window.__ironTest;"));
    const records = () => js("return window.__ironTest.draftRecords();");
    const previous = new Set((await records()).map(entry => entry.writer));
    await fromPeer("document.querySelector('#welcome-open').click(); return true;");
    await eventually("the second writer opens the same project explicitly", () => fromPeer("return window.__ironTest.snapshot();"), entry => entry?.path === "cmd/orbit/main.go");
    await fromPeer("window.__ironTest.replace(arguments[0]); return true;", original + "\n// Independent writer first draft.\n");
    const captured = await eventually("the first app observes a live independent writer", async () => (await records()).find(entry => !previous.has(entry.writer)),
      entry => entry?.path === "cmd/orbit/main.go" && !entry.detached);
    const tryRemove = entry => js("return window.__ironTest.removeDraftRecord(arguments[0]).then(() => '', error => String(error));", entry);
    assert.match(await tryRemove(captured), /writer is still open/);
    await fromPeer("return window.__ironTest.holdDraftProfile(true).then(() => true);");
    try {
      await js("void window.__ironTest.quitMenu(); return true;");
      await eventually("Quit presents its decision while the second app holds the profile", () => js("return document.querySelector('#quit-dialog').open && !document.querySelector('#quit-discard').disabled;"));
      await click("#quit-discard");
      await eventually("Quit releases the workbench without receiving the profile lock", () => text("#toast"), value => /Recovery storage is busy/.test(value), 3500);
      await eventually("editing thaws before the profile holder releases its lock", () => js("return !document.querySelector('#open-folder').disabled;"));
      assert.equal((await current()).text, local);
    } finally { await fromPeer("return window.__ironTest.holdDraftProfile(false).then(() => true);"); }
    assert.ok((await records()).some(entry => entry.writer === captured.writer));
    await fromPeer("window.__ironTest.replace(arguments[0]); return true;", original + "\n// Independent writer newer draft.\n");
    const newer = await eventually("the live writer publishes its next revision", async () => (await records()).find(entry => entry.writer === captured.writer),
      entry => entry?.revision > captured.revision && !entry.detached);
    const errors = await fromPeer("return window.__ironTestRuntimeErrors();");
    runtimeClean(errors);
    await writeFile(path.join(peer.artifacts, "last-live.json"), JSON.stringify({ runtimeErrors: errors }));
    await observeBeforeCrash(peer.pid);
    process.kill(peer.pid, "SIGKILL");
    const exit = await Promise.race([peerExited, delay(6000, { timedOut: true }, { ref: false })]);
    assert.equal(exit.signal, "SIGKILL");
    await writeFile(path.join(peer.artifacts, "report.json"), JSON.stringify({
      version: 1, group: "recovery", cases: [{ name: "Independent left-behind writer", result: "pass" }],
      terminal: { action: "crash with completed draft", rendererObserved: "through last live checkpoint before requesting exit" },
    }));
    await eventually("the writer is detached after the actual second app exits", async () => (await records()).find(entry => entry.writer === captured.writer), entry => entry?.detached);
    assert.match(await tryRemove(captured), /record changed/);
    assert.equal(await tryRemove(newer), "");
    assert.deepEqual(new Set((await records()).map(entry => entry.writer)), previous);
    assert.equal(await readFile(file, "utf8"), original);
  });
  await record("refused and expired Quit leave the staged recovery data available", async () => {
    await eventually("a native draft exists before testing Quit", () => text("#draft-state"), value => /Draft saved/.test(value));
    for (const refuse of [true, false]) {
      const before = await js("return window.__ironTest.quitExpiry();");
      await js("return window.__ironTest.draftQuit(true).then(() => true);");
      try {
        await js("void window.__ironTest.quitMenu(); return true;");
        await eventually("Quit presents its ordinary discard choice", () => js("return document.querySelector('#quit-dialog').open && !document.querySelector('#quit-discard').disabled;"));
        await click("#quit-discard");
        await eventually("a draft index is staged before the final Quit decision", () => js("return window.__ironTest.draftQuit();"));
        if (!refuse) await eventually("the real Quit ticket expires while staged", () => js("return window.__ironTest.quitExpiry();"), value => value > before);
      } finally { await js("return window.__ironTest.draftQuit(false, arguments[0]).then(() => true);", refuse); }
      await eventually("the workbench thaws after the unsuccessful Quit", () => js("return !document.querySelector('#open-folder').disabled;"));
      assert.equal((await current()).text, local);
      assert.equal((await current()).dirty, true);
      await chooseCommand("recover drafts");
      await eventually("both published drafts survived the unsuccessful Quit", () => js("return document.querySelectorAll('#draft-list .draft-row').length;"), count => count === 2);
      await click('[data-dialog-close="draft-dialog"]');
    }
  });
  await record("cancelled project switch retains the draft and ordinary Quit commits its retirement", async () => {
    await eventually("the recovered copy has a separate completed draft", () => text("#draft-state"), value => /Draft saved/.test(value));
    const rootId = await js("return window.__ironTest.workspaceId();");
    await js("return window.__ironTest.cancelNextPicker().then(() => true);");
    await openProjectControl("#open-folder");
    await eventually("the project confirms discard before the picker", () => text("#project-transition-continue"), value => /Discard and Continue/.test(value));
    await click("#project-transition-continue");
    await eventually("the cancelled picker leaves an editable workbench", () => js("return !document.querySelector('#open-folder').disabled;"));
    assert.equal(await js("return window.__ironTest.workspaceId();"), rootId);
    assert.equal((await current()).text, local);
    await chooseCommand("recover drafts");
    await eventually("both the crashed snapshot and its active copy remain", () => js("return document.querySelectorAll('#draft-list .draft-row').length;"), count => count === 2);
    await click('[data-dialog-close="draft-dialog"]');
    await js("void window.__ironTest.quitMenu(); return true;");
    await eventually("ordinary Quit requests a decision for the recovered buffer", () => js("return document.querySelector('#quit-dialog').open && !document.querySelector('#quit-discard').disabled;"));
    await terminalCheckpoint("discard recovery and Quit");
    try { await click("#quit-discard"); }
    catch (error) { if (error.cause?.code !== "UND_ERR_SOCKET") throw error; }
    const exit = await Promise.race([app.exited, delay(6000, { timedOut: true }, { ref: false })]);
    assert.equal(exit.code, 0);
    assert.equal(await readFile(file, "utf8"), original);
  });
}

async function nativeSaveQuit() {
  await record("native Save and Quit preserves the project on partial saves and expired tickets", async () => {
    const source = path.join(fixture, "cmd/orbit/main.go");
    const readme = path.join(fixture, "README.md");
    const original = 'package main\nimport ("fmt"; "os"; "time")\nfunc main(){fmt.Printf("save-quit-child %d\\n",os.Getpid());time.Sleep(time.Minute)}\n';
    await writeFile(source, original);
    await openProjectControl("#welcome-open");
    await eventually("the project and run target are ready", () => js("return document.querySelector('#run-target').value === './cmd/orbit' && !document.querySelector('#run').disabled;"));
    await click("#run");
    const ready = await eventually("the child runs", output, value => /save-quit-child \d+/.test(value), 30_000);
    const pid = Number(ready.match(/save-quit-child (\d+)/)[1]);
    const alive = () => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
    const mainTab = () => click('#tabs [data-path="cmd/orbit/main.go"]');
    const startQuit = async () => {
      requestNativeQuit();
      await eventually("a live Save and Quit choice opens", () => js("return document.querySelector('#quit-dialog').open && !document.querySelector('#quit-save').disabled;"));
    };
    const thawed = () => eventually("the same workbench accepts another decision", () => js("return !document.querySelector('#open-folder').disabled;"));
    const first = original + "\n// First commit before conflict\n";
    const diskReadme = await readFile(readme, "utf8");
    await replace(first);
    await click('#explorer [data-path="README.md"]');
    await eventually("README loaded", current, state => state?.path === "README.md");
    const dirtyReadme = diskReadme + "\nUnsaved second tab.\n";
    await replace(dirtyReadme);
    await writeFile(readme, diskReadme + "\nExternal conflict.\n");
    await startQuit();
    await click("#quit-save");
    await eventually("second file reports the save conflict", () => text("#toast"), value => /README\.md.*changed on disk/i.test(value));
    await thawed();
    assert.match(await output(), /Saved: cmd\/orbit\/main\.go/);
    assert.equal(await readFile(source, "utf8"), first);
    assert.equal((await current()).text, dirtyReadme);
    assert.equal(alive(), true);
    await startQuit();
    await click("#quit-cancel");
    await thawed();

    await writeFile(readme, diskReadme);
    const later = first + "// First admitted before expiry\n";
    await mainTab();
    await replace(later);
    await js("window.__batchHoldReady = false; void window.__ironTest.holdSave(true, 'cmd/orbit/main.go').then(() => window.__batchHoldReady = true); return true;");
    await eventually("the native save barrier is armed", () => js("return window.__batchHoldReady;"));
    await js("window.__expiryHoldReady = false; void window.__ironTest.quitDeadline(true).then(() => window.__expiryHoldReady = true); return true;");
    await eventually("the timeout callback is held independently", () => js("return window.__expiryHoldReady;"));
    try {
      const expiry = await js("return window.__ironTest.quitExpiry();");
      await startQuit();
      await click("#quit-save");
      await eventually("first Quit save is admitted and held", () => js(`
        if (!window.__batchAtBarrier) void window.__ironTest.holdSave().then(waiting => window.__batchAtBarrier = waiting);
        return !!window.__batchAtBarrier;
      `));
      const [expired] = await eventually("the pending native ticket reaches its deadline before callback delivery", () => js(`
        void window.__ironTest.quitDeadline().then(value => window.__pendingQuitDeadline = value);
        return window.__pendingQuitDeadline ?? null;
      `), value => value?.[1] === true);
      assert.equal(await js("return window.__ironTest.quitExpiry();"), expiry);
      await js(`window.__expiredSaveAdmission = null;
        void window.__ironTest.attemptQuitSave('README.md', arguments[0], arguments[1], arguments[2]).then(
          () => window.__expiredSaveAdmission = 'unexpected save', error => window.__expiredSaveAdmission = String(error));
        return true;`, diskReadme, dirtyReadme, expired);
      await eventually("the host rejects a queued save with the expired ticket", () => js("return window.__expiredSaveAdmission;"), value => /expired/i.test(value ?? ""));
      await js("void window.__ironTest.quitDeadline(false); return true;");
      await eventually("the timeout event still arrives for the held write", () => js("return window.__ironTest.quitExpiry();"), value => value > expiry);
      assert.equal(await readFile(source, "utf8"), first);
      assert.equal(alive(), true);
    } finally { await js("void window.__ironTest.quitDeadline(false); void window.__ironTest.holdSave(false); return true;"); }
    await thawed();
    assert.equal(await readFile(source, "utf8"), later);
    assert.equal(await readFile(readme, "utf8"), diskReadme);
    assert.equal(alive(), true);
    const final = later + "// Save and Quit completes both files\n";
    await replace(final);
    await startQuit();
    await terminalCheckpoint("dirty Save and Quit");
    try { await click("#quit-save"); }
    catch (error) { if (error.cause?.code !== "UND_ERR_SOCKET") throw error; }
    const result = await Promise.race([app.exited, delay(6000, { code: null, timedOut: true }, { ref: false })]);
    assert.equal(result.code, 0, "Save and Quit must exit normally");
    assert.equal(await readFile(source, "utf8"), final);
    assert.equal(await readFile(readme, "utf8"), dirtyReadme);
    await eventually("successful native Quit stops the Go child", () => !alive());
  });
}

async function nativeQuitSmoke() {
  await record("native Quit asks before discarding a dirty Go buffer", async () => {
    const source = path.join(fixture, "cmd/orbit/main.go");
    await writeFile(source, 'package main\nimport ("fmt"; "os"; "time")\nfunc main(){fmt.Printf("quit-child-ready %d\\n",os.Getpid());time.Sleep(time.Minute)}\n');
    await openProjectControl("#welcome-open");
    const initial = await eventually("disposable project open", current, state => state?.path === "cmd/orbit/main.go");
    await eventually("Go target ready", () => js("return document.querySelector('#run-target').value === './cmd/orbit' && !document.querySelector('#run').disabled;"));
    await click("#run");
    const ready = await eventually("fixture child is running", output, value => /quit-child-ready \d+/.test(value), 30_000);
    const pid = Number(ready.match(/quit-child-ready (\d+)/)[1]);
    const saved = `${initial.text}\n// saved after the held IPC\n`;
    const unsaved = `${saved}\n// unsaved native quit\n`;
    const alive = () => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
    async function cancelled(label) {
      await Promise.race([
        eventually(`${label}: display the real confirmation`, () => js("return document.querySelector('#quit-dialog')?.open === true;")),
        app.exited.then(() => { throw new Error(`${label}: exited before confirming the unsaved buffer.`); }),
      ]);
      await js("window.__ironTest.tryType('unexpected edit'); return true;");
      assert.equal((await current()).text, unsaved, `${label}: the pending decision must prevent typing`);
      await click("#quit-cancel");
      await eventually(`${label}: editing re-enabled`, () => js("return !document.querySelector('#open-folder').disabled;"));
      const state = await current();
      assert.equal(state.text, unsaved);
      assert.equal(state.dirty, true);
      assert.equal(await readFile(source, "utf8"), saved);
      assert.equal(alive(), true, `${label}: cancelling must not stop the Go child`);
      console.log(`    ${label}: Cancel preserved the buffer and child`);
    }
    // The parent owns failure cleanup, even if this worker never returns.
    {
      await js("window.__saveHoldReady = false; void window.__ironTest.holdSave(true).then(() => window.__saveHoldReady = true); return true;");
      await eventually("native save barrier armed", () => js("return window.__saveHoldReady;"));
      await replace(saved);
      await click("#save");
      await eventually("save_file IPC has reached its native barrier", () => js(`
        if (!window.__saveAtBarrier) void window.__ironTest.holdSave().then(waiting => window.__saveAtBarrier = waiting);
        return window.__saveAtBarrier === true && window.__ironTest.saving();
      `));
      const beforeSaveQuit = await js("return window.__ironTest.quitRequests();");
      requestNativeQuit();
      await Promise.race([
        eventually("Quit reaches the workbench during a held save", () => js("return window.__ironTest.quitRequests();"), count => count === beforeSaveQuit + 1),
        app.exited.then(() => { throw new Error("An in-flight save must veto application exit."); }),
      ]);
      assert.equal(await js("return document.querySelector('#quit-dialog').open;"), false);
      assert.equal(await js("return window.__ironTest.saving();"), true);
      assert.equal(await readFile(source, "utf8"), initial.text);
      await js("void window.__ironTest.holdSave(false); return true;");
      await eventually("held save completes after Quit was refused", current, state => state?.text === saved && !state.dirty);
      assert.equal(await readFile(source, "utf8"), saved);
      console.log("    Quit during the held native save was refused");

      await replace(unsaved);
      await eventually("buffer is dirty", current, state => state?.dirty);
      requestNativeQuit();
      await cancelled("System Quit");

      const readMinimizedQuit = () => js(`
        return { menu: window.__menuQuit, requests: window.__ironTest.quitRequests(),
          window: window.__nativeWindowState, dialog: document.querySelector('#quit-dialog').open,
          ready: !document.querySelector('#quit-discard').disabled };
      `);
      const observeWindow = () => js(`
        void window.__ironTest.quitWindowState().then(state => window.__nativeWindowState = state);
        return true;
      `);
      await js("window.__nativeWindowState = null; void window.__ironTest.quitWindowState(true); return true;");
      const minimized = await eventually("AppKit minimized the dirty window", async () => {
        await observeWindow();
        return readMinimizedQuit();
      }, result => result?.window?.[0] === true && result.window[1] === false);
      let restored;
      try {
        await js("window.__menuQuit = null; void window.__ironTest.quitMenu().then(found => window.__menuQuit = found).catch(error => window.__menuQuit = String(error)); return true;");
        restored = await eventually("Quit menu restores the minimized window with a usable confirmation", async () => {
          await observeWindow();
          return readMinimizedQuit();
        }, result => result?.menu === true && result.requests === minimized.requests + 1 &&
          result.window?.[0] === false && result.window[1] === true && result.dialog && result.ready);
        await cancelled("Quit menu with minimized window");
      } finally {
        const last = await readMinimizedQuit().catch(error => ({ error: String(error) }));
        await writeFile(path.join(artifacts, "minimized-quit.json"), JSON.stringify({ minimized, restored, last }, null, 2));
      }

      await js("window.__menuQuit = null; void window.__ironTest.quitMenu().then(found => window.__menuQuit = found).catch(error => window.__menuQuit = String(error)); return true;");
      await eventually("default AppKit Quit menu action invoked", () => js("return { result: window.__menuQuit, requests: window.__ironTest.quitRequests(), dialog: document.querySelector('#quit-dialog').open };"), state => state?.result === true);
      await cancelled("Quit menu");

      await js("void window.__ironTest.closeWindow(); return true;");
      await cancelled("Native window close");

      requestNativeQuit();
      await eventually("unanswered Quit dialog is usable", () => js(`
        return document.querySelector('#quit-dialog').open && !document.querySelector('#quit-discard').disabled;
      `));
      await eventually("the real timeout dismisses the dialog and restores editing", () => js("return !document.querySelector('#quit-dialog').open && !document.querySelector('#open-folder').disabled;"));
      assert.equal((await current()).text, unsaved);
      assert.equal(alive(), true, "expiry leaves the Go process alone");
      requestNativeQuit();
      await cancelled("Retry after missing reply");

      requestNativeQuit();
      await eventually("Discard is available", () => js("return document.querySelector('#quit-dialog').open && !document.querySelector('#quit-discard').disabled;"));
      await terminalCheckpoint("dirty Discard");
      try { await click("#quit-discard"); }
      catch (error) {
        // A successful Discard can exit before the embedded driver sends
        // the HTTP acknowledgement. Only allow that transport shutdown
        // here, and still require the real child process to exit with 0.
        if (error.cause?.code !== "UND_ERR_SOCKET") throw error;
      }
      const result = await Promise.race([app.exited, delay(6000, { code: null, timedOut: true }, { ref: false })]);
      assert.equal(result.code, 0, "approving Discard should exit normally");
      assert.equal(await readFile(source, "utf8"), saved);
      await eventually("approved exit stops the Go child", () => !alive());
    }
  });
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

async function lifecycleSuite() {
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
  await record("native File menu can start a New Project from Welcome", async () => {
    await eventually("native New Project is enabled", () => js("return window.__ironTest.menuItem('File', 'New Project…');"), value => value === true);
    assert.equal(await js("return window.__ironTest.menuItem('File', 'Close Project');"), false);
    assert.equal(await js("return window.__ironTest.menuItem('File', 'New Project…', true);"), true);
    await eventually("the existing project form opens", () => js("return document.querySelector('#form-dialog').open;"));
    assert.equal(await text("#form-title"), "New Project");
    await click('[data-dialog-close="form-dialog"]');
    assert.equal((await current()).root ?? null, null);
    await eventually("native New Project is enabled again after Cancel", () => js("return window.__ironTest.menuItem('File', 'New Project…');"), value => value === true);
    assert.equal(await js("return window.__ironTest.menuItem('File', 'New Project…', true);"), true);
    await eventually("the project form reopens", () => js("return document.querySelector('#form-dialog').open;"));
    await set("#form-name", "native-menu-go");
    await set("#form-module", "example.com/native-menu-go");
    await click("#form-submit");
    const root = path.join(path.dirname(fixture), "native-menu-go");
    await eventually("the new project is open", current, entry => entry?.root === root && entry.path === "main.go");
    assert.match(await readFile(path.join(root, "go.mod"), "utf8"), /^module example\.com\/native-menu-go/m);
    await eventually("native Close Project becomes enabled", () => js("return window.__ironTest.menuItem('File', 'Close Project');"), value => value === true);
    assert.equal(await js("return window.__ironTest.menuItem('File', 'Close Project', true);"), true);
    await eventually("native Close Project returns to Welcome", () => js("return !document.querySelector('#project-welcome').hidden;"));
  });
  await record("native chrome suppresses browser-only keys, not editor keys", async () => {
    const result = await js(`
      const keys = [
        {key:'r',metaKey:true}, {key:'R',metaKey:true,shiftKey:true}, {key:'F5'},
        {key:'l',metaKey:true}, {key:'=',metaKey:true}, {key:'-',metaKey:true}, {key:'0',metaKey:true},
        {key:'=',code:'Equal',metaKey:true,shiftKey:true}, {key:'+',code:'Equal',metaKey:true,shiftKey:true},
        {key:'-',code:'Minus',metaKey:true,shiftKey:true}, {key:'f',metaKey:true}, {key:'[',metaKey:true},
        {key:'c',metaKey:true}, {key:'ArrowLeft',altKey:true},
      ];
      return keys.map(options => {
        const event = new KeyboardEvent('keydown', {...options,bubbles:true,cancelable:true});
        document.dispatchEvent(event); return event.defaultPrevented;
      });
    `);
    assert.deepEqual(result, [true, true, true, true, true, true, true, true, true, false, false, false, false, false]);
  });
  await record("native workbench opens a disposable folder", async () => {
    const state = await openOrbit();
    assert.equal(state.text, await readFile(path.join(fixture, "cmd/orbit/main.go"), "utf8"));
    assert.equal(await text("#module-name"), "example.com/orbit");
    await eventually("Go toolchain reported", () => text("#tool-version"), value => /go?\s*\d+\.\d+/i.test(value));
    await eventually("sole executable selected without typing", () => js("return document.querySelector('#run-target')?.value;"), value => value === "./cmd/orbit", 5000);
  });
  await record("Project Actions refreshes the tree and Go targets without a second button", async () => {
    assert.equal(await js("return !!document.querySelector('#refresh-files');"), false);
    await addWaitTarget();
    await refreshThroughProjectActions();
    await eventually("new executable discovered after menu refresh", () => js("return [...document.querySelector('#run-target').options].some(option => option.value === './cmd/wait');"));
    await eventually("new package appears in expanded Go tree", () => js("return !!document.querySelector('#explorer [data-path=\"cmd/wait\"]');"));
    await click('#explorer [data-path="cmd/wait"]');
    await eventually("new source appears in the expanded package", () => js("return !!document.querySelector('#explorer [data-path=\"cmd/wait/entry.go\"]');"));
  });
  await record("Go toolchain status stays visible without a second Settings control", async () => {
    const status = await js(`const el = document.querySelector('#tool-status');
      return { tag: el.tagName, tabIndex: el.tabIndex, version: el.textContent, visible: el.getBoundingClientRect().width > 0 };`);
    assert.deepEqual({ ...status, version: undefined }, { tag: "SPAN", tabIndex: -1, version: undefined, visible: true });
    assert.match(status.version, /Go \d+\.\d+/);
    await click("#settings");
    await click("#probe-tools");
    await eventually("probe completes in Settings", () => js("return !document.querySelector('#probe-tools').disabled;"));
    assert.equal(await text("#tool-version"), status.version);
    await click('[data-dialog-close="settings-dialog"]');
  });
  await lifecycleTransitions();
}

async function fileSuite() {
  const source = path.join(fixture, "cmd/orbit/main.go");
  const original = await readFile(source, "utf8");
  const profileLock = path.join(home, "Library/Application Support/dev.irongo.e2e/save.lock");
  let lockInode;
  await openOrbit();
  await record("native compact chrome gives the editor more room without clipping controls", async () => {
    const assertIconCenters = async () => {
      const positions = await js(`return [...document.querySelectorAll('button.activity, button.icon-button')].flatMap(button => {
        const svg = button.querySelector('svg');
        const rect = button.getBoundingClientRect();
        if (!svg || !rect.width || !rect.height) return [];
        const icon = svg.getBoundingClientRect();
        return [{ name: button.id || button.getAttribute('aria-label'), activity: button.matches('.activity'), height: rect.height,
          x: icon.x + icon.width / 2 - rect.x - rect.width / 2,
          y: icon.y + icon.height / 2 - rect.y - rect.height / 2 }];
      });`);
      assert.equal(positions.filter(icon => icon.activity).length, 4, "measure every activity icon");
      for (const { name, activity, height, x, y } of positions) {
        if (activity) assert.equal(height, 36, `${name}: button keeps its 36px hit area`);
        assert.ok(Math.abs(x) <= 0.5 && Math.abs(y) <= 0.5,
          `${name}: icon is ${x}px horizontally and ${y}px vertically from center`);
      }
    };
    const dimensions = () => js(`
      const box = selector => document.querySelector(selector).getBoundingClientRect();
      const editor = box('#editor');
      return { viewport: innerWidth, height: innerHeight, rail: box('.activity-bar').width, side: box('#sidebar').width,
        divider: box('#sidebar-resize').width, editor: [editor.width, editor.height], header: box('#editor-toolbar').height,
        breadcrumb: box('#breadcrumbs').height, panelHeader: box('.panel-header').height, select: box('#run-target').height,
        close: [box('.tab-close').width, box('.tab-close').height], panel: box('#panel').height };
    `);
    for (const [width, height, rail, side, editorWidth] of [[1320, 820, 44, 220, 1055], [760, 600, 36, 196, 527]]) {
      await js("void window.__ironTest.resize(arguments[0], arguments[1]); return true;", width, height);
      // macOS may cap the height to the current display's available frame.
      const size = await eventually("window reaches requested width", dimensions, r => r.viewport === width && r.height <= height);
      const panel = Math.max(112, Math.min(214, size.height * .31 - 66));
      const editorHeight = size.height - 36 - 28 - 32 - 22 - panel - 1;
      assert.equal(size.rail, rail);
      assert.equal(size.side, side);
      assert.equal(size.divider, 1);
      assert.equal(size.editor[0], editorWidth);
      assert.ok(Math.abs(size.editor[1] - editorHeight) < 0.1);
      assert.ok(Math.abs(size.panel - panel) < 0.1);
      assert.deepEqual([size.header, size.breadcrumb, size.panelHeader, size.select, ...size.close], [32, 22, 32, 26, 24, 24]);
      await assertIconCenters();
    }
    await click("#toggle-sidebar");
    const collapsed = await dimensions();
    assert.deepEqual([collapsed.rail, collapsed.side, collapsed.divider, collapsed.editor[0]], [36, 0, 0, 724]);
    await assertIconCenters();
    await assertLineAlignment();
    await click("#toggle-sidebar");
    await assertLineAlignment();
    await click('[data-view="search"]');
    assert.equal(await js("return document.querySelector('#search-case').getBoundingClientRect().height;"), 24);
    await click('[data-view="explorer"]');
  });
  await record("native bottom panel has one persistent toggle and keeps focus reachable", async () => {
    const state = () => js(`return {
      shown: !document.querySelector('#panel').hidden,
      pressed: document.querySelector('#toggle-panel').getAttribute('aria-pressed'),
      focus: document.activeElement?.id,
      problems: document.querySelector('#problems-tab').getAttribute('aria-selected'),
      duplicate: !!document.querySelector('#hide-panel, .output-source')
    };`);
    const shortcut = () => js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true, bubbles: true, cancelable: true })); return true;");
    assert.equal((await state()).duplicate, false);
    await click("#toggle-panel");
    await eventually("title toggle hides bottom panel", state, result => !result.shown && result.pressed === "false");
    await shortcut();
    await eventually("keyboard shortcut shows bottom panel", state, result => result.shown && result.pressed === "true");
    await click("#problems-tab");
    await js("document.querySelector('#problems-tab').focus(); return true;");
    await shortcut();
    await eventually("focus moves from hidden tab to visible toggle", state, result => !result.shown && result.focus === "toggle-panel");
    await click("#status-problems");
    await eventually("status Problems opens the correct tab", state, result => result.shown && result.problems === "true");
    await click("#output-tab");
  });
  await checkTheme();
  await record("native editor loads bundled JetBrains Mono and applies typography settings", async () => {
    const appearance = () => js(`
      const row = document.querySelector('#editor .view-line');
      if (!row) return null;
      const { fontFamily, fontSize } = getComputedStyle(row);
      const loaded = [...document.fonts].some(face => face.family.replaceAll('"', '') === 'JetBrains Mono' && face.status === 'loaded');
      return { fontFamily, fontSize, height: row.getBoundingClientRect().height, loaded };
    `);
    await eventually("bundled font at the default size", appearance,
      value => value?.loaded && /^"?JetBrains Mono/.test(value.fontFamily) && value.fontSize === "13px" && value.height === 18);
    const set = (id, value) => js(`
      const field = document.getElementById(arguments[0]);
      field.value = arguments[1];
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `, id, value);
    await click("#settings");
    await set("editor-font", "system");
    await set("editor-font-size", "16");
    await eventually("larger system monospace editor", appearance,
      value => /^"?SF Mono/.test(value?.fontFamily) && value.fontSize === "16px" && value.height === 22);
    await set("editor-font", "jetbrains");
    await set("editor-font-size", "13");
    await click('[data-dialog-close="settings-dialog"]');
  });
  await record("native Go syntax roles change in place without dropping the buffer", async () => {
    await replace(goSyntaxSample);
    for (const theme of ["dark", "light"]) {
      await setNativeTheme(theme);
      await eventually(`${theme} rendered Go token colors`, () => js(`return (${renderedGoSyntax.toString()})();`),
        colors => Object.entries(expectedGoSyntax[theme]).every(([role, color]) => colors?.[role] === color));
      const state = await current();
      assert.equal(state.text, goSyntaxSample);
      assert.equal(state.dirty, true);
      assert.equal(await readFile(source, "utf8"), original);
    }
    await setNativeTheme("dark");
    await replace(original);
  });

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
    const lock = await stat(profileLock, { bigint: true });
    assert.ok(lock.isFile(), "the save lock belongs to the disposable app profile");
    lockInode = lock.ino;
  });

  await record("explicit format-on-save preserves exact disk encoding and remains undoable", async () => {
    const relative = "format_save.go";
    const disk = path.join(fixture, relative);
    const initial = "package formatfixture\r\nfunc Value() int{return 1}\r\n";
    const ordinary = initial.replace("return 1", "return 2");
    const submitted = initial.replace("return 1", "return  3");
    const formatted = "package formatfixture\r\n\r\nfunc Value() int { return 3 }\r\n";
    const bom = "\ufeff";
    await writeFile(disk, bom + initial);
    await eventually("format fixture appears", () => js("return !!document.querySelector('#explorer [data-path=\"format_save.go\"]');"));
    await click('#explorer [data-path="format_save.go"]');
    await eventually("format fixture is active", current, state => state?.path === relative);
    await replace(ordinary);
    await click("#save");
    await eventually("formatting is off by default", () => readFile(disk, "utf8"), bytes => bytes === bom + ordinary);
    await eventually("ordinary save is clean", current, state => !state.dirty);
    const toggle = async () => {
      await click("#settings");
      await click("#format-save-setting");
      await click('[data-dialog-close="settings-dialog"]');
    };
    await toggle();
    try {
      await replace(submitted);
      await click("#save");
      await eventually("gofmt writes the original BOM and CRLF convention", () => readFile(disk, "utf8"), bytes => bytes === bom + formatted);
      await eventually("the live model matches the committed snapshot", current, state => state?.text === bom + formatted && !state.dirty);
      await js("window.__ironTest.action('undo', 1, 1); return true;");
      await eventually("Undo restores only the original buffer bytes", current, state => state?.text === bom + submitted && state.dirty);
      assert.equal(await readFile(disk, "utf8"), bom + formatted);
      await js("window.__ironTest.action('redo', 1, 1); return true;");
      await eventually("Redo returns to the saved formatting", current, state => state?.text === bom + formatted && !state.dirty);
      const invalid = formatted + "func {\r\n";
      await replace(invalid);
      await js(`document.querySelector('#save').click(); document.querySelector('#tabs [data-path="cmd/orbit/main.go"]').click(); return true;`);
      await eventually("invalid Go reports its source after switching tabs", () => text("#toast"), value => /format_save\.go.*Save Without Formatting/s.test(value));
      assert.equal(await readFile(disk, "utf8"), bom + formatted);
      assert.equal((await current()).path, "cmd/orbit/main.go");
      await click('#tabs [data-path="format_save.go"]');
      assert.equal((await current()).text, bom + invalid);
      await chooseCommand("save without formatting");
      await eventually("the explicit bypass writes the exact original bytes", () => readFile(disk, "utf8"), bytes => bytes === bom + invalid);
      await eventually("the bypass finishes", current, state => !state.dirty);
      const sibling = path.join(fixture, "format_sibling.go");
      const third = path.join(fixture, "format_third.go");
      const siblingSource = "package formatfixture\nfunc Sibling() int{return 1}\n";
      const siblingFormatted = "package formatfixture\n\nfunc Sibling() int { return 2 }\n";
      const thirdSource = "package formatfixture\nfunc Third() int{return 1}\n";
      await writeFile(sibling, siblingSource);
      await writeFile(third, thirdSource);
      const siblingRow = '#explorer [data-path="format_sibling.go"]';
      await eventually("the second Go file appears", () => js("return !!document.querySelector(arguments[0]);", siblingRow));
      await click(siblingRow);
      await eventually("the second Go file is active", current, state => state?.path === "format_sibling.go");
      await replace(siblingSource.replace("return 1", "return  2"));
      const thirdRow = '#explorer [data-path="format_third.go"]';
      await eventually("the third Go file appears", () => js("return !!document.querySelector(arguments[0]);", thirdRow));
      await click(thirdRow);
      await eventually("the third Go file is active", current, state => state?.path === "format_third.go");
      await replace(thirdSource.replace("return 1", "return  2"));
      await click('#tabs [data-path="format_save.go"]');
      await eventually("the original Go file is active again", current, state => state?.path === relative);
      await replace(submitted);
      await js(`window.__formatBatchHoldReady = false;
        void window.__ironTest.holdSave(true, 'format_sibling.go').then(() => window.__formatBatchHoldReady = true); return true;`);
      await eventually("the second file hold is armed", () => js("return window.__formatBatchHoldReady;"));
      const later = formatted + "// newer edit during Save All\r\n";
      try {
        await chooseCommand("save all");
        await eventually("Save All gets past its own formatting and admits the second file", () => js(`
          if (!window.__formatBatchAtBarrier) void window.__ironTest.holdSave().then(waiting => window.__formatBatchAtBarrier = waiting);
          return !!window.__formatBatchAtBarrier;
        `));
        assert.equal(await readFile(disk, "utf8"), bom + formatted);
        assert.equal((await current()).path, relative);
        await replace(later);
      } finally { await js("void window.__ironTest.holdSave(false); return true;"); }
      await eventually("the batch reports the two committed paths", output, value => /Saved: format_save\.go, format_sibling\.go/.test(value));
      assert.equal(await readFile(sibling, "utf8"), siblingFormatted);
      assert.equal(await readFile(third, "utf8"), thirdSource);
      assert.equal((await current()).text, bom + later);
      assert.equal((await current()).dirty, true);
      await replace(formatted);
      await click('#tabs [data-path="format_sibling.go"]');
      await eventually("the formerly inactive tab received its own formatted snapshot", current,
        state => state?.path === "format_sibling.go" && state.text === siblingFormatted && !state.dirty);
      await rename(sibling, path.join(fixture, "format-save-sibling.txt"));
      await click('#tabs [data-path="format_third.go"]');
      await eventually("the untouched third target is active", current, state => state?.path === "format_third.go");
      await replace(thirdSource);
      await rename(third, path.join(fixture, "format-save-third.txt"));
    } finally { await toggle(); }
    await rename(disk, path.join(fixture, "format-save-sample.txt"));
    await click('#tabs [data-path="cmd/orbit/main.go"]');
  });
  await record("protects externally edited files from overwrite", async () => {
    const saved = await readFile(source, "utf8");
    const external = saved + "\n// External change\n";
    await replace(saved + "\n// Unsaved buffer\n");
    await writeFile(source, external);
    await click("#save");
    await eventually("save conflict message", () => text("#toast"), value => value.includes("changed on disk"));
    assert.equal(await readFile(source, "utf8"), external);
    assert.equal((await stat(profileLock, { bigint: true })).ino, lockInode, "save attempts must retain the profile lock inode");
    const prompt = () => eventually("reload confirmation is visible", () => js("return document.querySelector('#file-decision-dialog')?.open;"));
    const settled = () => eventually("file decision settles", () => js("return !document.querySelector('#save').disabled;"));
    await chooseCommand("reload file from disk");
    await prompt();
    await click("#file-decision-cancel");
    await settled();
    const unsaved = (await current()).text;
    assert.match(unsaved, /Unsaved buffer/);
    await chooseCommand("reload file from disk");
    await prompt();
    const newer = unsaved + "\n// Changed while the question was open\n";
    await replace(newer);
    await click("#file-decision-discard");
    await settled();
    assert.equal((await current()).text, newer);
    await chooseCommand("reload file from disk");
    await prompt();
    await click("#file-decision-discard");
    await eventually("confirmed reload reads the real disk", current, state => state?.text === external && !state.dirty);
  });
  await record("native external edits reconcile clean, dirty, and missing tabs", async () => {
    const readme = path.join(fixture, "README.md");
    const readmeText = await readFile(readme, "utf8");
    const savedGo = await readFile(source, "utf8");
    const goPath = '#tabs [data-path="cmd/orbit/main.go"]';
    const readmePath = '#tabs [data-path="README.md"]';
    const select = async (selector, relative) => {
      await click(selector);
      await eventually(`${relative} is active`, current, state => state?.path === relative);
    };
    const diskState = (selector, state) => eventually(`tab marks ${state || "no"} disk change`, () => js(`
      return document.querySelector(arguments[0])?.closest('.tab')?.dataset.diskChange ?? '';
    `, selector), value => value === state);
    const dirty = savedGo + "\n// Unsaved while another editor writes\n";
    const externalGo = savedGo + "\n// Written by another editor\n";
    const externalReadme = readmeText + "\nUpdated outside Iron Go.\n";
    await select(goPath, "cmd/orbit/main.go");
    await replace(dirty);
    await select('#explorer [data-path="README.md"]', "README.md");
    try {
      await click("#quick-open");
      await set("#palette-text", "externally-added.txt");
      assert.match(await text("#palette-options"), /no matching entries/i);
      await Promise.all([
        writeFile(readme, externalReadme),
        writeFile(source, externalGo),
        writeFile(path.join(fixture, "externally-added.txt"), "Created outside Iron Go.\n"),
      ]);
      await eventually("clean buffer automatically reloads", current, state => state?.text === externalReadme && !state.dirty);
      await eventually("the external file appears in the tree", () => js(`return !!document.querySelector('#explorer [data-path="externally-added.txt"]');`));
      await eventually("the external file appears in the already open Quick Open", () => text("#palette-options"), value => value.includes("externally-added.txt"));
      await click("#palette-options button");
      await diskState(goPath, "changed");
      await select(goPath, "cmd/orbit/main.go");
      assert.equal((await current()).text, dirty);
      assert.match(await text("#disk-change"), /changed on disk/i);
      assert.equal(await readFile(source, "utf8"), externalGo);
      await writeFile(source, savedGo);
      await diskState(goPath, "");
      await replace(savedGo);
      await eventually("restoring the buffer makes it clean", current, state => !state.dirty);

      await select(readmePath, "README.md");
      await rename(readme, path.join(fixture, "external-readme-backup.md"));
      await diskState(readmePath, "missing");
      assert.equal((await current()).text, externalReadme);
      await mkdir(readme);
      await diskState(readmePath, "unavailable");
      assert.equal((await current()).text, externalReadme);
      await rename(readme, path.join(fixture, "external-readme-directory"));
      await writeFile(readme, readmeText);
      await eventually("the recreated clean file is adopted", current, state => state?.text === readmeText && !state.dirty);
      await diskState(readmePath, "");
    } finally { await select(goPath, "cmd/orbit/main.go"); }
  });
  await record("native dirty tab close targets the intended buffer without stealing focus", async () => {
    const readme = path.join(fixture, "README.md");
    const originalReadme = await readFile(readme, "utf8");
    const goTab = '#tabs [data-path="cmd/orbit/main.go"]';
    const tab = '.tab[data-tab-path="README.md"]';
    const close = `${tab} .tab-close`;
    const open = async () => {
      await click('#explorer [data-path="README.md"]');
      await eventually("README is active", current, state => state?.path === "README.md");
    };
    const ask = async () => {
      await js("const button = document.querySelector(arguments[0]); button.focus(); button.click(); return true;", close);
      await eventually("a real close decision names README", () => js(`
        const dialog = document.querySelector('#file-decision-dialog');
        return dialog?.open && dialog.textContent.includes('README.md');
      `));
    };
    const ready = () => eventually("the decision is settled", () => js("return !document.querySelector('#save').disabled;"));
    const edited = originalReadme + "\nSave this inactive tab.\n";
    await open();
    await replace(edited);
    await js("document.querySelector('#tabs [data-path=\"README.md\"]').focus(); document.querySelector(arguments[0]).click(); return true;", close);
    await eventually("the tab label opens the close decision", () => js("return document.querySelector('#file-decision-dialog').open;"));
    await replace(originalReadme);
    await click("#file-decision-cancel");
    await ready();
    assert.equal(await js("return document.activeElement?.dataset.path ?? document.activeElement?.tagName;"), "README.md");
    await replace(edited);
    await click(goTab);
    await ask();
    const quitRequests = await js("return window.__ironTest.quitRequests();");
    await js("void window.__ironTest.quitMenu(); return true;");
    await eventually("Quit reaches the workbench during a pending file decision", () => js("return window.__ironTest.quitRequests();"), count => count === quitRequests + 1);
    assert.equal(await js("return document.querySelector('#quit-dialog').open;"), false);
    await click("#file-decision-cancel");
    await ready();
    assert.equal(await readFile(readme, "utf8"), originalReadme);
    await ask();
    await click("#file-decision-save");
    await eventually("the inactive saved tab closes", () => js("return !document.querySelector(arguments[0]);", tab));
    assert.equal((await current()).path, "cmd/orbit/main.go");
    assert.equal(await readFile(readme, "utf8"), edited);

    await open();
    await replace(edited + "\nSave with a focus move.\n");
    await js("window.__closeHoldReady = false; void window.__ironTest.holdSave(true).then(() => window.__closeHoldReady = true); return true;");
    await eventually("tab save hold enabled", () => js("return window.__closeHoldReady;"));
    try {
      await ask();
      await click("#file-decision-save");
      await eventually("tab close waits for the save", () => js(`
        if (!window.__closeAtBarrier) void window.__ironTest.holdSave().then(waiting => window.__closeAtBarrier = waiting);
        return !!window.__closeAtBarrier;
      `));
      await js("document.querySelector('#explorer .explorer-root').focus(); return true;");
    } finally { await js("void window.__ironTest.holdSave(false); return true;"); }
    await eventually("active saved tab closes", () => js("return !document.querySelector(arguments[0]);", tab));
    assert.equal(await js("return document.activeElement?.matches('#explorer .explorer-root');"), true);

    await open();
    const captured = (await current()).text + "\nFirst submitted edit.\n";
    const typed = captured + "More text typed during Save and Close.\n";
    await replace(captured);
    await js("window.__closeHoldReady = false; window.__closeAtBarrier = false; void window.__ironTest.holdSave(true).then(() => window.__closeHoldReady = true); return true;");
    await eventually("the second close hold is enabled", () => js("return window.__closeHoldReady;"));
    try {
      await ask();
      await click("#file-decision-save");
      await eventually("the second close save is admitted", () => js(`
        if (!window.__closeAtBarrier) void window.__ironTest.holdSave().then(waiting => window.__closeAtBarrier = waiting);
        return !!window.__closeAtBarrier;
      `));
      await js("window.__ironTest.revealLine(arguments[0]); window.__ironTest.tryType(arguments[1]); return true;",
        captured.split("\n").length, "More text typed during Save and Close.\n");
      await eventually("the user can type while Save and Close is held", current, state => state?.text === typed);
    } finally { await js("void window.__ironTest.holdSave(false); return true;"); }
    await ready();
    assert.equal((await current()).text, typed);
    assert.equal((await current()).dirty, true);
    assert.equal(await readFile(readme, "utf8"), captured);

    await open();
    const replacement = await readFile(readme, "utf8");
    const dirty = replacement + "\nDo not discard on failure.\n";
    await replace(dirty);
    await writeFile(readme, replacement + "\nExternal conflict.\n");
    await ask();
    await click("#file-decision-save");
    await eventually("the failed close reports the conflict", () => text("#toast"), value => /changed on disk/i.test(value));
    await ready();
    assert.equal((await current()).text, dirty);
    await ask();
    await click("#file-decision-discard");
    await eventually("discard closes the affected tab", () => js("return !document.querySelector(arguments[0]);", tab));
    assert.equal(await readFile(readme, "utf8"), replacement + "\nExternal conflict.\n");
  });
  await record("standalone Save All stops admitting files after a previously saved tab becomes dirty", async () => {
    const paths = ["batch-first.txt", "batch-second.txt", "batch-third.txt"];
    await Promise.all(paths.map(file => writeFile(path.join(fixture, file), "original\n")));
    for (const file of paths) {
      const selector = `#explorer [data-path="${file}"]`;
      await eventually(`${file} is in the tree`, () => js("return !!document.querySelector(arguments[0]);", selector));
      await click(selector);
      await eventually(`${file} is active`, current, state => state?.path === file);
      await replace(`new ${file}\n`);
    }
    await js(`window.__standaloneHoldReady = false;
      void window.__ironTest.holdSave(true, 'batch-second.txt').then(() => window.__standaloneHoldReady = true); return true;`);
    await eventually("the second file's save hold is armed", () => js("return window.__standaloneHoldReady;"));
    try {
      await chooseCommand("save all");
      await eventually("the second file is held", () => js(`
        if (!window.__standaloneAtBarrier) void window.__ironTest.holdSave().then(waiting => window.__standaloneAtBarrier = waiting);
        return !!window.__standaloneAtBarrier;
      `));
      await click('#tabs [data-path="batch-first.txt"]');
      await eventually("the already saved first file is active", current, state => state?.path === paths[0] && !state.dirty);
      await replace("newer first edit\n");
    } finally { await js("void window.__ironTest.holdSave(false); return true;"); }
    await eventually("Save All reports the interruption", () => text("#toast"), value => /Newer edits in batch-first\.txt/.test(value));
    assert.match(await output(), /Saved: batch-first\.txt, batch-second\.txt/);
    assert.equal(await readFile(path.join(fixture, paths[2]), "utf8"), "original\n");
    await chooseCommand("save all");
    await eventually("retry saves the third file", () => readFile(path.join(fixture, paths[2]), "utf8"), value => value === `new ${paths[2]}\n`);
  });
  await record("native disk comparison authorizes only the versions the user reviewed", async () => {
    await click('#tabs [data-path="cmd/orbit/main.go"]');
    await eventually("the Go file under comparison is active", current, state => state?.path === "cmd/orbit/main.go");
    const saved = await readFile(source, "utf8");
    const edited = saved + "\n// Reviewed editor version\n";
    const incoming = saved + "\n// Reviewed disk version\n";
    const visible = () => js("return document.querySelector('#disk-compare-dialog')?.open === true;");
    const compare = async () => {
      await click("#compare-disk");
      await eventually("the disk comparison captured a version and enabled its actions", () => js(`
        return document.querySelector('#disk-compare-dialog')?.open && !document.querySelector('#disk-compare-reload').disabled;
      `));
    };
    const settled = () => eventually("the file decision has settled", () => js("return !document.querySelector('#disk-compare-dialog')?.open && !document.querySelector('#save').disabled;"));
    const ready = () => eventually("the disk conflict is visible", () => text("#disk-change"), value => /changed on disk/i.test(value));
    await replace(edited);
    await writeFile(source, incoming);
    await ready();
    await compare();
    const sides = () => js(`return ['.editor.original', '.editor.modified'].map(selector =>
      document.querySelector('#disk-compare-view ' + selector + ' .view-lines')?.textContent ?? '');`);
    await eventually("the diff shows disk on the left and the captured editor on the right", sides,
      ([disk, buffer]) => /disk\s+version/.test(disk) && /editor\s+version/.test(buffer));
    await click("#disk-compare-cancel");
    await eventually("comparison closes without edits", visible, open => !open);
    await settled();
    assert.equal((await current()).text, edited);
    assert.equal(await readFile(source, "utf8"), incoming);

    await compare();
    const replacement = `${source}.replacement`;
    await writeFile(replacement, incoming);
    await rename(replacement, source);
    await click("#disk-compare-save");
    await eventually("same-byte replacement invalidates the reviewed save", () => text("#toast"), value => /compare again/i.test(value));
    await settled();
    assert.equal((await current()).text, edited);
    assert.equal(await readFile(source, "utf8"), incoming);

    await compare();
    const newerDisk = incoming + "// Newer disk write\n";
    await writeFile(source, newerDisk);
    await click("#disk-compare-reload");
    await eventually("a newer write invalidates the reviewed reload", () => text("#toast"), value => /before reloading/i.test(value));
    await settled();
    assert.equal((await current()).text, edited);
    await compare();
    const newerEdit = edited + "// Newer buffer edit\n";
    await replace(newerEdit);
    await click("#disk-compare-reload");
    await eventually("old review cannot discard a newer buffer", () => text("#toast"), value => /editor.*changed/i.test(value));
    await settled();
    assert.equal((await current()).text, newerEdit);
    await compare();
    await click("#disk-compare-reload");
    await eventually("a current review can adopt the observed disk bytes", current, state => state?.text === newerDisk && !state.dirty);

    await replace(edited);
    await writeFile(source, incoming);
    await ready();
    await compare();
    await click("#disk-compare-save");
    await eventually("a current review can save the editor bytes", () => readFile(source, "utf8"), value => value === edited);
    await eventually("the reviewed save advances the baseline", current, state => state?.text === edited && !state.dirty);

    const intendedSave = edited + "// Captured before the held save\n";
    const typedDuringSave = intendedSave + "// Typed during save\n";
    const crlf = edited.replaceAll("\n", "\r\n");
    await replace(intendedSave);
    await writeFile(source, crlf);
    await ready();
    await compare();
    await eventually("the review identifies line-ending-only disk changes", () => text("#disk-compare-original"), value => value.includes("CRLF"));
    assert.match(await text("#disk-compare-modified"), /· LF$/);
    await js("window.__reviewHoldReady = false; void window.__ironTest.holdSave(true).then(() => window.__reviewHoldReady = true); return true;");
    await eventually("reviewed save barrier enabled", () => js("return window.__reviewHoldReady;"));
    try {
      await click("#disk-compare-save");
      await eventually("reviewed save is waiting at the native barrier", () => js(`
        if (!window.__reviewAtBarrier) void window.__ironTest.holdSave().then(waiting => window.__reviewAtBarrier = waiting);
        return !!window.__reviewAtBarrier;
      `));
      const before = await js("return window.__ironTest.quitRequests();");
      await js("void window.__ironTest.quitMenu(); return true;");
      await eventually("native Quit reaches the workbench during reviewed save", () => js("return window.__ironTest.quitRequests();"), count => count === before + 1);
      assert.equal(await js("return document.querySelector('#quit-dialog').open;"), false);
      await js("window.__ironTest.revealLine(arguments[0]); window.__ironTest.tryType(arguments[1]); return true;",
        intendedSave.split("\n").length, "// Typed during save\n");
      await eventually("the live editor accepts typing during reviewed save", current, state => state?.text === typedDuringSave && state.dirty);
    } finally { await js("void window.__ironTest.holdSave(false); return true;"); }
    await eventually("reviewed save writes only its captured buffer", () => readFile(source, "utf8"), value => value === intendedSave);
    await eventually("later typing stays dirty", current, state => state?.text === typedDuringSave && state.dirty);
    await eventually("reviewed save settles without exiting", () => js("return !window.__ironTest.saving() && !document.querySelector('#save').disabled;"));
    await click("#save");
    await eventually("ordinary save can use that new baseline", () => readFile(source, "utf8"), value => value === typedDuringSave);
    await eventually("the newer buffer is saved", current, state => !state.dirty);
  });
  await record("changing only go.work contents refreshes native run targets", async () => {
    const nested = path.join(fixture, "nested-watch-module");
    const workfile = path.join(fixture, "go.work");
    const target = "./nested-watch-module";
    await mkdir(nested);
    await writeFile(path.join(nested, "go.mod"), "module example.com/watched\n\ngo 1.22\n");
    await writeFile(path.join(nested, "main.go"), "package main\n\nfunc main() {}\n");
    await writeFile(workfile, "go 1.22\n\nuse (\n\t.\n\t./nested-watch-module\n)\n");
    const targets = () => js("return [...document.querySelector('#run-target').options].map(option => option.value);");
    try {
      await eventually("the nested run target is discovered", targets, values => values.includes(target));
      await writeFile(workfile, "go 1.22\n\nuse .\n");
      await eventually("editing go.work removes the target without losing the root program", targets,
        values => values.includes("./cmd/orbit") && !values.includes(target));
    } finally { await rename(workfile, path.join(fixture, "disabled-go-work.txt")); }
  });
  await record("native gutter grows for four digits, and line 1000 selects the whole line", async () => {
    for (const lines of [999, 1001]) {
      const source = ["package main", ...Array.from({ length: lines - 1 }, (_, index) => `// line ${index + 2}`)].join("\n");
      await writeFile(path.join(fixture, `gutter${lines}.go`), source);
    }
    await refreshThroughProjectActions();
    await eventually("gutter fixtures in the tree", () => js("return !!document.querySelector('#explorer [data-path=\"gutter1001.go\"]');"));
    const sizes = [];
    for (const lines of [999, 1001]) {
      const name = `gutter${lines}.go`;
      await click(`#explorer [data-path="${name}"]`);
      const state = await eventually("gutter fixture active", current, state => state?.path === name);
      assert.equal(state.text.split("\n").length, lines);
      sizes.push(await eventually("visible native gutter columns", () => js(`
        const editor = document.querySelector('#editor .monaco-editor');
        const number = [...editor.querySelectorAll('.line-numbers')].find(row => row.textContent.trim() === '1');
        const code = [...editor.querySelectorAll('.view-line')].find(row => row.textContent.startsWith('package'));
        if (!number || !code) return null;
        const rect = number.getBoundingClientRect();
        return { width: rect.width, gap: code.getBoundingClientRect().left - rect.right,
          margin: code.getBoundingClientRect().left - editor.getBoundingClientRect().left,
          lane: editor.querySelector('.glyph-margin').getBoundingClientRect().width, row: code.getBoundingClientRect().height };
      `)));
    }
    const step = sizes[1].width - sizes[0].width;
    assert.ok(step > 0 && step <= 9);
    assert.deepEqual(sizes.map(size => [size.gap, size.lane, size.row]), [[24, 18, 18], [24, 18, 18]]);
    assert.ok(sizes[0].margin <= 66 && sizes[1].margin <= 74, JSON.stringify(sizes));
    await traceGutterClick(1000);
  });
  await record("native Save to a New Path rescues an unavailable buffer without overwriting", async () => {
    const sourceFile = path.join(fixture, "recover-source.txt");
    const openAlias = path.join(fixture, "already-open.txt");
    const existing = path.join(fixture, "exists.txt");
    const canonical = "recovery-pkg/recovered.txt";
    const recovered = path.join(fixture, canonical);
    await mkdir(path.join(fixture, "recovery-pkg"));
    const request = await stat(path.join(fixture, "RECOVERY-PKG")).then(() => "RECOVERY-PKG/recovered.txt", error => {
      if (error.code !== "ENOENT") throw error;
      return canonical;
    });
    await Promise.all([[sourceFile, "original\n"], [openAlias, "alias\n"], [existing, "do not overwrite\n"]]
      .map(([file, content]) => writeFile(file, content)));
    for (const relative of ["already-open.txt", "recover-source.txt"]) {
      await eventually(`${relative} appears in the tree`, () => js("return !!document.querySelector('#explorer [data-path=\"' + arguments[0] + '\"]');", relative));
      await click(`#explorer [data-path="${relative}"]`);
      await eventually(`${relative} is active`, current, state => state?.path === relative);
    }
    const submitted = "retained unsaved text\n";
    const newer = submitted + "newer editor changes\n";
    await replace(submitted);
    await rename(sourceFile, path.join(fixture, "source-backup.txt"));
    await rename(openAlias, path.join(fixture, "alias-backup.txt"));
    await eventually("the missing file offers a rescue action", () => js("return !document.querySelector('#save-new-path').hidden;"));
    await click("#save-new-path");
    await click('[data-dialog-close="form-dialog"]');
    await eventually("Cancel leaves the previous tab and controls", () => js("return !document.querySelector('#save').disabled;"));
    assert.equal((await current()).text, submitted);

    await click("#save-new-path");
    await set("#form-path", "ALREADY-OPEN.txt");
    await click("#form-submit");
    await eventually("missing open aliases remain protected", () => text("#form-error"), value => /matches an open/i.test(value));
    await set("#form-path", "exists.txt");
    await click("#form-submit");
    await eventually("existing path collision is reported", () => text("#form-error"), value => /file exists/i.test(value));
    assert.equal(await readFile(existing, "utf8"), "do not overwrite\n");
    assert.equal((await current()).text, submitted);

    await js("window.__newPathHold = false; void window.__ironTest.holdSave(true, arguments[0]).then(() => window.__newPathHold = true); return true;", request);
    await eventually("new path hold is enabled", () => js("return window.__newPathHold;"));
    try {
      await set("#form-path", request);
      await click("#form-submit");
      await eventually("new path write is admitted", () => js(`
        if (!window.__newPathAtBarrier) void window.__ironTest.holdSave().then(waiting => window.__newPathAtBarrier = waiting);
        return !!window.__newPathAtBarrier;
      `));
      await replace(newer);
    } finally { await js("void window.__ironTest.holdSave(false); return true;"); }
    await eventually("the tab rebinds to disk spelling and preserves later edits", current, state => state?.path === canonical && state.text === newer && state.dirty);
    assert.equal(await readFile(recovered, "utf8"), submitted);
    await assert.rejects(stat(sourceFile), { code: "ENOENT" });
    await eventually("the new path appears in the restored workbench", () => js("return !document.querySelector('#save').disabled && !!document.querySelector('#explorer [data-path=\"recovery-pkg/recovered.txt\"]');"));
    await click("#quick-open");
    await set("#palette-text", "recovered.txt");
    await click("#palette-options button");
    await eventually("Quick Open activates the rebound editor", current, state => state?.path === canonical && state.text === newer);
    assert.equal(await js("return [...document.querySelectorAll('#tabs .tab-main')].filter(tab => tab.dataset.path.endsWith('/recovered.txt')).length;"), 1);
    await click("#save");
    await eventually("ordinary Save advances the new file", () => readFile(recovered, "utf8"), value => value === newer);
    await eventually("the rebound tab is clean", current, state => !state.dirty);
  });
  await record("moves a directory with clean and dirty descendants without losing work", async () => {
    const source = "move-fixture";
    const destination = "moved-fixture";
    const baseline = "package movefixture\n\nvar value = 1\n";
    const local = baseline.replace("= 1", "= 2");
    await mkdir(path.join(fixture, source));
    await writeFile(path.join(fixture, source, "dirty.go"), baseline);
    await writeFile(path.join(fixture, source, "clean.go"), "package movefixture\n");
    for (const leaf of ["clean.go", "dirty.go"]) {
      await click("#quick-open");
      await set("#palette-text", `${source}/${leaf}`);
      await eventually("the indexed descendant is available", () => text("#palette-options"), value => value.includes(leaf));
      await click("#palette-options button");
      await eventually("the descendant tab is active", current, entry => entry?.path === `${source}/${leaf}`);
    }
    await replace(local);
    await eventually("the dirty file's draft is published before move", () => text("#draft-state"), value => /Draft saved/.test(value));
    await clickGlyphBreakpoint(3);
    await click('[data-view="explorer"]');
    const row = `#explorer [data-path="${source}"]`;
    await eventually("the Explorer can own the source selection", () => js("return !!document.querySelector(arguments[0]);", row));
    await click(row);
    await click("#quick-open");
    await set("#palette-text", ">move file or folder");
    await eventually("the move command is available for the selected directory", () => text("#palette-options"), value => /Move File or Folder/.test(value));
    await click("#palette-options button");
    await eventually("Move names the selected source", () => text("#form-description"), value => value.includes(source));
    await set('#form-fields input[name="destination"]', destination);
    await click("#form-submit");
    await eventually("the dirty descendant is rebound and remains active", current, entry => entry?.path === `${destination}/dirty.go` && entry.text === local && entry.dirty);
    assert.equal(await readFile(path.join(fixture, destination, "dirty.go"), "utf8"), baseline);
    await assert.rejects(stat(path.join(fixture, source)), { code: "ENOENT" });
    assert.equal(await js("return !!document.querySelector('#tabs [data-path=\"moved-fixture/clean.go\"]');"), true);
    assert.equal(await js("return !!document.querySelector('#editor .debug-breakpoint');"), true);
    await chooseCommand("recover drafts");
    await eventually("the owned draft has its new workspace-relative path", () => text("#draft-list"), value => value.includes(`${destination}/dirty.go`));
    assert.doesNotMatch(await text("#draft-list"), /(^|\s)move-fixture\/dirty\.go/);
    await click('[data-dialog-close="draft-dialog"]');
    await chooseCommand("new folder");
    await eventually("the new folder form is ready", () => text("#form-submit"), value => value === "New Folder");
    await set('#form-fields input[name="destination"]', `${destination}/Nested`);
    await click("#form-submit");
    await eventually("the nested folder exists", () => stat(path.join(fixture, destination, "Nested")), info => info.isDirectory());
    await eventually("the folder form closes", () => js("return !document.querySelector('#form-dialog').open;"));
    await click(`#explorer [data-path="${destination}"]`);
    await chooseCommand("rename file or folder");
    await eventually("the case rename form is ready", () => text("#form-description"), value => value.includes(destination));
    await set('#form-fields input[name="destination"]', "MOVED-fixture");
    await click("#form-submit");
    await eventually("case-only directory rename rebinds the dirty descendant", current, entry => entry?.path === "MOVED-fixture/dirty.go" && entry.text === local && entry.dirty);
    const actual = await readdir(fixture);
    assert.ok(actual.includes("MOVED-fixture") && !actual.includes(destination));
    await mkdir(path.join(fixture, "occupied-move"));
    await eventually("the case rename form closes", () => js("return !document.querySelector('#form-dialog').open;"));
    await chooseCommand("move file or folder");
    await eventually("the move form names the exact case-renamed source", () => text("#form-description"), value => value.includes("MOVED-fixture"));
    await set('#form-fields input[name="destination"]', "occupied-move");
    await click("#form-submit");
    await eventually("an existing destination is not replaced", () => js(`const error = document.querySelector('#form-error');
      return !error.hidden && !document.querySelector('#form-submit').disabled ? error.textContent : '';`), value => /without replacing|exists/i.test(value));
    assert.equal(await readFile(path.join(fixture, "MOVED-fixture/dirty.go"), "utf8"), baseline);
    assert.deepEqual(await readdir(path.join(fixture, "occupied-move")), []);
    assert.equal((await current()).dirty, true);
    await click('[data-dialog-close="form-dialog"]');
    await eventually("the failed move releases the file decision", () => js("return !document.querySelector('#new-file').disabled;"));
    await replace(baseline);
  });
  await record("native watcher detects a moved ancestor and rejects writes into a replacement root", async () => {
    const parent = path.dirname(fixture);
    const retired = `${parent}-retired`;
    const buffer = (await current()).text;
    await rename(parent, retired);
    try {
      await mkdir(fixture, { recursive: true });
      await eventually("the old workspace becomes unavailable without a focus or refresh", () => text("#disk-change"),
        value => value.includes("unavailable"));
      assert.equal((await current()).text, buffer);
      await click("#new-file");
      await set("#form-path", "must-not-exist/file.txt");
      await click("#form-submit");
      await eventually("New File rejects the replaced workspace", () => text("#form-error"), value => value.includes("has been replaced"));
      await assert.rejects(stat(path.join(fixture, "must-not-exist")), { code: "ENOENT" });
      await click('[data-dialog-close="form-dialog"]');
    } finally {
      await rename(parent, `${parent}-replacement`);
      await rename(retired, parent);
    }
  });
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

async function goSuite() {
  const capabilities = await probeTools({ gopls: !!values["require-gopls"] });
  await openOrbit();
  // Monaco can open before the independent package/tool probes finish. A
  // click during discovery is correctly rejected by the workbench.
  await eventually("Go toolchain reported", () => text("#tool-version"), value => /go?\s*\d+\.\d+/i.test(value));
  await eventually("Go package discovery selected the Orbit target", () => js("return document.querySelector('#run-target')?.value;"), value => value === "./cmd/orbit");
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
    await addWaitTarget();
    await openProjectControl("#open-folder");
    await eventually("both discovered targets", () => js("return Array.from(document.querySelector('#run-target').options).map(option => option.value);"), values => values?.includes("./cmd/orbit") && values?.includes("./cmd/wait"));
    await eventually("workspace ready", () => js("return !document.querySelector('#run').disabled;"));
    assert.equal(await js("return document.querySelector('#run-target').value;"), "");
    await click("#run");
    await eventually("run requires an explicit selection", () => text("#toast"), value => /choose a run target/i.test(value));
    await js("const select = document.querySelector('#run-target'); select.value = './cmd/wait'; select.dispatchEvent(new Event('change')); return true;");
    await click("#run");
    const ready = await eventually("long-running Go program", output, value => /agent-ready \d+/.test(value), 30_000);
    const pid = Number(ready.match(/agent-ready (\d+)/)[1]);
    const actionGap = await js(`
      const stop = document.querySelector('#panel-stop').getBoundingClientRect();
      const clear = document.querySelector('#clear-output').getBoundingClientRect();
      return stop.width && clear.width ? clear.left - stop.right : null;
    `);
    assert.equal(actionGap, 1, "visible Stop Task and Clear Output keep a one-pixel gap");
    await click("#panel-stop");
    await eventually("task cancellation", output, value => /task stopped/i.test(value));
    await eventually("Go inferior exited", () => {
      try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
    });
  });

  if (!capabilities.gopls) {
    for (const name of ["gopls publishes/clears real errors and completes a Go symbol", "gopls hover and definition work through Monaco",
      "gopls symbol and reference navigation uses unsaved UTF-16 locations", "Organize Imports updates only the Go buffer as one undoable edit",
      "Rename previews real cross-file changes and rejects a stale workspace",
      "opens Go standard library and offline dependency source in an isolated read-only viewer", "runs exactly one Go test from its editor action",
      "whole-line selection highlights the selected number, not its endpoint", "gopls colors identifiers in an unsaved Go buffer",
      "native Go Back and Forward restore a dirty editor across a gopls jump"]) {
      console.log(`  SKIP ${name} (gopls not installed)`);
      report.cases.push({ name, result: "skip", reason: "gopls not installed" });
    }
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
      for (const [theme, background] of [["dark", "rgb(4, 57, 94)"], ["light", "rgb(0, 95, 184)"]]) {
        if (theme === "light") await setNativeTheme(theme);
        await js("return window.__ironTest.suggest(arguments[0], arguments[1]);", index + 1, lines[index].indexOf("NewRep") + "NewRep".length + 1);
        await eventually(`selected Go completion uses ${theme} Modern colors`, () => js(`
          const row = document.querySelector('.suggest-widget.visible .monaco-list-row.focused');
          if (!row) return null;
          const style = getComputedStyle(row);
          return { text: row.textContent, background: style.backgroundColor, foreground: style.color };
        `), row => row?.text.includes("NewReport") && row.background === background && row.foreground === "rgb(255, 255, 255)", 20_000);
      }
      await setNativeTheme("dark");
      await replace(clean);
    });
    await record("native Go Back and Forward restore a dirty editor across a gopls jump", async () => {
      const clean = (await current()).text;
      const local = clean + "\n// unsaved navigation fixture\n";
      const codePoint = local.split("\n").findIndex(line => line.includes("status.NewReport"));
      assert.ok(codePoint >= 0);
      await replace(local);
      await js("window.__ironTest.position(arguments[0], arguments[1]); return true;", codePoint + 1, local.split("\n")[codePoint].indexOf("NewReport") + 2);
      const origin = await js("return window.__ironTest.codeLocation();");
      const menu = (title, activate = false) => js("return window.__ironTest.menuItem('Go', arguments[0], arguments[1]);", title, activate);
      await eventually("native definition command enabled", () => menu("Go to Definition"), value => value === true);
      assert.equal(await menu("Go to Definition", true), true);
      await eventually("definition opens the real target", current, entry => entry?.path === "internal/status/report.go");
      const target = await js("return window.__ironTest.codeLocation();");
      await eventually("native Back enabled", () => menu("Back"), value => value === true);
      assert.equal(await menu("Back", true), true);
      await eventually("Back restores the dirty origin", current, entry => entry?.path === "cmd/orbit/main.go" && entry.dirty && entry.text === local);
      assert.deepEqual(await js("return window.__ironTest.codeLocation();"), origin);
      await eventually("native Forward enabled", () => menu("Forward"), value => value === true);
      assert.equal(await menu("Forward", true), true);
      await eventually("Forward restores the definition", current, entry => entry?.path === "internal/status/report.go");
      assert.deepEqual(await js("return window.__ironTest.codeLocation();"), target);
      assert.equal(await readFile(path.join(fixture, "cmd/orbit/main.go"), "utf8"), clean);
      await click('#tabs [data-path="cmd/orbit/main.go"]');
      await js("window.__ironTest.action('editor.action.revealDefinition', arguments[0], 1); return true;", local.split("\n").length);
      await eventually("the abandoned definition has no result", () => text("#toast"), value => /No definition found/.test(value));
      await js("window.__ironTest.position(arguments[0], arguments[1]); return true;", origin.line, origin.column);
      const laterOrigin = await js("return window.__ironTest.codeLocation();");
      await js("window.__ironTest.action('editor.action.revealDefinitionAside', arguments[0], arguments[1]); return true;", origin.line, origin.column);
      await eventually("a later Monaco command opens the real target", current, entry => entry?.path === "internal/status/report.go");
      await eventually("native Back is enabled for the later jump", () => menu("Back"), value => value === true);
      assert.equal(await menu("Back", true), true);
      await eventually("Back restores the later origin", current, entry => entry?.path === "cmd/orbit/main.go");
      assert.deepEqual(await js("return window.__ironTest.codeLocation();"), laterOrigin);
      await replace(clean);
    });
    await record("gopls colors identifiers in an unsaved Go buffer", async () => {
      const clean = (await current()).text;
      const edit = clean + `
const SemanticSuffix = "🚀"
type SemanticCourier struct { SemanticAddress string }
func (c SemanticCourier) SemanticDeliver(SemanticMessage string) string {
	SemanticLocal := fmt.Sprintf("%s", c.SemanticAddress + "🚀" + SemanticMessage)
	if true { return SemanticLocal + SemanticSuffix + string(rune(len(SemanticMessage))) }
	return ""
}
`;
      const identifiers = ["SemanticCourier", "SemanticDeliver", "SemanticAddress", "SemanticMessage", "SemanticLocal", "SemanticSuffix", "true", "fmt", "len", "%s"];
      const palette = () => js(`
        window.__ironTest.refreshView();
        const spans = [...document.querySelectorAll('#editor .view-lines span[class*="mtk"]')];
        return Object.fromEntries(arguments[0].map(word =>
          [word, spans.filter(span => span.textContent.trim() === word).map(span => getComputedStyle(span).color)]));
      `, identifiers);
      try {
        await js("return window.__ironTest.focusWindow().then(() => true);");
        await replace(edit);
        await js("window.__ironTest.revealLine(arguments[0]); return true;", edit.split("\n").length - 4);
        for (const [theme, expected] of [
          ["dark", ["rgb(78, 201, 176)", "rgb(220, 220, 170)", "rgb(156, 220, 254)", "rgb(156, 220, 254)", "rgb(156, 220, 254)", "rgb(79, 193, 255)", "rgb(86, 156, 214)", "rgb(78, 201, 176)", "rgb(220, 220, 170)", "rgb(156, 220, 254)"]],
          ["light", ["rgb(38, 127, 153)", "rgb(121, 94, 38)", "rgb(0, 16, 128)", "rgb(0, 16, 128)", "rgb(0, 16, 128)", "rgb(0, 112, 193)", "rgb(0, 0, 255)", "rgb(38, 127, 153)", "rgb(121, 94, 38)", "rgb(0, 16, 128)"]],
        ]) {
          if (theme === "light") await setNativeTheme(theme);
          await eventually(`${theme} semantic colors apply to unsaved identifiers`, palette, value => {
            return identifiers.every((word, index) => value?.[word]?.length > 0 &&
              value[word].every(color => color === expected[index]));
          }, 20_000);
        }
        assert.equal((await current()).text, edit);
        assert.equal(await readFile(path.join(fixture, "cmd/orbit/main.go"), "utf8"), clean);
      } finally { await setNativeTheme("dark"); await replace(clean); }
    });
    await record("gopls symbol and reference navigation uses unsaved UTF-16 locations", async () => {
      const relative = "cmd/orbit/navigation.go";
      const file = path.join(fixture, relative);
      const disk = "package main\n\nvar onDisk = 1\n";
      const line = 'var _ = "🚀"; var _ = status.NewReport';
      const editorText = `package main\n\nimport "example.com/orbit/internal/status"\n\nvar inEditor = 1\n${line}\n`;
      await writeFile(file, disk);
      const main = (await current()).text.split("\n");
      const origin = main.findIndex(text => text.includes("status.NewReport"));
      const column = main[origin].indexOf("NewReport") + 1;
      const invokeReferences = () => js(`
        document.querySelector('#tabs [data-path="cmd/orbit/main.go"]').click();
        window.__ironTest.position(arguments[0], arguments[1]);
        document.querySelector('#quick-open').click();
        const query = document.querySelector('#palette-text');
        query.value = '>find references';
        query.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#palette-options button').click();
        return true;
      `, origin + 1, column);
      await eventually("navigation fixture becomes visible", () => js(`
        return !!document.querySelector('#explorer [data-path="cmd/orbit/navigation.go"]');
      `));
      await click(`#explorer [data-path="${relative}"]`);
      await eventually("the second Go document is active", current, state => state?.path === relative);
      // Edit and invoke in one task so the other model's sync debounce cannot fire first.
      await js(`window.__ironTest.replace(arguments[0]);
        document.querySelector('#tabs [data-path="cmd/orbit/main.go"]').click();
        window.__ironTest.position(arguments[1], arguments[2]);
        document.querySelector('#quick-open').click();
        const query = document.querySelector('#palette-text');
        query.value = '>find references'; query.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#palette-options button').click(); return true;`, editorText, origin + 1, column);
      const label = `navigation.go:6:${line.indexOf("NewReport") + 1}`;
      const waitReferences = () => eventually("gopls groups unsaved use and declaration", () => text("#references-results"),
        value => value.includes(label) && value.includes("internal/status/report.go"));
      await waitReferences();
      assert.equal(await js("return document.activeElement?.id;"), "close-references");
      await js(`const results = document.querySelector('#references-results');
        const group = [...results.querySelectorAll('h3')].find(item => item.textContent === 'internal/status/report.go');
        group.nextElementSibling.click(); return true;`);
      await eventually("a reference opens the previously closed declaration", current, state => state?.path === "internal/status/report.go");
      await invokeReferences();
      await waitReferences();
      const selectUnsaved = () => js(`const result = [...document.querySelectorAll('#references-results button')]
        .find(item => item.textContent.startsWith(arguments[0])); result.click(); return true;`, label);
      await selectUnsaved();
      await eventually("unsaved reference starts at its UTF-16 column", () => js("return window.__ironTest.gutterTrace().selection?.start;"),
        value => value?.lineNumber === 6 && value.column === line.indexOf("NewReport") + 1);
      assert.equal((await current()).text, editorText);
      await chooseCommand("go to symbol in file");
      await eventually("unsaved symbol is searchable", () => text("#go-symbol-results"), value => value.includes("inEditor") && !value.includes("onDisk"));
      await set("#go-symbol-search", "ineditor");
      await click("#go-symbol-results button");
      await eventually("selecting the filtered symbol navigates to its line", () => text("#cursor"), value => value.startsWith("Ln 5,"));
      await js("window.__ironTest.holdGoRequest('textDocument/references'); return true;");
      try {
        await invokeReferences();
        await eventually("the live reference reply is held", () => js("return window.__ironTest.goReferenceProbe().deferred;"));
        await replace(main.join("\n") + "\n// invalidate outstanding navigation\n");
        await eventually("editing cancels the outstanding request on the workbench transport", () => js("return window.__ironTest.goReferenceProbe().cancelled;"));
        assert.match(await text("#references-results"), /out of date/i);
      } finally { await js("window.__ironTest.releaseGoReferences(); return true;"); }
      await replace(main.join("\n"));
      await invokeReferences();
      await waitReferences();
      await js(`window.__oldReference = [...document.querySelectorAll('#references-results button')]
        .find(item => item.textContent.startsWith(arguments[0])); return true;`, label);
      await click('.tab[data-tab-path="cmd/orbit/navigation.go"] .tab-close');
      await eventually("dirty Go target has a discard decision", () => js("return document.querySelector('#file-decision-dialog').open;"));
      await click("#file-decision-discard");
      await eventually("closing a model invalidates the displayed references", () => text("#references-results"), value => value.includes("out of date"));
      await eventually("discard finishes closing the tab", () => js("return !document.querySelector('#tabs [data-path=\"cmd/orbit/navigation.go\"]');"));
      await js("window.__oldReference.click(); return true;");
      assert.equal(await js("return !!document.querySelector('#tabs [data-path=\"cmd/orbit/navigation.go\"]');"), false);
      assert.equal(await readFile(file, "utf8"), disk);
      await click("#close-references");
    });
    await record("Organize Imports updates only the Go buffer as one undoable edit", async () => {
      const file = path.join(fixture, "cmd/orbit/organize.go");
      const original = 'package main\n\nimport (\n\t"os"\n\t"fmt"\n)\n\nvar importFixture = fmt.Sprintf("ready")\n';
      await writeFile(file, original);
      await eventually("organize fixture appears", () => js("return !!document.querySelector('#explorer [data-path=\"cmd/orbit/organize.go\"]');"));
      await click('#explorer [data-path="cmd/orbit/organize.go"]');
      await eventually("organize fixture is open", current, state => state?.path === "cmd/orbit/organize.go");
      await chooseCommand("go organize imports");
      await eventually("unused import removed from the buffer", current, state => state?.dirty && state.text.includes('"fmt"') && !state.text.includes('"os"'));
      assert.equal(await readFile(file, "utf8"), original);
      await js("window.__ironTest.action('undo', 1, 1); return true;");
      await eventually("one Undo restores the original imports", current, state => state?.text === original && !state.dirty);
      const later = original + "\n// An ordinary save while gopls is pending\n";
      await js("window.__ironTest.holdGoRequest('textDocument/codeAction'); return true;");
      try {
        await chooseCommand("go organize imports");
        await eventually("the import response is held", () => js("return window.__ironTest.goReferenceProbe().deferred;"));
        await replace(later);
        await click("#save");
        await eventually("ordinary Save remains available while the code action is waiting", () => readFile(file, "utf8"), bytes => bytes === later);
        await eventually("the completed Save has published its status", () => text("#status"), value => value === "Saved organize.go");
      } finally { await js("window.__ironTest.releaseGoReferences(); return true;"); }
      await eventually("the superseded import response is rejected", () => text("#status"), value => /buffer changed/.test(value));
      await eventually("the superseded import response leaves the new buffer alone", current, state => state?.text === later && !state.dirty);
      const corrected = later.replace('\t"os"\n', "");
      await writeFile(file, corrected);
      await eventually("the valid fixture on disk is adopted", current, state => state?.text === corrected && !state.dirty);
      await click('#tabs [data-path="cmd/orbit/main.go"]');
    });
    await record("Rename previews real cross-file changes and rejects a stale workspace", async () => {
      const source = path.join(fixture, "cmd/orbit/main.go");
      const latePath = "cmd/orbit/rename_extra.go";
      const late = path.join(fixture, latePath);
      const lateText = 'package main\n\nimport "example.com/orbit/internal/status"\n\nvar _ = "🚀"; var _ = status.NewReport\n';
      const original = await readFile(source, "utf8");
      const dirty = original + "\n// Unrelated unsaved edit\n";
      await replace(dirty);
      await writeFile(late, lateText);
      const lines = dirty.split("\n");
      const origin = lines.findIndex(line => line.includes("status.NewReport"));
      const column = lines[origin].indexOf("NewReport") + 1;
      const requestRename = async () => {
        await js("window.__ironTest.position(arguments[0], arguments[1]); return true;", origin + 1, column);
        await chooseCommand("go rename symbol");
        await set("#form-name", "BuildReport");
        await click("#form-submit");
      };
      const preview = async () => {
        await requestRename();
        await eventually("rename preview includes the closed file", () => js(`
          return !!document.querySelector('#rename-preview-dialog[open]') &&
            [...document.querySelector('#rename-preview-file').options].some(file => file.value === arguments[0]);
        `, latePath));
      };
      const overlay = "cmd/orbit/rename_overlay.go";
      const overlayDisk = path.join(fixture, overlay);
      const baseline = "package main\n";
      await writeFile(overlayDisk, baseline);
      await eventually("the overlay file appears", () => js("return !!document.querySelector('#explorer [data-path=\"cmd/orbit/rename_overlay.go\"]');"));
      await click(`#explorer [data-path="${overlay}"]`);
      await eventually("the overlay is open", current, state => state?.path === overlay);
      await replace(baseline + "// unsaved overlay without references\n");
      await writeFile(overlayDisk, lateText.replace("var _ =", "var overlayMarker ="));
      await click('#tabs [data-path="cmd/orbit/main.go"]');
      await requestRename();
      await eventually("a stale non-participant overlay cannot mask a disk reference", () => text("#toast"), value => /rename_overlay\.go changed on disk/.test(value));
      await writeFile(overlayDisk, baseline);
      await click(`.tab[data-tab-path="${overlay}"] .tab-close`);
      await eventually("the dirty overlay close is ready", () => js("return document.querySelector('#file-decision-dialog').open;"));
      await click("#file-decision-discard");
      await eventually("the overlay is discarded before preparing again", () => js("return !document.querySelector('#tabs [data-path=\"cmd/orbit/rename_overlay.go\"]') && !document.querySelector('#save').disabled;"));
      await preview();
      await eventually("the preview renders the old and new names in read-only buffers", () => js(`
        return document.querySelector('#rename-preview-original .view-lines')?.textContent.includes('NewReport') &&
          document.querySelector('#rename-preview-modified .view-lines')?.textContent.includes('BuildReport');
      `));
      await writeFile(late, lateText + "// disk changed during review\n");
      await click("#rename-preview-apply");
      await eventually("stale workspace prevents any rename edits", () => text("#toast"), value => /changed.*rename|rename.*changed/i.test(value));
      assert.equal((await current()).text, dirty);
      assert.equal(await readFile(source, "utf8"), original);

      await eventually("the changed candidate is reconciled", () => js("return !document.querySelector('#save').disabled;"));
      await click(`#tabs [data-path="${latePath}"]`);
      await eventually("the candidate adopts the newer disk version", current, state => state?.path === latePath && state.text.includes("disk changed during review"));
      await click('#tabs [data-path="cmd/orbit/main.go"]');
      await preview();
      const affected = await js("return [...document.querySelector('#rename-preview-file').options].map(option => option.value);");
      await click("#rename-preview-apply");
      await eventually("the originating buffer receives the approved rename", current,
        state => state?.text.includes("status.BuildReport") && state.text.includes("Unrelated unsaved edit") && state.dirty);
      assert.equal(await readFile(source, "utf8"), original);
      assert.equal(await readFile(late, "utf8"), lateText + "// disk changed during review\n");
      assert.ok(affected.includes(latePath) && affected.includes("internal/status/report.go") && affected.includes("cmd/orbit/main.go"));
      for (const relative of affected) {
        const selector = `#tabs [data-path="${relative}"]`;
        await click(selector);
        await eventually("the renamed buffer is active", current, state => state?.path === relative && state.text.includes("BuildReport"));
        await js("window.__ironTest.action('undo', 1, 1); return true;");
        await eventually("one Undo restores the original name", current, state => state?.text.includes("NewReport") && !state.text.includes("BuildReport"));
      }
      await click('#tabs [data-path="cmd/orbit/main.go"]');
      await replace(original);
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
      await click('#tabs [data-path="cmd/orbit/main.go"]');
      await action("ironGo.goToDefinition");
      await eventually("workbench definition opens the same editable source", current, state => state?.path === "internal/status/report.go");
      assert.equal(await js("return window.__ironTest.gutterTrace().selection.empty;"), true);
    });
    await record("opens Go standard library and offline dependency source in an isolated read-only viewer", async () => {
      await click('#tabs [data-path="cmd/orbit/main.go"]');
      const state = await eventually("main Go file is active", current, entry => entry?.path === "cmd/orbit/main.go");
      const lines = state.text.split("\n");
      const row = lines.findIndex(line => line.includes("fmt.Println"));
      assert.ok(row >= 0);
      const invokeDefinition = (id, line, column) => js(`
        window.__sourceActionDone = false;
        void Promise.resolve(window.__ironTest.action(arguments[0], arguments[1], arguments[2]))
          .then(() => window.__sourceActionDone = true); return true;
      `, id, line, column);
      const column = lines[row].indexOf("Println") + 2;
      await invokeDefinition("editor.action.peekDefinition", row + 1, column);
      await eventually("external Peek has no preview", () => text("#editor .monaco-editor-overlaymessage"), value => /no definition found/i.test(value));
      assert.equal(await js("return document.querySelector('#go-source-dialog').open;"), false);
      await invokeDefinition("ironGo.goToDefinition", row + 1, column);
      await eventually("Go to Definition opens the read-only source viewer", () => js("return document.querySelector('#go-source-dialog')?.open === true;"));
      const actualPath = await text("#go-source-path");
      assert.match(actualPath, /\/src\/fmt\/print\.go$/);
      await eventually("the viewer displays the standard-library declaration", () => text("#go-source-editor .view-lines"), value => /func\s+Println/.test(value));
      assert.deepEqual(await js("return window.__ironTest.goSourceView();"), { text: await readFile(actualPath, "utf8"), selected: "Println" });
      assert.equal(await js("return document.querySelector('#go-source-editor textarea')?.readOnly;"), true);
      assert.equal((await current()).path, "cmd/orbit/main.go");
      assert.equal(await js("return [...document.querySelectorAll('#tabs [data-path]')].some(tab => tab.dataset.path.endsWith('/fmt/print.go'));"), false);
      await click("#go-source-close");
      await eventually("the originating editor regains focus", () => js("return document.querySelector('#editor').contains(document.activeElement);"));
      await eventually("the source action completes", () => js("return window.__sourceActionDone;"));

      const withDependency = state.text.replace('"fmt"', '"fmt"\n\t"example.test/sourcefixture"').replace("fmt.Println(", "fmt.Println(sourcefixture.FromCache(), ");
      await replace(withDependency);
      const dependencyLines = withDependency.split("\n");
      const dependencyRow = dependencyLines.findIndex(line => line.includes("sourcefixture.FromCache"));
      assert.ok(dependencyRow >= 0);
      await js("window.__ironTest.holdGoRequest('textDocument/definition', 'file:///outside-go-source-fixture/source.go'); return true;");
      try {
        await invokeDefinition("ironGo.goToDefinition", dependencyRow + 1, dependencyLines[dependencyRow].indexOf("FromCache") + 2);
        await eventually("the definition reply includes an unavailable first target", () => js("return window.__ironTest.goReferenceProbe().deferred;"));
      } finally { await js("window.__ironTest.releaseGoReferences(); return true;"); }
      await eventually("the offline dependency opens", () => text("#go-source-path"), value => value.endsWith("/example.test/sourcefixture@v1.0.0/source.go"));
      assert.deepEqual(await js("return window.__ironTest.goSourceView();"), {
        text: 'package sourcefixture\n\nfunc FromCache() string { return "local proxy fixture" }\n', selected: "FromCache",
      });
      await click("#go-source-close");
      await eventually("the dependency action completes", () => js("return window.__sourceActionDone;"));
      await replace(state.text);

      const originalId = await js("return window.__ironTest.workspaceId();");
      await js("window.__ironTest.holdGoSourceRead(); return true;");
      try {
        await invokeDefinition("ironGo.goToDefinition", row + 1, column);
        await eventually("the native source read has returned and its result is held", () => js("return window.__ironTest.goSourceReadHeld();"));
        await openProjectControl("#open-folder");
        if (await js("return document.querySelector('#project-transition-dialog').open;")) await click("#project-transition-continue");
        await eventually("the project has been reopened with a new identity", () => js("return window.__ironTest.workspaceId();"), id => id && id !== originalId);
      } finally { await js("window.__ironTest.releaseGoSourceRead(); return true;"); }
      await eventually("the delayed action settles", () => js("return window.__sourceActionDone;"));
      assert.equal(await js("return document.querySelector('#go-source-dialog').open;"), false);
      await eventually("gopls reconnects to the reopened workspace", current, entry => entry?.gopls === "ready");
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
    await record("whole-line selection highlights the selected number, not its endpoint", () => traceGutterClick(9));
  }
  await goScopeCases();
  if (capabilities.gopls) {
    await record("keyboard command runs only the test at a dirty renamed declaration", async () => {
      await openTestFile();
      const before = await current();
      assert.match(before.text, /func TestSummary/);
      assert.match(before.text, /func TestAnother/);
      await prepareKeyboardCommand("run test at cursor");
      await js(`
        window.__ironTest.replace(arguments[0]);
        window.__ironTest.revealLine(9);
        document.querySelector('#palette-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        return true;
      `, before.text.replace("func TestSummary(", "func TestKeyboardRenamed("));
      const result = await eventually("renamed test executes through keyboard command", output,
        value => /PASS: TestKeyboardRenamed[\s\S]*exit code 0/.test(value), 30_000);
      assert.doesNotMatch(result, /PASS: TestAnother|PASS: TestSummary/);
    });
  } else {
    report.cases.push({ name: "keyboard command runs only the test at a dirty renamed declaration", result: "skip", reason: "gopls not installed" });
  }
  await record("structured Go tests keep terminal results after output clipping and navigate failures", async () => {
    const relative = "cmd/orbit/structured_test.go";
    const file = path.join(fixture, relative);
    const dependency = path.join(fixture, "internal", "structuredbroken");
    const source = `package main
import ("strings"; "testing")
func TestStructuredLarge(t *testing.T) {
  t.Log("bounded human output begins")
  for i := 0; i < 620; i++ { t.Log(strings.Repeat("x", 1024)) }
}
func TestStructuredPass(t *testing.T) {}
func TestStructuredSkip(t *testing.T) { t.Skip("skip fixture") }
func TestStructuredNested(t *testing.T) {
  t.Run("child.+", func(t *testing.T) { t.Fatal("failing child") })
  t.Run("childXY", func(t *testing.T) { t.Log("similarly named sibling") })
}
`;
    await writeFile(file, source);
    await click("#quick-open");
    await set("#palette-text", "structured_test.go");
    await eventually("the new test source appears in Quick Open", () => text("#palette-options"), value => value.includes("structured_test.go"));
    await click("#palette-options button");
    await eventually("the structured fixture opens", current, state => state?.path === relative);
    await click('[data-view="tasks"]');
    await js("document.querySelector('#package-scope').value = 'current'; return true;");
    await click('[data-task="test"]');
    await eventually("visible output is clipped without dropping the result stream", output, value => /bounded human output begins[\s\S]*Visible output limit reached[\s\S]*exit code 1/.test(value), 30_000);
    await click("#test-results-tab");
    const result = () => text("#test-results-list");
    assert.match(await result(), /TestStructuredPassPassed/);
    assert.match(await result(), /TestStructuredSkipSkipped/);
    assert.match(await result(), /TestStructuredNested\/child\.\+Failed/);
    assert.doesNotMatch(await text("#test-results-summary"), /incomplete/i);
    await js(`const child = [...document.querySelectorAll('#test-results-list button')].find(row => row.textContent === 'TestStructuredNested/child.+');
      if (!child) throw new Error('The failed source location is not linked'); child.click(); return true;`);
    const line = source.split("\n").findIndex(value => value.includes("failing child")) + 1;
    await eventually("the test result jumps to the exact failure line", () => text("#cursor"), value => value.startsWith(`Ln ${line},`));

    const rerun = () => js(`const row = [...document.querySelectorAll('#test-results-list .test-result-row')]
      .find(row => row.textContent.startsWith('TestStructuredNested/child.+'));
      const button = row?.querySelector('.test-result-rerun');
      if (!button) throw new Error('The failed subtest has no rerun action'); button.click(); return true;`);
    await rerun();
    const reran = await eventually("a real rerun executes the punctuation-bearing name", output,
      value => /-count=1[\s\S]*=== RUN\s+TestStructuredNested\/child\.\+[\s\S]*exit code 1/.test(value), 30_000);
    assert.doesNotMatch(reran, /childXY|similarly named sibling/);
    await click("#test-results-tab");
    const manifest = path.join(fixture, "go.mod");
    const previousModule = await readFile(manifest, "utf8");
    try {
      await js(`window.__rerunArmed = false; window.__rerunAtHandoff = null;
        void window.__ironTest.runHandoff(true).then(() => window.__rerunArmed = true); return true;`);
      await eventually("rerun handoff is armed", () => js("return window.__rerunArmed;"));
      await rerun();
      await eventually("preflight passed but no test was started yet", () => js(`
        void window.__ironTest.runHandoff().then(root => window.__rerunAtHandoff = root);
        return window.__rerunAtHandoff;`), root => root === fixture);
      await writeFile(manifest, previousModule.replace("module example.com/orbit", "module example.com/moved-orbit"));
      await js("void window.__ironTest.runHandoff(false); return true;");
      const rejected = await eventually("a still-existing directory with a different import path is rejected", output,
        value => /package identity changed[\s\S]*ended without an exit code/i.test(value), 30_000);
      assert.doesNotMatch(rejected, /=== RUN/);
    } finally {
      await js("void window.__ironTest.runHandoff(false); return true;");
      await writeFile(manifest, previousModule);
    }

    await writeFile(file, source.replace("func TestStructuredPass(t *testing.T) {}", "func TestStructuredPass(t *testing.T) { _ = undefinedFixtureSymbol }"));
    await click('[data-task="test"]');
    await eventually("test build variant diagnostics are correlated", result, value => /Blocked by build:.*\[.*\.test\][\s\S]*Build:.*\[.*\.test\]/.test(value), 30_000);
    await eventually("variant build exits", output, value => /exit code 1/.test(value));

    await mkdir(dependency);
    await writeFile(path.join(dependency, "broken.go"), "package structuredbroken\nvar _ = missing\n");
    await writeFile(file, `package main\nimport _ "example.com/orbit/internal/structuredbroken"\n`);
    await click('[data-task="test"]');
    await eventually("dependency build failures remain attributed to the dependency", result,
      value => value.includes("Build: example.com/orbit/internal/structuredbroken"), 30_000);
    await eventually("dependency build exits", output, value => /exit code 1/.test(value));

    await writeFile(file, 'package main\nimport ("testing"; "time")\nfunc TestStructuredWaiting(t *testing.T) { time.Sleep(time.Minute) }\n');
    await click('[data-task="test"]');
    await eventually("the waiting test has a running result", result, value => /TestStructuredWaitingRunning/.test(value), 30_000);
    await click("#stop-task");
    await eventually("cancelled tests become incomplete", result, value => /TestStructuredWaitingIncomplete/.test(value));
    await rename(file, path.join(fixture, "structured-suite.txt"));
    await rename(path.join(dependency, "broken.go"), path.join(dependency, "broken.txt"));
  });
  await record("a selected Go configuration keeps build and program contexts separate", async () => {
    const module = path.join(fixture, "configured-module");
    await mkdir(module);
    await mkdir(path.join(fixture, "runtime"));
    await writeFile(path.join(module, "go.mod"), "module example.com/configured\n\ngo 1.22\n");
    await writeFile(path.join(fixture, "go.work"), "go 1.22\n\nuse (\n\t.\n\t./configured-module\n)\n");
    await writeFile(path.join(module, "main.go"), `package main
import ("encoding/json"; "fmt"; "os"; "os/exec")
func main() {
  cwd, _ := os.Getwd()
  if err := os.WriteFile("launched.marker", []byte("started"), 0600); err != nil { panic(err) }
  child := exec.Command("/bin/sleep", "60")
  if err := child.Start(); err != nil { panic(err) }
  data, _ := json.Marshal(map[string]any{"cwd":cwd,"args":os.Args[1:],"gowork":os.Getenv("GOWORK"),"env":os.Getenv("PROFILE_VALUE"),"session":os.Getenv("PROFILE_SESSION"),"pid":os.Getpid(),"child":child.Process.Pid})
  fmt.Printf("configured-start %s\\n", data)
  if os.Getenv("PROFILE_EXIT_EARLY") == "1" { _ = child.Process.Release(); return }
  _ = child.Wait()
}
`);
    await click('[data-view="tasks"]');
    await click("#run-configurations");
    await set("#run-config-name", "Configured fixture");
    await set("#run-config-package", "./configured-module");
    await set("#run-config-directory", "runtime");
    const args = ["", "two words", "-flag"];
    await set("#run-config-arguments", '["\\ud800"]');
    await click("#run-config-save");
    await eventually("unpaired Unicode is rejected before saving", () => text("#run-config-error"), value => /valid Unicode/i.test(value));
    await set("#run-config-arguments", JSON.stringify(args));
    await set("#run-config-environment", "GOWORK=invalid-for-build\nPROFILE_VALUE=with = sign ");
    await set("#run-config-session", "PROFILE_SESSION=session-only-sentinel");
    await click("#run-config-save");
    await eventually("the named configuration is selected", () => js("return document.querySelector('#run-target').selectedOptions[0]?.textContent;"), value => value?.includes("Configured fixture"));
    const preferences = await js(`return Object.keys(localStorage).filter(key => key.startsWith('irongo.runConfigurations')).map(key => localStorage.getItem(key));`);
    assert.match(preferences.join(""), /Configured fixture/);
    assert.doesNotMatch(preferences.join(""), /session-only-sentinel/);
    assert.notEqual((await current()).path, "configured-module/main.go");
    await click("#run");
    const actual = await eventually("the configured executable receives its own context", output, value => /configured-start \{[^\n]+\}/.test(value), 30_000);
    const data = JSON.parse(actual.match(/configured-start (\{[^\n]+\})/)[1]);
    assert.deepEqual(data.args, args);
    assert.equal(data.cwd, path.join(fixture, "runtime"));
    assert.equal(data.gowork, "invalid-for-build");
    assert.equal(data.env, "with = sign ");
    assert.equal(data.session, "session-only-sentinel");
    assert.doesNotMatch(actual.split("configured-start")[0], /invalid-for-build|session-only-sentinel|two words/);
    await click("#run");
    await eventually("the configured Stop completes", output, value => /task stopped/i.test(value));
    for (const pid of [data.pid, data.child]) {
      await eventually("the configured process group is gone", () => {
        try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
      });
    }
    const marker = path.join(fixture, "runtime", "launched.marker");
    await rename(marker, path.join(fixture, "first-launch.marker"));

    const sessionOverrides = async value => {
      await click('[data-view="tasks"]');
      await click("#run-configurations");
      await set("#run-config-session", value);
      await click("#run-config-save");
      await eventually("the run configuration editor closes", () => js("return !document.querySelector('#run-config-dialog').open;"));
    };
    await sessionOverrides("PROFILE_SESSION=session-only-sentinel\nPROFILE_EXIT_EARLY=1");
    await click("#run");
    const leaderExited = await eventually("the configured leader exits before its same-group child", output,
      value => /configured-start \{[^\n]+\}[\s\S]*exit code 0/.test(value), 30_000);
    const retired = JSON.parse(leaderExited.match(/configured-start (\{[^\n]+\})/)[1]);
    for (const processId of [retired.pid, retired.child]) assert.throws(() => process.kill(processId, 0), { code: "ESRCH" });
    await rename(marker, path.join(fixture, "leader-first.marker"));
    await sessionOverrides("PROFILE_SESSION=session-only-sentinel");

    await js(`window.__invalidRun = null;
      void window.__ironTest.attemptConfiguredRun('./configured-module', { directory: 'runtime', args: ['bad\\0argument'], environment: {} })
        .then(() => window.__invalidRun = 'unexpected admission', error => window.__invalidRun = String(error));
      return true;`);
    await eventually("Rust rejects an invalid host argument before admission", () => js("return window.__invalidRun;"), value => /supported argument or environment limits/i.test(value ?? ""));
    await assert.rejects(stat(marker), { code: "ENOENT" });

    const cleanup = directory => eventually("the executable directory is retired", async () => {
      try { await stat(directory); return false; } catch (error) { return error.code === "ENOENT"; }
    });
    const releaseHandoff = () => js("void window.__ironTest.runHandoff(false); return true;");
    try {
      const stopped = await holdConfiguredBuild();
      await click("#run");
      const cancelled = await eventually("Stop finishes the held task", output, value => /task stopped/i.test(value));
      assert.equal((cancelled.match(/Task stopped/gi) ?? []).length, 1);
      assert.doesNotMatch(cancelled, /configured-start/);
      await cleanup(stopped);
      await assert.rejects(stat(marker), { code: "ENOENT" });

      const replaced = await holdConfiguredBuild();
      const runtime = path.join(fixture, "runtime");
      const backup = path.join(fixture, "runtime-backup");
      await rename(runtime, backup);
      await symlink(backup, runtime);
      try {
        await releaseHandoff();
        const invalid = await eventually("a replaced directory cannot admit the executable", output,
          value => /Open configured working directory[\s\S]*ended without an exit code/.test(value));
        assert.doesNotMatch(invalid, /configured-start/);
        assert.equal((invalid.match(/ended without an exit code/g) ?? []).length, 1);
        await cleanup(replaced);
        await click("#run");
        await eventually("a preexisting symlink is rejected before build admission", () => text("#toast"), value => /Open configured working directory/.test(value));
        assert.equal((await output()).match(/Build configured Go package/g)?.length, 1);
      } finally {
        await rename(runtime, path.join(fixture, "runtime-link"));
        await rename(backup, runtime);
      }

      const retired = await holdConfiguredBuild();
      await openProjectControl("#open-folder");
      await eventually("project transition asks before stopping a held Run", () => js("return document.querySelector('#project-transition-dialog').open;"));
      await click("#project-transition-continue");
      await eventually("the reloaded project restores the selected configuration", () => js(`
        const picker = document.querySelector('#run-target');
        return !document.querySelector('#open-folder').disabled && picker.selectedOptions[0]?.textContent.includes('Configured fixture');
      `));
      await cleanup(retired);
      assert.doesNotMatch(await output(), /configured-start|Task stopped|Build configured Go package/);
      await assert.rejects(stat(marker), { code: "ENOENT" });
    } finally { await releaseHandoff(); }

    const changePackage = async packageName => {
      await click('[data-view="tasks"]');
      await click("#run-configurations");
      await set("#run-config-package", packageName);
      await click("#run-config-save");
      await eventually("the run configuration changes package", () => js("return document.querySelector('#run-target').title;"), value => value.endsWith(packageName));
    };
    const library = path.join(module, "library");
    await mkdir(library);
    await writeFile(path.join(library, "library.go"), "package library\n\nfunc Value() int { return 1 }\n");
    await changePackage("./configured-module/library");
    await click("#run");
    const archive = await eventually("a built library never launches as an executable", output,
      value => /did not build a macOS executable[\s\S]*ended without an exit code/.test(value));
    assert.equal((archive.match(/ended without an exit code/g) ?? []).length, 1);
    assert.doesNotMatch(archive, /configured-start/);

    await changePackage("./configured-module");
    const program = path.join(module, "main.go");
    const valid = await readFile(program, "utf8");
    await writeFile(program, valid + "\nthis does not compile\n");
    try {
      await click("#run");
      const failed = await eventually("a build error emits one terminal result", output, value => /exit code 1\b/.test(value));
      assert.equal((failed.match(/exit code 1\b/g) ?? []).length, 1);
      assert.doesNotMatch(failed, /configured-start/);
    } finally { await writeFile(program, valid); }
  });
}

async function reopenGoSuite() {
  await record("a new native app restores the selected Go configuration without session secrets", async () => {
    await js(`const key = Object.keys(localStorage).find(key => key.startsWith('irongo.runConfigurations'));
      const record = JSON.parse(localStorage.getItem(key));
      record.profiles.push({ ...record.profiles[0], id: 'corrupted', name: 'Malformed environment', environment: { 'A=B': 'invalid' } });
      record.profiles.push({ ...record.profiles[0], id: 'missing-argv', name: 'Missing arguments', args: undefined });
      localStorage.setItem(key, JSON.stringify(record)); return true;`);
    await openProjectControl("#welcome-open");
    await eventually("the new app restores the selected configuration", () => js(`
      const picker = document.querySelector('#run-target');
      return !document.querySelector('#run').disabled && picker.selectedOptions[0]?.textContent.includes('Configured fixture');
    `));
    assert.doesNotMatch(await output(), /configured-start|Build configured Go package/);
    assert.equal(await js("return [...document.querySelector('#run-target').options].some(option => /configuration:(corrupted|missing-argv)/.test(option.value));"), false);
    const saved = await js(`return Object.keys(localStorage).filter(key => key.startsWith('irongo.runConfigurations')).map(key => localStorage.getItem(key));`);
    assert.match(saved.join(""), /Configured fixture/);
    assert.doesNotMatch(saved.join(""), /session-only-sentinel|PROFILE_SESSION/);
    await click('[data-view="tasks"]');
    await click("#run-configurations");
    await set("#run-config-name", "This cannot be saved");
    await js(`window.__originalRunPreferenceSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('irongo.runConfigurations')) throw new Error('test storage failure');
        return window.__originalRunPreferenceSet.call(this, key, value);
      }; return true;`);
    try {
      await click("#run-config-save");
      await eventually("a failed preference write stays visible in the dialog", () => text("#run-config-error"), value => /Previous settings were kept/i.test(value));
      assert.equal(await js("return document.querySelector('#run-config-dialog').open;"), true);
      assert.match(await js("return document.querySelector('#run-target').selectedOptions[0].textContent;"), /Configured fixture/);
    } finally { await js("Storage.prototype.setItem = window.__originalRunPreferenceSet; return true;"); }
    await click('[data-dialog-close="run-config-dialog"]');
    await click("#run");
    const actual = await eventually("the restored configuration launches from its saved settings", output,
      value => /configured-start \{[^\n]+\}/.test(value), 30_000);
    const data = JSON.parse(actual.match(/configured-start (\{[^\n]+\})/)[1]);
    assert.deepEqual(data.args, ["", "two words", "-flag"]);
    assert.equal(data.cwd, path.join(fixture, "runtime"));
    assert.equal(data.gowork, "invalid-for-build");
    assert.equal(data.env, "with = sign ");
    assert.equal(data.session, "");
    await click("#run");
    await eventually("the restored configuration stops normally", output, value => /task stopped/i.test(value));
    await chooseCommand("new project");
    await set("#form-name", "different-run-project");
    await set("#form-module", "example.com/different-run-project");
    await click("#form-submit");
    await eventually("a different project is open", current, state => state?.root?.endsWith("/different-run-project"));
    assert.equal(await js("return [...document.querySelector('#run-target').options].some(option => option.value.startsWith('configuration:'))"), false);
    await openProjectControl("#open-folder");
    await eventually("the saved workspace is active again", () => js(`
      return !document.querySelector('#run').disabled && document.querySelector('#run-target').selectedOptions[0]?.textContent.includes('Configured fixture');
    `));
    const pending = await holdConfiguredBuild();
    await writeFile(path.join(artifacts, "pending-run-directory.txt"), pending);
  });
}

async function openTestFile() {
  await click("#quick-open");
  await set("#palette-text", "report_test.go");
  await click("#palette-options button");
  await eventually("test file is active", current, state => state?.path === "internal/status/report_test.go");
}

async function goScopeCases() {
  await record("current and custom Go scopes run the selected real package", async () => {
    await openTestFile();
    await click('[data-view="tasks"]');
    await js("document.querySelector('#advanced-targets').open = true; return true;");
    const scope = value => js("const select = document.querySelector('#package-scope'); select.value = arguments[0]; select.dispatchEvent(new Event('change')); return true;", value);
    await scope("current");
    await click('[data-task="test"]');
    await eventually("current-package test", output, value => /go test -json -fullpath \.\/internal\/status[\s\S]*PASS: TestSummary[\s\S]*exit code 0/.test(value), 30_000);
    await scope("custom");
    await set("#task-scope", "./cmd/orbit");
    await click('[data-task="test"]');
    await eventually("custom scope test", output, value => /go test -json -fullpath \.\/cmd\/orbit[\s\S]*exit code 0/.test(value), 30_000);
  });
}

async function debugSuite() {
  await probeTools({ gopls: true, delve: true });
  await openOrbit();
  await openTestFile();
      await record("Debug Test at Cursor pauses at a real breakpoint and continues the test", async () => {
        await clickGlyphBreakpoint(9);
        await eventually("gopls ready for caret test", current, state => state?.gopls === "ready", 30_000);
        await js("window.__ironTest.revealLine(9); return true;");
        await prepareKeyboardCommand("debug test at cursor");
        await enterKeyboardCommand();
        await eventually("debuggee stops on line 9", () => text("#status"), value => /Breakpoint hit.*report_test\.go:9/.test(value), 60_000);
        await click("#debug-next");
        await eventually("stepped to the next source line", () => text("#status"), value => /Paused.*report_test\.go:(10|11)/.test(value), 15_000);
        await click("#debug-continue");
        await eventually("debug test finished", () => text("#status"), value => /Debug session finished/i.test(value), 15_000);
      });
      await record("Delve Stop and project switch retire a paused session and admit a fresh one", async () => {
        const reportTest = path.join(fixture, "internal/status/report_test.go");
        const marker = path.join(home, "test-inferior.pid");
        await js("window.__ironTest.revealLine(9); document.dispatchEvent(new KeyboardEvent('keydown', {key:'F9', bubbles:true,cancelable:true})); return true;");
        await eventually("the first scenario's breakpoint is cleared", () => js("return !document.querySelector('#editor .debug-breakpoint');"));
        await writeFile(reportTest, (await readFile(reportTest, "utf8"))
          .replace('"testing"', '"testing"; "os"; "strconv"')
          .replace("func TestSummary(t *testing.T) {", `func TestSummary(t *testing.T) {\n\tif err := os.WriteFile(${JSON.stringify(marker)}, []byte(strconv.Itoa(os.Getpid())), 0600); err != nil { t.Fatal(err) }`));
        await eventually("the active test model contains the disposable PID probe", current, entry => entry?.text.includes("os.Getpid()"));
        await placeBreakpoint(10);
        const paused = async () => {
          await writeFile(marker, "");
          await clickCodeLens("Debug TestSummary");
          await eventually("Delve paused after recording the inferior PID", () => text("#status"), value => /Breakpoint hit.*report_test\.go:10/.test(value), 60_000);
          const inferior = await eventually("real test executable reports its PID", async () => Number(await readFile(marker, "utf8")), pid => Number.isInteger(pid) && pid > 0);
          process.kill(inferior, 0);
          const adapter = await eventually("owned Delve child", () => {
            const processes = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" });
            for (const row of processes.split("\n")) {
              const entry = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
              if (entry && Number(entry[2]) === app.child.pid && path.basename(entry[3]) === "dlv") return Number(entry[1]);
            }
          });
          return { adapter, inferior };
        };
        const gone = (label, pid) => eventually(label, () => {
          try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
        });

        const holdScopes = () => js("window.__ironTest.holdDebugScopes(); return true;");
        const scopesAreHeld = () => eventually("the real scopes response is held", () => js("return window.__ironTest.debugScopesHeld();"));
        const releaseScopes = () => js("window.__ironTest.releaseDebugScopes(); return true;");
        await holdScopes();
        try {
          const stopped = await paused();
          await scopesAreHeld();
          await click("#debug-stop");
          await eventually("Debug Stop clears controls and inspection", () => js("return document.querySelector('#debug-controls').hidden && document.querySelector('#debug-tab').hidden && !document.querySelector('#run').disabled;"));
          await gone("Debug Stop reaps Delve", stopped.adapter);
          await gone("Debug Stop reaps the actual test executable", stopped.inferior);
        } finally { await releaseScopes(); }

        await holdScopes();
        try {
          const switched = await paused();
          await scopesAreHeld();
          await openProjectControl("#open-folder");
          await eventually("switch confirms active debug session", () => js("return document.querySelector('#project-transition-dialog').open;"));
          assert.match(await text("#project-transition-description"), /debug session will be stopped/i);
          await click("#project-transition-continue");
          await eventually("replacement workspace resets debug and the active tab", current, state => state?.path === "cmd/orbit/main.go");
          await eventually("switch clears debug controls and starts gopls", async () => ({ native: await current(), hidden: await js("return document.querySelector('#debug-controls').hidden && document.querySelector('#debug-tab').hidden;") }), state => state.native?.gopls === "ready" && state.hidden);
          await gone("workspace switch reaps Delve", switched.adapter);
          await gone("workspace switch reaps the actual test executable", switched.inferior);
        } finally { await releaseScopes(); }

        await click("#quick-open");
        await set("#palette-text", "report_test.go");
        await click("#palette-options button");
        await eventually("new session test file", current, state => state?.path === "internal/status/report_test.go");
        await placeBreakpoint(10);
        const replacement = await paused();
        await click("#debug-stop");
        await eventually("replacement Debug Stop clears controls", () => js("return document.querySelector('#debug-controls').hidden && !document.querySelector('#run').disabled;"));
        await gone("replacement Delve is reaped", replacement.adapter);
        await gone("replacement test executable is reaped", replacement.inferior);
       });
  await record("inspects a real paused stack and local variables and steps into and out of a call", async () => {
    const relative = "internal/status/inspect_test.go";
    const source = `package status

import "testing"

type inspectionData struct { Label string }

func TestInspection(t *testing.T) {
	if inspectLocals() != 42 { t.Fatal("unexpected result") }
}

func inspectLocals() int {
	number := 41
	probe := inspectionData{Label: "orbit"}
	result := inspectionCall(number, probe)
	return result
}

func inspectionCall(number int, probe inspectionData) int {
	return number + len(probe.Label) - 4
}
`;
    await writeFile(path.join(fixture, relative), source);
    await eventually("the inspection fixture is indexed", () => js("return !!document.querySelector('#explorer [data-path=\"internal/status/inspect_test.go\"]');"));
    await click('#explorer [data-path="internal/status/inspect_test.go"]');
    await eventually("the inspection fixture is active", current, entry => entry?.path === relative);
    await clickGlyphBreakpoint(14);
    await clickCodeLens("Debug TestInspection");
    await eventually("the debuggee stops before the nested call", () => text("#status"), value => /Breakpoint hit.*inspect_test\.go:14/.test(value), 60_000);
    await eventually("the selected frame and its caller are visible", () => text("#debug-stack"), value => /inspectLocals[\s\S]*TestInspection/.test(value));
    const frame = name => js(`const button = [...document.querySelectorAll('#debug-stack button')]
      .find(button => button.textContent.includes(arguments[0])); if (!button) return false; button.focus(); button.click(); return true;`, name);
    const selected = () => text('#debug-stack [aria-pressed="true"]');
    const highlight = line => eventually(`line ${line} is highlighted`, () => js(`
      const decorated = window.__ironTest.debugExecutionLines();
      return decorated.length === 1 && decorated[0] === arguments[0] && window.__ironTest.gutterTrace().caret?.lineNumber === arguments[0];`, line));
    await highlight(14);
    assert.match(await selected(), /inspectLocals/);
    assert.equal(await frame("testing.tRunner"), true);
    await eventually("unavailable external frame stays selected", () => text("#status"), value => /source unavailable/.test(value));
    assert.match(await selected(), /testing\.tRunner/);
    assert.equal(await frame("TestInspection"), true);
    await eventually("the caller frame is selected and revealed", () => text("#status"), value => /inspect_test\.go:8/.test(value));
    await highlight(8);
    assert.equal(await js("return document.activeElement === document.querySelector('#debug-stack [aria-pressed=true]');"), true);
    assert.equal(await frame("inspectLocals"), true);
    await eventually("the original selected frame returns", () => text("#status"), value => /inspect_test\.go:14/.test(value));
    const expand = name => js(`const disclosure = [...document.querySelectorAll('#debug-variables summary')]
      .find(summary => summary.textContent.includes(arguments[0])); if (!disclosure) return false;
      if (!disclosure.parentElement.open) disclosure.click(); return true;`, name);
    await eventually("the selected frame has a Locals scope", () => expand("Locals"));
    await eventually("the scalar local is shown", () => text("#debug-variables"), value => /number[\s\S]*41/.test(value));
    await eventually("the struct can be expanded", () => expand("probe"));
    await eventually("the struct field is shown", () => text("#debug-variables"), value => /Label[\s\S]*orbit/.test(value));
    await click("#debug-step-in");
    const steppedIn = await eventually("Step Into enters the nested call", () => text("#status"), value => /inspect_test\.go:(18|19)/.test(value), 15_000);
    await highlight(Number(steppedIn.split(":").at(-1)));
    assert.match(await selected(), /inspectionCall/);
    await click("#debug-step-out");
    const steppedOut = await eventually("Step Out returns to the caller", () => text("#status"), value => /inspect_test\.go:(14|15)/.test(value), 15_000);
    await highlight(Number(steppedOut.split(":").at(-1)));
    assert.match(await selected(), /inspectLocals/);
    await click("#debug-continue");
    await eventually("the debug test finishes and clears inspection", async () => [await text("#status"), await text("#debug-stack")],
      ([status, stack]) => /Debug session finished/i.test(status) && !stack.trim(), 15_000);
  });
  await record("Debug Go Program uses the selected preset without changing its build context", async () => {
    const program = path.join(fixture, "debug-program");
    const runtime = path.join(fixture, "debug-runtime");
    await Promise.all([mkdir(program), mkdir(runtime)]);
    await writeFile(path.join(fixture, "go.work"), "go 1.22\n\nuse (\n\t.\n\t./debug-program\n)\n");
    await writeFile(path.join(program, "go.mod"), "module example.test/debug-program\n\ngo 1.22\n");
    await writeFile(path.join(program, "main.go"), `package main

import ("encoding/json"; "fmt"; "os"; "os/exec"; "time")

func main() {
	cwd, _ := os.Getwd()
	if err := os.WriteFile("program.marker", []byte(cwd), 0600); err != nil { panic(err) }
	context := map[string]any{"cwd": cwd, "args": append([]string{}, os.Args[1:]...), "gowork": os.Getenv("GOWORK"), "preset": os.Getenv("DEBUG_PRESET"), "pid": os.Getpid()}
	if os.Getenv("DEBUG_PRESET") == "child" {
		child := exec.Command("/bin/sleep", "60")
		if err := child.Start(); err != nil { panic(err) }
		context["child"] = child.Process.Pid
		_ = child.Process.Release()
	}
	encoded, _ := json.Marshal(context)
	fmt.Printf("program-context %s\\n", encoded)
	if os.Getenv("DEBUG_PRESET") == "hold" { time.Sleep(time.Minute) }
}
`);
    await openProjectControl("#open-folder");
    await eventually("the nested executable is discovered", () => js("return Array.from(document.querySelector('#run-target').options, option => option.value);"), targets => targets.includes("./debug-program"));
    await click('[data-view="tasks"]');
    await click("#run-configurations");
    await set("#run-config-name", "Debug context fixture");
    await set("#run-config-package", "./debug-program");
    await set("#run-config-directory", "debug-runtime");
    const args = ["", "two words", "-literal"];
    await set("#run-config-arguments", JSON.stringify(args));
    await set("#run-config-session", "GOWORK=invalid-for-build\nDEBUG_PRESET=session-only");
    await click("#run-config-save");
    await eventually("the same preset is selected for Run and Debug", () => js("return document.querySelector('#run-target').selectedOptions[0]?.textContent;"), value => value?.includes("Debug context fixture"));
    assert.notEqual((await current()).path, "debug-program/main.go");
    const marker = path.join(runtime, "program.marker");
    const programContext = async () => JSON.parse((await eventually("the real Go program reports its context", output,
      value => /program-context \{[^\n]+\}/.test(value), 60_000)).match(/program-context (\{[^\n]+\})/)[1]);
    await click("#run");
    const { pid: runPid, ...runContext } = await programContext();
    assert.ok(runPid > 0);
    assert.deepEqual(runContext, { cwd: runtime, args, gowork: "invalid-for-build", preset: "session-only" });
    await eventually("Run releases its execution slot", () => text("#status"), value => /exit code 0/.test(value));
    await rename(marker, path.join(home, "run.marker"));
    await click("#quick-open");
    await set("#palette-text", "debug-program/main.go");
    await click("#palette-options button");
    await eventually("the executable source is active", current, entry => entry?.path === "debug-program/main.go");
    await placeBreakpoint(7);
    await click('#tabs [data-path="cmd/orbit/main.go"]');
    await eventually("a different source remains active before launch", current, entry => entry?.path === "cmd/orbit/main.go");
    await click("#quick-open");
    await set("#palette-text", ">debug go program");
    await eventually("the executable Debug Go Program command exists", () => text("#palette-options"), value => /Debug Go Program/.test(value));
    await js("document.querySelector('#palette').close(); return true;");
    const launchDebug = () => chooseCommand("debug go program");
    const releaseHandoff = () => js("void window.__ironTest.runHandoff(false); return true;");
    const removed = directory => eventually("the private debug directory is gone", async () => {
      try { await stat(directory); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; }
    });
    const gone = (label, pid) => eventually(label, () => {
      try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
    });
    const held = await holdConfiguredBuild(launchDebug);
    await releaseHandoff();
    await eventually("the selected package hits its real breakpoint", () => text("#status"), value => /Breakpoint hit.*main\.go:7/.test(value), 30_000);
    assert.equal((await current()).path, "debug-program/main.go");
    await eventually("the executable frame is selected", () => text('#debug-stack [aria-pressed="true"]'), value => /main\.main/.test(value));
    await eventually("the program frame's locals are available", () => js(`const locals = [...document.querySelectorAll('#debug-variables summary')]
      .find(node => node.textContent === 'Locals'); if (!locals) return false; if (!locals.parentElement.open) locals.click(); return true;`));
    await eventually("the stopped executable exposes its actual cwd", () => text("#debug-variables"), value => value.includes(`cwd: "${runtime}"`));
    await click("#debug-continue");
    const { pid: debugPid, ...debugContext } = await programContext();
    assert.ok(debugPid > 0 && debugPid !== runPid);
    assert.deepEqual(debugContext, runContext);
    assert.equal(await readFile(marker, "utf8"), runtime);
    await eventually("Debug releases its execution slot", () => text("#status"), value => /Debug session finished/i.test(value));
    await removed(held);
    await gone("the normally finished debuggee is gone", debugPid);
    await rename(marker, path.join(home, "debug.marker"));

    const sourcePath = path.join(program, "main.go");
    const validSource = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, validSource + "\nGo build must fail here\n");
    try {
      await launchDebug();
      await eventually("a compile failure returns the Go lane", () => text("#status"), value => /Debug failed.*Go build/.test(value));
      assert.match(await output(), /syntax error|non-declaration statement/);
      await assert.rejects(stat(marker), { code: "ENOENT" });
    } finally { await writeFile(sourcePath, validSource); }

    try {
      const cancelled = await holdConfiguredBuild(launchDebug);
      await click("#debug-stop");
      await eventually("Stop cancels the build handoff", () => text("#status"), value => /Debug session stopped/.test(value));
      await removed(cancelled);
      await assert.rejects(stat(marker), { code: "ENOENT" });

      const stale = await holdConfiguredBuild(launchDebug);
      const backup = `${runtime}-original`;
      await rename(runtime, backup);
      await mkdir(runtime);
      try {
        await releaseHandoff();
        await eventually("an inode replacement refuses launch", () => text("#status"), value => /working directory was replaced/.test(value));
        await removed(stale);
        await assert.rejects(stat(marker), { code: "ENOENT" });
      } finally {
        await rename(runtime, `${runtime}-replacement`);
        await rename(backup, runtime);
      }

      const abandoned = await holdConfiguredBuild(launchDebug);
      await openProjectControl("#open-folder");
      await eventually("switch confirms the held Debug launch", () => js("return document.querySelector('#project-transition-dialog').open;"));
      await click("#project-transition-continue");
      await removed(abandoned);
      await eventually("fresh workspace and target are ready", () => js("return !document.querySelector('#run-target').disabled && !document.querySelector('#run').disabled;"));
      assert.doesNotMatch(await output(), /program-context|Build debuggable|Debug session stopped/);
      await assert.rejects(stat(marker), { code: "ENOENT" });
    } finally { await releaseHandoff(); }

    await js(`const picker = document.querySelector('#run-target'); picker.value = './debug-program';
      picker.dispatchEvent(new Event('change')); return true;`);
    await launchDebug();
    const { pid: defaultPid, ...defaultContext } = await programContext();
    assert.deepEqual(defaultContext, { cwd: fixture, args: [], gowork: "auto", preset: "" });
    await eventually("default Debug releases the lane", () => text("#status"), value => /Debug session finished/i.test(value));
    await gone("the default debuggee exits", defaultPid);

    const setSessionPreset = async environment => {
      await click('[data-view="tasks"]');
      await click("#run-configurations");
      await eventually("saved preset is present", () => js(`const select = document.querySelector('#run-config-list');
        const option = [...select.options].find(option => option.textContent === 'Debug context fixture');
        if (!option) return false; select.value = option.value; select.dispatchEvent(new Event('change')); return true;`));
      await set("#run-config-session", environment);
      await click("#run-config-save");
    };
    await setSessionPreset("DEBUG_PRESET=child");
    const exiting = await holdConfiguredBuild(launchDebug);
    await releaseHandoff();
    const withChild = await programContext();
    assert.ok(withChild.child > 0);
    await eventually("normal exit releases the execution lane even with a same-group child", () => text("#status"), value => /Debug session finished/.test(value));
    await removed(exiting);
    await gone("the same-group child exits before reuse", withChild.child);
    await setSessionPreset("DEBUG_PRESET=hold");
    const liveDebugger = async () => {
      const directory = await holdConfiguredBuild(launchDebug);
      await releaseHandoff();
      const context = await programContext();
      assert.equal(context.preset, "hold");
      const processes = await eventually("the adapter and backend are live", () => {
        const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")
          .flatMap(row => { const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/); return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : []; });
        const adapter = rows.find(row => row.parent === app.child.pid && row.command.includes(directory) && row.command.includes(" dap "));
        const backend = adapter && rows.find(row => row.parent === adapter.pid && row.command.includes("debugserver"));
        return backend ? [adapter.pid, backend.pid, context.pid] : undefined;
      });
      return { directory, processes };
    };
    const holdDisconnect = hold => js("return window.__ironTest.holdDebugDisconnect(arguments[0]).then(() => true);", hold);
    const assertRetired = async (label, { directory, processes }) => {
      await removed(directory);
      for (const pid of processes) await gone(`${label} retires process ${pid}`, pid);
    };
    await holdDisconnect(true);
    const forced = await liveDebugger();
    await click("#debug-stop");
    await eventually("forced teardown releases the execution lane", () => text("#status"), value => /Debug session stopped/.test(value));
    await assertRetired("Forced Stop", forced);
    await holdDisconnect(false);

    const quitting = await liveDebugger();
    await terminalCheckpoint("Quit with executable debugger");
    try { await js("void window.__ironTest.quitMenu(); return true;"); }
    catch (error) { if (error.cause?.code !== "UND_ERR_SOCKET") throw error; }
    const exit = await Promise.race([app.exited, delay(10_000, { timedOut: true }, { ref: false })]);
    assert.equal(exit.code, 0, "Ordinary Quit waits for executable debugger retirement");
    await assertRetired("Quit", quitting);
  });
}

async function lifecycleTransitions() {
  await record("cancelling a dirty close preserves the buffer, accepting returns to welcome", async () => {
    await selectTarget();
    const previous = (await output()).match(/agent-ready (\d+)/)?.[1];
    await click("#run");
    const ready = await eventually("Go child running before switching", output, value => {
      const current = value.match(/agent-ready (\d+)/)?.[1];
      return current && current !== previous;
    }, 30_000);
    const pid = Number(ready.match(/agent-ready (\d+)/)[1]);
    const alive = () => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
    const unsaved = (await current()).text + "\n// unsaved close acceptance\n";
    await replace(unsaved);
    const active = await current();
    assert.equal(active.dirty, true);
    const confirm = () => eventually("real project transition confirmation", () => js("return document.querySelector('#project-transition-dialog')?.open === true;"));
    await openProjectControl("#open-folder");
    await confirm();
    assert.match(await text("#project-transition-description"), /unsaved edits.*Go task/i);
    await click("#project-transition-cancel");
    await eventually("cancelled Open restores workbench controls", () => js("return !document.querySelector('#open-folder').disabled;"));
    assert.equal(alive(), true, "cancelling Open must leave the child's process running");
    await chooseCommand("close project");
    await confirm();
    await click("#project-transition-cancel");
    await eventually("cancelled transition restores workbench controls", () => js("return !document.querySelector('#open-folder').disabled;"));
    const state = await current();
    assert.equal(state.root, fixture);
    assert.equal(state.text, unsaved);
    assert.equal(state.dirty, true);
    assert.equal(alive(), true, "cancelling Close must leave the child running");
    const activeDisk = path.join(fixture, active.path);
    const readme = path.join(fixture, "README.md");
    const readmeBaseline = await readFile(readme, "utf8");
    const readmeEdit = readmeBaseline + "\nSecond transition save.\n";
    await click('#explorer [data-path="README.md"]');
    await eventually("the second transition buffer is active", current, value => value?.path === "README.md");
    await replace(readmeEdit);
    await writeFile(readme, readmeBaseline + "\nExternal transition conflict.\n");
    await js("window.__cancelNextPickerReady = false; void window.__ironTest.cancelNextPicker().then(() => window.__cancelNextPickerReady = true); return true;");
    await eventually("the fixture picker will cancel", () => js("return window.__cancelNextPickerReady;"));
    await openProjectControl("#open-folder");
    await confirm();
    await click("#project-transition-save");
    await eventually("Save and Continue reports the second conflict instead of opening the picker", () => text("#toast"), value => /README\.md.*changed on disk/i.test(value));
    await eventually("the conflict releases the reservation", () => js("return !document.querySelector('#open-folder').disabled;"));
    assert.equal(await readFile(activeDisk, "utf8"), unsaved);
    assert.equal((await current()).text, readmeEdit);
    assert.equal((await current()).dirty, true);
    assert.equal(alive(), true);
    await writeFile(readme, readmeBaseline);
    await openProjectControl("#open-folder");
    await confirm();
    await click("#project-transition-save");
    await eventually("a cancelled picker keeps the saved project", current, value => value?.root === fixture && value.text === readmeEdit && !value.dirty);
    await eventually("the cancelled picker restores the controls", () => js("return !document.querySelector('#open-folder').disabled;"));
    assert.equal(await readFile(path.join(fixture, active.path), "utf8"), unsaved);
    assert.equal(await readFile(readme, "utf8"), readmeEdit);
    assert.equal(alive(), true);
    await click(`#tabs [data-path="${active.path}"]`);
    await eventually("the original Go tab is active again", current, value => value?.path === active.path);
    await replace(unsaved + "\n// discarded after the cancelled picker\n");
    await chooseCommand("close project");
    await confirm();
    await click("#project-transition-continue");
    await eventually("back at welcome", () => js("return document.querySelector('#project-welcome').hidden === false;"));
    assert.equal((await current()).root ?? null, null);
    assert.equal(await js("return document.querySelector('#run').disabled;"), true);
    assert.equal(await readFile(path.join(fixture, active.path), "utf8"), unsaved);
    await eventually("committed project close stops the old Go child", () => !alive());
  });
  await record("a project without an executable offers Test as its primary action", async () => {
    await rename(path.join(fixture, "cmd"), path.join(fixture, ".hidden-cmd"));
    await openProjectControl("#welcome-open");
    await eventually("library Test toolbar action", () => text("#run"), value => value.trim() === "Test", 5000);
    await click("#run");
    await eventually("library tests run from the toolbar", output, value => /PASS: TestSummary[\s\S]*exit code 0/.test(value), 60_000);
  });
  await record("New Project creates and opens a real Go module", async () => {
    const unsaved = (await current()).text + "\n// discard only after confirming new project\n";
    await replace(unsaved);
    await chooseCommand("new project");
    await set("#form-name", "fresh-go");
    await set("#form-module", "example.com/fresh-go");
    const newRoot = path.join(path.dirname(fixture), "fresh-go");
    const confirmation = () => eventually("New Project confirmation is focused and hit-testable above the form", () => js(`
      const cancel = document.querySelector('#project-transition-cancel');
      const confirm = document.querySelector('#project-transition-continue');
      const hit = button => {
        const bounds = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
      };
      return document.querySelector('#form-dialog').open && document.querySelector('#project-transition-dialog').open
        && document.activeElement === cancel && hit(cancel) && hit(confirm);
    `));
    await click("#form-submit");
    await confirmation();
    await click("#project-transition-cancel");
    await eventually("New Project returns to the intact filled form", () => js("return document.querySelector('#form-dialog').open && !document.querySelector('#form-submit').disabled && document.querySelector('#form-name').value === 'fresh-go';"));
    assert.equal((await current()).text, unsaved);
    await assert.rejects(stat(newRoot), { code: "ENOENT" });
    await click("#form-submit");
    await confirmation();
    await click("#project-transition-continue");
    await eventually("created Go module opens in Monaco", current, state => state?.root === newRoot && state?.path === "main.go", 8000);
    assert.match(await readFile(path.join(newRoot, "go.mod"), "utf8"), /^module example\.com\/fresh-go\n/);
    assert.match(await readFile(path.join(newRoot, "main.go"), "utf8"), /func main\(\)/);
    await eventually("new main package selected", () => js("return document.querySelector('#run-target').value === '.' && !document.querySelector('#run').disabled;"));
    await click("#run");
    await eventually("new project executes", output, value => /Hello from Iron Go![\s\S]*exit code 0/.test(value), 30_000);
  });
  await record("a clean editor exits normally on system Quit", async () => {
    assert.equal((await current()).dirty, false);
    await terminalCheckpoint("clean system Quit");
    requestNativeQuit();
    const result = await Promise.race([app.exited, delay(6000, { code: null, timedOut: true }, { ref: false })]);
    assert.equal(result.code, 0);
  });
}

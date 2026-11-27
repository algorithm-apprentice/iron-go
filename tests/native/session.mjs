import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expectedGoSyntax, goSyntaxSample, renderedGoSyntax } from "../go-syntax-sample.mjs";
import { runtimeClean } from "./plan.mjs";

if (!process.send) throw new Error("Run native acceptance through workbench.mjs.");
const { group, values, driver, artifacts, fixture, home, pid, quitHelper } = JSON.parse(process.argv[2]);
const report = { version: 1, group, cases: [] };
const app = { child: { pid }, exited: new Promise(resolve => {
  process.on("message", message => { if (message?.type === "app-exit") resolve(message.result); });
}) };
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

  if (group === "external") await externalProjectSmoke();
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
      "gopls symbol and reference navigation uses unsaved UTF-16 locations",
      "runs exactly one Go test from its editor action", "whole-line selection highlights the selected number, not its endpoint"]) {
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
      await js("window.__ironTest.holdGoReferences(); return true;");
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
      await js("window.__oldReference.click(); return true;");
      assert.equal(await js("return !!document.querySelector('#tabs [data-path=\"cmd/orbit/navigation.go\"]');"), false);
      assert.equal(await readFile(file, "utf8"), disk);
      await click("#close-references");
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
    await eventually("current-package test", output, value => /go test -v \.\/internal\/status[\s\S]*PASS: TestSummary[\s\S]*exit code 0/.test(value), 30_000);
    await scope("custom");
    await set("#task-scope", "./cmd/orbit");
    await click('[data-task="test"]');
    await eventually("custom scope test", output, value => /go test -v \.\/cmd\/orbit[\s\S]*exit code 0/.test(value), 30_000);
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
        const paused = async () => {
          await clickCodeLens("Debug TestSummary");
          await eventually("Delve paused", () => text("#status"), value => /Breakpoint hit.*report_test\.go:9/.test(value), 60_000);
          return await eventually("owned Delve child", () => {
            const processes = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" });
            for (const row of processes.split("\n")) {
              const entry = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
              if (entry && Number(entry[2]) === app.child.pid && path.basename(entry[3]) === "dlv") return Number(entry[1]);
            }
          });
        };
        const gone = (label, pid) => eventually(label, () => {
          try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
        });

        const stopped = await paused();
        await click("#debug-stop");
        await eventually("Debug Stop clears controls", () => js("return document.querySelector('#debug-controls').hidden && !document.querySelector('#run').disabled;"));
        await gone("Debug Stop reaps Delve", stopped);

        const switched = await paused();
        await openProjectControl("#open-folder");
        await eventually("switch confirms active debug session", () => js("return document.querySelector('#project-transition-dialog').open;"));
        assert.match(await text("#project-transition-description"), /debug session will be stopped/i);
        await click("#project-transition-continue");
        await eventually("replacement workspace resets debug and the active tab", current, state => state?.path === "cmd/orbit/main.go");
        await eventually("switch clears debug controls and starts gopls", async () => ({ native: await current(), hidden: await js("return document.querySelector('#debug-controls').hidden;") }), state => state.native?.gopls === "ready" && state.hidden);
        await gone("workspace switch reaps Delve", switched);

        await click("#quick-open");
        await set("#palette-text", "report_test.go");
        await click("#palette-options button");
        await eventually("new session test file", current, state => state?.path === "internal/status/report_test.go");
        await placeBreakpoint(9);
        const replacement = await paused();
        await click("#debug-stop");
        await eventually("replacement Debug Stop clears controls", () => js("return document.querySelector('#debug-controls').hidden && !document.querySelector('#run').disabled;"));
        await gone("replacement Delve is reaped", replacement);
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

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build, preview } from "vite";
import { runtimeClean } from "../native/plan.mjs";
import { expectedGoSyntax, goSyntaxSample, renderedGoSyntax } from "../go-syntax-sample.mjs";

let server, browser, url, assets;
const fixture = fileURLToPath(new URL("../fixtures/orbit", import.meta.url));
const documentsFixture = new URL("./fixtures/documents.html", import.meta.url);
before(async () => {
  assets = await mkdtemp(join(tmpdir(), "iron-go-ui-"));
  await build({ build: { outDir: assets, emptyOutDir: true, rolldownOptions: {
    input: ["index.html", fileURLToPath(documentsFixture)],
  } }, logLevel: "warn" });
  server = await preview({ build: { outDir: assets }, preview: { port: 0, host: "127.0.0.1" } });
  url = server.resolvedUrls.local[0];
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  if (assets) await rm(assets, { recursive: true, force: true });
});

async function openFixture(page) {
  await page.locator("#import-folder").setInputFiles(fixture);
  await page.getByRole("tab", { name: "main.go", exact: true, selected: true }).waitFor({ timeout: 8000 });
}

async function scenario(name, run, withProject = true, entry = "") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let page;
  const logs = [];
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  try {
    page = await context.newPage();
    page.on("pageerror", error => logs.push(error.stack));
    page.on("console", message => { if (message.type() === "error") logs.push(message.text()); });
    await page.goto(new URL(entry, url).href);
    if (!entry) await page.locator("#project-welcome").waitFor({ timeout: 8000 });
    if (withProject) await openFixture(page);
    await run(page);
    assert.deepEqual(logs, []);
  } catch (error) {
    const dir = `test-results/ui/${name}`;
    await mkdir(dir, { recursive: true });
    await page?.screenshot({ path: `${dir}/workbench.png`, timeout: 3000 }).catch(() => {});
    await context.tracing.stop({ path: `${dir}/trace.zip` });
    await writeFile(`${dir}/browser.log`, logs.join("\n"));
    throw error;
  } finally {
    await context.close();
  }
}

test("the native startup oracle rejects real uncaught errors and promise rejections", async () => {
  const page = await browser.newPage();
  try {
    await page.addInitScript({ path: fileURLToPath(new URL("../native/acceptance-errors.js", import.meta.url)) });
    await page.goto(url);
    runtimeClean(await page.evaluate(() => window.__ironTestRuntimeErrors()));
    await page.evaluate(() => {
      setTimeout(() => { throw new Error("fixture uncaught exception"); });
      void Promise.reject(new Error("fixture unhandled rejection"));
    });
    await page.waitForFunction(() => window.__ironTestRuntimeErrors().length === 2);
    const observed = await page.evaluate(() => window.__ironTestRuntimeErrors());
    assert.match(observed.find(entry => entry.kind === "error").detail, /fixture uncaught exception/);
    assert.match(observed.find(entry => entry.kind === "unhandledrejection").detail, /fixture unhandled rejection/);
    assert.throws(() => runtimeClean(observed), /Unexpected WebView errors/);
  } finally { await page.close(); }
});

function documentScenario(name, run) {
  return scenario(name, async page => {
    await page.waitForFunction(() => !!window.documents);
    await run(page);
  }, false, "tests/ui/fixtures/documents.html");
}

test("a delayed reload cannot replace a committed save's text or baseline", async () => {
  await documentScenario("reload-after-save", async page => {
    const outcome = await page.evaluate(async () => {
      const { documents: docs, documentState } = window;
      const read = Promise.withResolvers();
      const write = Promise.withResolvers();
      let firstRead = true;
      let sent;
      docs.reset({
        read: () => { if (!firstRead) return read.promise; firstRead = false; return Promise.resolve("original"); },
        save: (_path, expected, text) => { sent = { expected, text }; return write.promise; },
      });
      const tab = await docs.open("data.txt");
      tab.model.setValue("committed");
      const reload = docs.reload(tab);
      const save = docs.save(tab);
      write.resolve();
      const saved = await save;
      read.resolve("original");
      return { saved, reloaded: await reload, sent, ...documentState(tab) };
    });
    assert.deepEqual(outcome, {
      saved: true, reloaded: false, sent: { expected: "original", text: "committed" },
      text: "committed", disk: "committed", dirty: false,
    });
  });
});

test("an external observation cannot apply across a newer edit or save baseline", async () => {
  await documentScenario("external-observation-races", async page => {
    const outcome = await page.evaluate(async () => {
      const { documents: docs, documentState } = window;
      let disk = "original";
      let observation = Promise.withResolvers();
      docs.reset({ read: async () => disk, inspect: () => observation.promise, save: async (_path, _expected, text) => { disk = text; } });
      const tab = await docs.open("data.txt");
      const beforeEdit = docs.reconcile(tab);
      tab.model.setValue("new edit");
      observation.resolve({ kind: "text", text: "external" });
      const editResult = await beforeEdit;
      const beforeSave = docs.reconcile(tab);
      await docs.save(tab);
      const saveResult = await beforeSave;
      observation = Promise.withResolvers();
      observation.resolve({ kind: "text", text: disk });
      await docs.reconcile(tab);
      return { editResult, saveResult, diskChange: tab.diskChange ?? null, ...documentState(tab) };
    });
    assert.deepEqual(outcome, { editResult: false, saveResult: false, diskChange: null,
      text: "new edit", disk: "new edit", dirty: false });
  });
});

test("saving to a new path fences aliases and old observations and keeps later edits", async () => {
  await documentScenario("save-to-new-path", async page => {
    const outcome = await page.evaluate(async () => {
      const { documents: docs, documentState } = window;
      const observation = Promise.withResolvers();
      const pendingOpen = Promise.withResolvers();
      const write = Promise.withResolvers();
      const writes = [];
      docs.reset({
        read: path => path === "pending.txt" ? pendingOpen.promise : Promise.resolve("original"),
        inspect: () => observation.promise,
        createFromBuffer: (path, text) => { writes.push([path, text]); return write.promise; },
        save: async (path, expected, text) => { writes.push([path, expected, text]); },
      });
      const source = await docs.open("source.txt");
      await docs.open("Résumé.txt", { activate: false });
      await docs.open("straße.txt", { activate: false });
      const pending = docs.open("pending.txt", { activate: false });
      const refused = [];
      for (const path of ["re\u0301sume\u0301.TXT", "STRAẞE.txt", "STRASSE.txt", "PENDING.txt", "SOURCE.txt"]) {
        try { await docs.saveToNew(source, path); } catch { refused.push(path); }
      }
      pendingOpen.resolve("an open tab");
      await pending;
      const obsolete = docs.reconcile(source);
      source.model.setValue("submitted");
      const saving = docs.saveToNew(source, "rescue.txt");
      const aliasWasBlocked = await docs.open("RESCUE.txt") === undefined;
      source.model.setValue("newer edit");
      write.resolve("rescue.txt");
      const rebound = await saving;
      observation.resolve({ kind: "missing" });
      await obsolete;
      const state = documentState(rebound);
      await docs.save(rebound);
      return { aliasWasBlocked, refused: refused.length, sourceStillOpen: docs.tabs.has("source.txt"), active: docs.active.path,
        diskChange: rebound.diskChange ?? null, state, writes };
    });
    assert.deepEqual(outcome, {
      aliasWasBlocked: true, refused: 5, sourceStillOpen: false, active: "rescue.txt", diskChange: null,
      state: { text: "newer edit", disk: "submitted", dirty: true },
      writes: [["rescue.txt", "submitted"], ["rescue.txt", "submitted", "newer edit"]],
    });
  });
});

test("clean external reload is undoable against the new baseline and adopts a new encoding convention", async () => {
  await documentScenario("external-reload-baseline", async page => {
    const outcome = await page.evaluate(async () => {
      const { documents: docs, documentState } = window;
      let disk = "original\n";
      docs.reset({ read: async () => disk, inspect: async () => ({ kind: "text", text: disk }) });
      const tab = await docs.open("data.txt");
      disk = "external\n";
      await docs.reconcile(tab);
      const reloaded = documentState(tab);
      await tab.model.undo();
      const undone = documentState(tab);
      await tab.model.redo();
      disk = "\ufeffdifferent\r\nlines\r\n";
      await docs.reconcile(tab);
      return { reloaded, undone, convention: documentState(tab) };
    });
    assert.deepEqual(outcome, {
      reloaded: { text: "external\n", disk: "external\n", dirty: false },
      undone: { text: "original\n", disk: "external\n", dirty: true },
      convention: { text: "\ufeffdifferent\r\nlines\r\n", disk: "\ufeffdifferent\r\nlines\r\n", dirty: false },
    });
  });
});

test("Escape cancels a loading disk comparison and mixed endings cannot authorize a write", async () => {
  await documentScenario("cancel-disk-comparison", async page => {
    await page.evaluate(() => {
      const disk = Promise.withResolvers();
      const details = { path: "data.txt", language: "plaintext", buffer: "editor\n", dirty: true, current: () => true };
      window.pendingDiskReview = { details, disk, result: window.diskComparison({ ...details, load: () => disk.promise }) };
    });
    const dialog = page.getByRole("dialog", { name: "Compare with Disk" });
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Reading the disk version/);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.evaluate(async () => {
      const { details, disk, result } = window.pendingDiskReview;
      if (await result !== undefined) throw new Error("Escape authorized an action");
      disk.resolve({ kind: "text", text: "late disk read", version: "late" });
      window.mixedDiskReview = window.diskComparison({ ...details,
        load: async () => ({ kind: "text", text: "\ufeffdisk\r\nline\n", version: "mixed" }) });
    });
    await dialog.getByText(/Mixed line endings/).waitFor();
    assert.match(await dialog.locator("#disk-compare-original").innerText(), /UTF-8 BOM · CRLF \/ LF/);
    assert.equal(await dialog.getByRole("button", { name: "Reload Reviewed Disk Version" }).isDisabled(), true);
    assert.equal(await dialog.getByRole("button", { name: "Save Over Reviewed Disk Version" }).isDisabled(), true);
    await dialog.getByRole("button", { name: "Keep Editing" }).click();
    assert.equal(await page.evaluate(async () => (await window.mixedDiskReview) === undefined), true);
    assert.equal(await page.locator("#disk-compare-view .monaco-editor").count(), 0);
  });
});

test("rapid disk comparison reopen displays new snapshots without a diff worker", async () => {
  await documentScenario("reopen-disk-comparison", async page => {
    await page.evaluate(() => {
      const viewport = document.querySelector("#disk-compare-view");
      Object.assign(viewport.style, { width: "650px", height: "200px", display: "grid", gridTemplateColumns: "1fr 1fr" });
      let workers = 0;
      const startWorker = window.MonacoEnvironment.getWorker;
      window.MonacoEnvironment.getWorker = (...args) => { workers++; return startWorker(...args); };
      window.comparisonWorkers = () => workers;
      const shared = Array.from({ length: 60 }, () => "unchanged").join("\n") + "\n";
      window.openComparison = label => window.diskComparison({ path: "data.txt", language: "plaintext", dirty: true,
        buffer: shared + `${label} editor`, current: () => true,
        load: async () => ({ kind: "text", text: shared + `${label} disk`, version: label }) });
      window.firstComparison = window.openComparison("first");
    });
    const disk = page.locator("#disk-compare-view .original .view-lines");
    const buffer = page.locator("#disk-compare-view .modified .view-lines");
    await disk.getByText(/first\s+disk/).waitFor();
    await page.getByRole("button", { name: "Keep Editing" }).click();
    const remaining = await page.evaluate(async () => {
      await window.firstComparison;
      const count = window.workflowFixture.monaco.editor.getModels().length;
      window.secondComparison = window.openComparison("second");
      return count;
    });
    assert.equal(remaining, 0);
    await disk.getByText(/second\s+disk/).waitFor();
    await buffer.getByText(/second\s+editor/).waitFor();
    assert.equal(await page.evaluate(() => window.comparisonWorkers()), 0);
    await page.getByRole("button", { name: "Keep Editing" }).click();
    assert.equal(await page.evaluate(async () => {
      await window.secondComparison;
      return window.workflowFixture.monaco.editor.getModels().length;
    }), 0);
  });
});

test("feedback tabs use one keyboard stop and preserve outside focus when a pane disappears", async () => {
  await documentScenario("feedback-tab-focus", async page => {
    await page.evaluate(() => {
      window.feedbackFixture = window.mountFeedback();
      document.querySelector("#debug-tab").hidden = false;
      window.feedbackFixture.show("debug");
      const outside = document.createElement("button");
      outside.id = "outside-feedback";
      outside.textContent = "Outside feedback";
      document.body.append(outside);
    });
    const tabStops = () => page.locator("[data-panel]:visible[tabindex='0']").evaluateAll(nodes => nodes.map(node => node.id));
    assert.deepEqual(await tabStops(), ["debug-tab"]);
    await page.locator("#debug-tab").focus();
    await page.keyboard.press("ArrowRight");
    assert.deepEqual(await tabStops(), ["problems-tab"]);
    await page.keyboard.press("End");
    assert.deepEqual(await tabStops(), ["debug-tab"]);
    await page.evaluate(() => window.feedbackFixture.hide("debug"));
    assert.deepEqual(await tabStops(), ["output-tab"]);
    assert.equal(await page.locator("#output-tab").evaluate(tab => document.activeElement === tab), true);
    await page.evaluate(() => {
      document.querySelector("#debug-tab").hidden = false;
      window.feedbackFixture.show("debug");
      document.querySelector("#outside-feedback").focus();
      window.feedbackFixture.hide("debug");
    });
    assert.deepEqual(await tabStops(), ["output-tab"]);
    assert.equal(await page.locator("#outside-feedback").evaluate(tab => document.activeElement === tab), true);
    await page.evaluate(() => {
      document.querySelector("#debug-tab").hidden = false;
      window.feedbackFixture.show("debug");
      window.feedbackFixture.toggle(false);
      window.feedbackFixture.hide("debug");
    });
    assert.equal(await page.locator("#panel").isHidden(), true);
    assert.equal(await page.locator("#output-tab").getAttribute("aria-selected"), "true");
  });
});

test("a stranded buffer requires an explicit reviewed write even if the replacement bytes match", async () => {
  await documentScenario("stranded-path-review", async page => {
    const outcome = await page.evaluate(async () => {
      const { documents: docs } = window;
      const writes = [];
      docs.reset({ readVersioned: async () => ({ text: "same disk bytes", version: "old inode" }),
        save: async (...args) => { writes.push(args); } });
      const tab = await docs.open("source.txt");
      docs.requirePathReview([tab]);
      tab.model.setValue("unsaved text");
      const error = await docs.save(tab).catch(error => error.message);
      const old = { dirty: tab.dirty, changed: tab.diskChange, writes: writes.length };
      await docs.save(tab, { reviewed: { kind: "text", text: "same disk bytes", version: "new inode" } });
      const clean = await docs.open("directory/clean.txt");
      const reservation = docs.reservePaths("directory", "moved");
      const [moved] = docs.rebindPaths("directory", "moved", {}, reservation.affected);
      reservation.release();
      const wasClean = !clean.dirty && !moved.dirty;
      moved.model.setValue("typed before reconciliation");
      const movedError = await docs.save(moved).catch(error => error.message);
      return { error, old, writes, wasClean, movedError };
    });
    assert.match(outcome.error, /Review the current disk version/);
    assert.deepEqual(outcome.old, { dirty: true, changed: "changed", writes: 0 });
    assert.deepEqual(outcome.writes, [["source.txt", "same disk bytes", "unsaved text", "new inode", undefined]]);
    assert.equal(outcome.wasClean, true);
    assert.match(outcome.movedError, /Review the current disk version/);
  });
});

test("a delayed editor-session read cannot restore tabs or viewport into a replacement project", async () => {
  await documentScenario("editor-session-restore-ownership", async page => {
    const outcome = await page.evaluate(async () => {
      const { documents: docs } = window;
      const read = Promise.withResolvers();
      let current = true;
      docs.reset({ read: async () => read.promise });
      const restored = docs.restoreSession({ active: "old.txt", tabs: [{ path: "old.txt", line: 42, column: 8, firstLine: 30 }] },
        new Set(["old.txt"]), () => current);
      current = false;
      docs.reset({ read: async () => "replacement\nline two" });
      await docs.open("new.txt", { target: { lineNumber: 2, column: 3 } });
      read.resolve("old\n".repeat(60));
      return { result: await restored, path: docs.active.path, tabs: [...docs.tabs.keys()], position: docs.editor.getPosition() };
    });
    assert.deepEqual(outcome, { result: { opened: false, skipped: 0 }, path: "new.txt", tabs: ["new.txt"], position: { lineNumber: 2, column: 3 } });
  });
});

test("draft recording coalesces a blocked write and resumes queued work after a refused Quit", async () => {
  await documentScenario("draft-write-coalescing", async page => {
    const outcome = await page.evaluate(async () => {
      const { documents: docs, workflowFixture: { DraftRecorder, host } } = window;
      const indicator = document.createElement("span");
      const recorder = new DraftRecorder(indicator);
      const folder = { id: 1, path: "/project" };
      const requests = [];
      host.writeDraft = (_id, _path, _revision, payload) => {
        const reply = Promise.withResolvers();
        requests.push({ ...payload, reply });
        return reply.promise;
      };
      docs.reset({ readVersioned: async () => ({ text: "baseline", version: "old" }) });
      const tab = await docs.open("source.txt");
      tab.model.setValue("old edit");
      recorder.schedule(folder, tab, true);
      tab.model.setValue("intermediate edit");
      recorder.schedule(folder, tab, true);
      tab.model.setValue("latest edit");
      recorder.schedule(folder, tab, true);
      const duringBlocked = requests.length;
      requests[0].reply.resolve();
      await new Promise(requestAnimationFrame);
      const thaw = recorder.freeze();
      requests[1].reply.reject(new Error("The native writer was staged for Quit."));
      await new Promise(requestAnimationFrame);
      const duringFreeze = requests.length;
      thaw();
      requests[2].reply.resolve();
      await recorder.settled(tab);
      return { duringBlocked, duringFreeze, texts: requests.map(request => request.text), marker: indicator.textContent };
    });
    assert.deepEqual(outcome, { duringBlocked: 1, duringFreeze: 2, texts: ["old edit", "latest edit", "latest edit"], marker: "Draft saved" });
  });
});

test("ordinary and reviewed reload leave dirty text intact until draft retirement succeeds", async () => {
  await documentScenario("draft-reload-barrier", async page => {
    const outcome = await page.evaluate(async () => {
      const { documents: docs, documentState } = window;
      const results = [];
      for (const reviewed of [false, true]) {
        const before = { kind: "text", text: "old", version: "1" };
        const after = { kind: "text", text: "new", version: "2" };
        let current = before;
        docs.reset({ readVersioned: async () => current, inspect: async () => current });
        const tab = await docs.open("main.go");
        current = after;
        tab.model.setValue("local");
        const staged = Promise.withResolvers();
        const retire = Promise.withResolvers();
        const reloading = docs.reload(tab, reviewed ? after : undefined, () => { staged.resolve(); return retire.promise; });
        await staged.promise;
        const waiting = documentState(tab);
        retire.reject(new Error("Recovery storage locked."));
        const error = await reloading.catch(error => error.message);
        const failed = documentState(tab);
        const retried = await docs.reload(tab, reviewed ? after : undefined, async () => {});
        results.push({ waiting, error, failed, retried, reloaded: documentState(tab) });
      }
      return results;
    });
    const dirty = { text: "local", disk: "old", dirty: true };
    assert.deepEqual(outcome, Array.from({ length: 2 }, () => ({ waiting: dirty, error: "Recovery storage locked.", failed: dirty,
      retried: true, reloaded: { text: "new", disk: "new", dirty: false } })));
  });
});

test("format-on-save writes only its captured bytes while typing continues across both waits", async () => {
  await documentScenario("format-save-snapshot", async page => {
    const outcome = await page.evaluate(async () => {
      const { documents: docs, documentState } = window;
      const disk = "\ufeffpackage fixture\r\n";
      const submitted = "\ufeffpackage fixture\r\nvar  n=1\r\n";
      const atWrite = Promise.withResolvers();
      const formatter = Promise.withResolvers();
      const write = Promise.withResolvers();
      let formatterInput;
      docs.reset({ read: async () => disk, save: async (_path, expected, bytes) => {
        atWrite.resolve({ expected, bytes });
        await write.promise;
      } });
      const tab = await docs.open("source.go");
      tab.model.setValue(submitted);
      const saving = docs.save(tab, { format: async text => { formatterInput = text; return formatter.promise; } });
      tab.model.setValue(submitted + "// during gofmt\r\n");
      formatter.resolve("package fixture\n\nvar n = 1\n");
      const output = await atWrite.promise;
      const latest = submitted + "// during gofmt\r\n// during write\r\n";
      tab.model.setValue(latest);
      const other = await docs.open("other.txt");
      write.resolve();
      return { result: await saving, formatterInput, output, state: documentState(tab), active: docs.active === other };
    });
    const formatted = "\ufeffpackage fixture\r\n\r\nvar n = 1\r\n";
    assert.deepEqual(outcome, {
      result: true, formatterInput: "package fixture\r\nvar  n=1\r\n",
      output: { expected: "\ufeffpackage fixture\r\n", bytes: formatted }, active: true,
      state: { text: "\ufeffpackage fixture\r\nvar  n=1\r\n// during gofmt\r\n// during write\r\n", disk: formatted, dirty: true },
    });
  });
});

test("save advances the baseline without discarding typing or reporting an invalidated reload error", async () => {
  await documentScenario("typed-while-saving", async page => {
    const outcome = await page.evaluate(async () => {
      const { documents: docs, documentState } = window;
      const read = Promise.withResolvers();
      const write = Promise.withResolvers();
      const sent = [];
      let firstRead = true;
      docs.reset({
        read: () => { if (!firstRead) return read.promise; firstRead = false; return Promise.resolve("original"); },
        save: (_path, expected, text) => {
          sent.push({ expected, text });
          return sent.length === 1 ? write.promise : Promise.reject(new Error("disk conflict"));
        },
      });
      const tab = await docs.open("data.txt");
      tab.model.setValue("committed");
      const reload = docs.reload(tab);
      const save = docs.save(tab);
      // Rejection without a text version change must still be stale.
      read.reject(new Error("old reload failure"));
      const reloaded = await reload;
      tab.model.setValue("typed meanwhile");
      write.resolve();
      const saved = await save;
      const conflict = await docs.save(tab).catch(error => error.message);
      return { saved, reloaded, conflict, sent, ...documentState(tab) };
    });
    assert.deepEqual(outcome, {
      saved: true, reloaded: false, conflict: "disk conflict", sent: [
        { expected: "original", text: "committed" },
        { expected: "committed", text: "typed meanwhile" },
      ], text: "typed meanwhile", disk: "committed", dirty: true,
    });
  });
});

test("a delayed error cannot leak after closing a tab or replacing a project", async () => {
  await documentScenario("obsolete-file-errors", async page => {
    const outcome = await page.evaluate(async () => {
      const { documents: docs, documentState } = window;
      const read = Promise.withResolvers();
      const format = Promise.withResolvers();
      let reads = 0;
      docs.reset({ read: () => ++reads === 2 ? read.promise : Promise.resolve("original") });
      const tab = await docs.open("main.go");
      const reload = docs.reload(tab);
      docs.close(tab);
      const reopened = await docs.open("main.go");
      read.reject(new Error("closed reload"));
      const reloaded = await reload;
      const formatting = docs.format(reopened, () => format.promise);
      docs.reset({ read: () => Promise.resolve("new project") });
      const active = await docs.open("main.go");
      format.reject(new Error("old project format"));
      return { reloaded, formatted: await formatting, ...documentState(active) };
    });
    assert.deepEqual(outcome, { reloaded: false, formatted: false, text: "new project", disk: "new project", dirty: false });
  });
});

test("a delayed format cannot replace newer edits or write to the newly active tab", async () => {
  await documentScenario("obsolete-format", async page => {
    const outcome = await page.evaluate(async () => {
      const { documents: docs, documentState } = window;
      const format = Promise.withResolvers();
      docs.reset({ read: path => Promise.resolve(path) });
      const original = await docs.open("original.go");
      const formatting = docs.format(original, () => format.promise);
      original.model.setValue("new edit");
      const active = await docs.open("active.go");
      format.resolve("formatted");
      return { formatted: await formatting, original: documentState(original), active: documentState(active) };
    });
    assert.deepEqual(outcome, {
      formatted: false,
      original: { text: "new edit", disk: "original.go", dirty: true },
      active: { text: "active.go", disk: "active.go", dirty: false },
    });
  });
});

test("Run and Debug refuse to dispatch after an edit and undo while a real document saves", async () => {
  await documentScenario("edit-revision-vetoes-launch", async page => {
    const outcome = await page.evaluate(async () => {
      const { documents: docs, workflowFixture: { ExecutionLane } } = window;
      const attempts = [];
      for (const kind of ["run", "debug"]) {
        const lane = new ExecutionLane(() => {});
        const sent = Promise.withResolvers();
        const commit = Promise.withResolvers();
        docs.reset({ read: async path => path, save: async () => { sent.resolve(); await commit.promise; } });
        const other = await docs.open("other.go");
        const tab = await docs.open("saved.go");
        tab.model.setValue("to be committed");
        let launched = false;
        const pending = lane.start(1, kind, {
          revision: () => docs.editRevision,
          dirty: () => docs.dirty,
          save: () => docs.save(tab),
        }, async () => { launched = true; }).catch(error => error.message);
        await sent.promise;
        other.model.pushStackElement();
        other.model.pushEditOperations([], [{ range: other.model.getFullModelRange(), text: "transient edit" }], () => null);
        other.model.pushStackElement();
        await other.model.undo();
        commit.resolve();
        attempts.push({ error: await pending, launched, dirty: docs.dirty });
      }
      return attempts;
    });
    assert.deepEqual(outcome, [
      { error: "Files changed while saving. Run the task again.", launched: false, dirty: false },
      { error: "Files changed while saving. Debug again.", launched: false, dirty: false },
    ]);
  });
});

test("an obsolete Debug pause cannot open a tab, but ordinary navigation can share its read", async () => {
  await documentScenario("stale-debug-navigation", async page => {
    const outcome = await page.evaluate(async () => {
      const { documents: docs } = window;
      const newFile = Promise.withResolvers();
      const sharedFile = Promise.withResolvers();
      const reads = [];
      let pause = 1;
      docs.reset({ read: async path => { reads.push(path); return path === "stale.go" ? newFile.promise : path === "shared.go" ? sharedFile.promise : path; } });
      await docs.open("initial.go");
      const stale = docs.open("stale.go", { focus: true, current: () => pause === 1 });
      const sharedPause = docs.open("shared.go", { focus: true, current: () => pause === 1 });
      pause = 2; // The same workspace started another debug session.
      newFile.resolve("late breakpoint source");
      const old = await stale;
      const before = docs.active.path;
      const ordinary = docs.open("shared.go");
      sharedFile.resolve("ordinary navigation");
      const [ignored, opened] = await Promise.all([sharedPause, ordinary]);
      return { applied: !!old || !!ignored, before, active: docs.active.path, opened: opened.path, paths: [...docs.tabs.keys()], reads };
    });
    assert.deepEqual(outcome, { applied: false, before: "initial.go", active: "shared.go", opened: "shared.go",
      paths: ["initial.go", "shared.go"], reads: ["initial.go", "stale.go", "shared.go"] });
  });
});

test("an obsolete Debug pause that joins an earlier ordinary read cannot steal its activation", async () => {
  await documentScenario("ordinary-navigation-before-debug", async page => {
    const outcome = await page.evaluate(async () => {
      const { documents: docs } = window;
      const shared = Promise.withResolvers();
      let pause = 1;
      let reads = 0;
      docs.reset({ read: async path => path === "next.go" ? (++reads, shared.promise) : path });
      await docs.open("initial.go");
      const ordinary = docs.open("next.go");
      const joined = docs.open("next.go", { focus: true, current: () => pause === 1 });
      pause = 2;
      shared.resolve("ordinary navigation");
      const [opened, obsolete] = await Promise.all([ordinary, joined]);
      return { active: docs.active.path, opened: opened.path, obsolete: !!obsolete, reads };
    });
    assert.deepEqual(outcome, { active: "next.go", opened: "next.go", obsolete: false, reads: 1 });
  });
});

test("Debug terminal-before-admission waits for the eventual server cleanup", async () => {
  await documentScenario("debug-early-terminal", async page => {
    const outcome = await page.evaluate(async () => {
      const { DebugSession } = window.workflowFixture;
      const started = Promise.withResolvers();
      const admission = Promise.withResolvers();
      const cleaning = Promise.withResolvers();
      const cleanup = Promise.withResolvers();
      const done = Promise.withResolvers();
      const trace = [];
      const session = new DebugSession({ id: 1, path: "/old" }, {}, {
        isCurrent: () => true, admitted: () => trace.push("admitted"), closing: () => trace.push("closing"), finished: done.resolve,
      }, {
        debug: (_id, _pkg, events) => { started.resolve(events); return admission.promise; },
        stopDebug: id => { trace.push(id); cleaning.resolve(); return cleanup.promise; },
      });
      let finished = false;
      void done.promise.then(() => finished = true);
      const launch = session.start("main_test.go", "TestMain");
      const emit = await started.promise;
      await session.stop(); // Not yet admitted: there is no server to stop.
      emit({ type: "closed", reason: "early exit" });
      const beforeAdmission = { finished, stoppable: session.canStop, trace: [...trace] };
      admission.resolve({ server: 41, output: "/old/debug" });
      await cleaning.promise;
      const beforeCleanup = finished;
      cleanup.resolve();
      return { beforeAdmission, beforeCleanup, reason: await done.promise, trace, launched: await launch === undefined };
    });
    assert.deepEqual(outcome, { beforeAdmission: { finished: false, stoppable: false, trace: ["closing"] }, beforeCleanup: false,
      reason: "early exit", trace: ["closing", 41], launched: true });
  });
});

test("a delayed Debug breakpoint reply cannot update the new project's marks", async () => {
  await documentScenario("stale-debug-breakpoints", async page => {
    const outcome = await page.evaluate(async () => {
      const { DebugSession } = window.workflowFixture;
      const admitted = Promise.withResolvers();
      const breakpoint = Promise.withResolvers();
      const finished = Promise.withResolvers();
      const verified = [];
      let workspace = 1;
      let emit;
      const session = new DebugSession({ id: 1, path: "/old" }, {
        verify(path, lines) { verified.push({ workspace, path, lines }); },
      }, { isCurrent: () => workspace === 1, admitted: admitted.resolve, finished: finished.resolve }, {
        debug: async (_id, _pkg, events) => { emit = events; return { server: 1, output: "/old/debug" }; },
        sendDebug: async (_server, request) => { if (request.command === "setBreakpoints") breakpoint.resolve(request.seq); },
        stopDebug: async () => {},
      });
      const startup = session.start("main_test.go", "TestA");
      await admitted.promise;
      const verifying = session.setBreakpoints("main_test.go", [5]);
      const seq = await breakpoint.promise;
      emit({ type: "message", message: { type: "response", request_seq: seq, success: true, body: { breakpoints: [{ verified: true }] } } });
      workspace = 2; // Commit after receiving the response, before its continuation.
      await verifying;
      session.retire();
      await Promise.all([startup, finished.promise]);
      return verified;
    });
    assert.deepEqual(outcome, []);
  });
});

test("a delayed resume failure does not retire a newer Delve stop", async () => {
  await documentScenario("debug-resume-order", async page => {
    const outcome = await page.evaluate(async () => {
      const { DebugSession } = window.workflowFixture;
      const firstPause = Promise.withResolvers();
      const secondPause = Promise.withResolvers();
      const resumeRequest = Promise.withResolvers();
      const disconnect = Promise.withResolvers();
      const finished = Promise.withResolvers();
      const finishes = [];
      let emit;
      let pauses = 0;
      let inspecting = false;
      const send = (event, body) => emit({ type: "message", message: { type: "event", event, body } });
      const reply = (seq, success, body) => emit({ type: "message", message: { type: "response", request_seq: seq, success, body } });
      const session = new DebugSession({ id: 1, path: "/project" }, { entries: () => [] }, {
        isCurrent: () => true, admitted() {}, running() {},
        inspection(state) { inspecting = !!state; },
        paused() { (++pauses === 1 ? firstPause : secondPause).resolve(); },
        finished(reason) { finishes.push(reason); finished.resolve(); },
      }, {
        debug: async (_id, _pkg, events) => { emit = events; return { server: 1, output: "/fixture/test" }; },
        async sendDebug(_server, request) {
          if (request.command === "next") { resumeRequest.resolve(request.seq); return; }
          if (request.command === "disconnect") { disconnect.resolve(request.seq); return; }
          if (request.command === "launch") send("initialized");
          const body = request.command === "stackTrace" ? { stackFrames: [{ id: 1, name: "pause", line: 9 }] } : {};
          reply(request.seq, true, body);
        },
        stopDebug: async () => {},
      });
      await session.start("main_test.go", "TestA");
      send("stopped", { threadId: 1, reason: "breakpoint" });
      await firstPause.promise;
      const resume = session.resume("next");
      const seq = await resumeRequest.promise;
      send("stopped", { threadId: 1, reason: "step" });
      await secondPause.promise;
      reply(seq, false);
      await resume;
      await Promise.resolve();
      const result = { paused: session.paused, canStop: session.canStop, finishes: [...finishes] };
      const stopping = session.stop();
      const disconnectSeq = await disconnect.promise;
      send("stopped", { threadId: 1, reason: "step" });
      result.stopping = { paused: session.paused, canStop: session.canStop, inspecting };
      reply(disconnectSeq, true, {});
      await stopping;
      await finished.promise;
      return result;
    });
    assert.deepEqual(outcome, { paused: true, canStop: true, finishes: [], stopping: { paused: false, canStop: false, inspecting: false } });
  });
});

test("Debug frame switches supersede old scopes and the disclosure retains keyboard focus", async () => {
  await documentScenario("debug-inspection-races", async page => {
    await page.evaluate(() => {
      const { DebugInspection, DebugInspectionView } = window.workflowFixture;
      const stack = document.createElement("div");
      const variables = document.createElement("div");
      stack.id = "inspect-stack";
      variables.id = "inspect-variables";
      document.body.prepend(stack, variables);
      const requests = [];
      const reveal = [];
      const view = new DebugInspectionView(stack, variables);
      const inspect = new DebugInspection((command, args) => {
        const reply = Promise.withResolvers();
        requests.push({ command, args, reply });
        return reply.promise;
      }, state => view.render(state), (frame, _reason, current, focus) => reveal.push({ frame: frame?.id, current, focus }), () => true);
      window.inspectFixture = { inspect, requests, reveal };
      inspect.begin(1, "breakpoint");
      requests[0].reply.resolve({ totalFrames: 50, stackFrames: [{ id: 1, name: "Top", line: 9 }, { id: 2, name: "Caller", line: 6 }] });
    });
    const stack = page.locator("#inspect-stack");
    const variables = page.locator("#inspect-variables");
    await stack.getByText("Showing the first 32 frames.").waitFor();
    await stack.getByRole("button", { name: "Caller" }).click();
    const initial = await page.evaluate(() => {
      const { requests, reveal } = window.inspectFixture;
      requests.find(request => request.command === "scopes" && request.args.frameId === 2).reply.resolve({ scopes: [
        { name: "First", variablesReference: 7 }, { name: "Second", variablesReference: 7 },
        { name: "Third", variablesReference: 8 }, { name: "Fourth", variablesReference: 9 },
      ] });
      return reveal.map(entry => ({ frame: entry.frame, current: entry.current(), focus: entry.focus }));
    });
    assert.deepEqual(initial, [{ frame: 1, current: false, focus: true }, { frame: 2, current: true, focus: false }]);
    const first = variables.locator("summary", { hasText: "First" });
    await first.focus();
    await page.keyboard.press("Enter");
    await variables.getByText("Loading variables…").waitFor();
    await page.evaluate(() => {
      const { requests } = window.inspectFixture;
      requests.find(request => request.command === "scopes" && request.args.frameId === 1).reply.resolve({ scopes: [{ name: "Stale", variablesReference: 11 }] });
      requests.find(request => request.command === "variables" && request.args.variablesReference === 7).reply.resolve({
        variables: Array.from({ length: 101 }, (_, index) => ({ name: `Item ${index}`, value: "x".repeat(900), variablesReference: 0 })),
      });
    });
    await variables.getByText("More variables are available; display limited.").waitFor();
    assert.equal(await first.evaluate(el => document.activeElement === el), true);
    assert.equal(await variables.getByText("Stale").count(), 0);
    assert.equal(await variables.getByText(/^Item \d+:/).count(), 100);
    assert.ok((await variables.getByText(/^Item 0:/).innerText()).endsWith("…"));
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await variables.getByText(/^Item 0:/).waitFor();
    await variables.locator("summary", { hasText: "Second" }).click();
    await variables.getByText("Loading variables…").waitFor();
    assert.equal(await page.evaluate(() => window.inspectFixture.requests.filter(request => request.command === "variables" && request.args.variablesReference === 7).length), 2);
    await page.evaluate(() => window.inspectFixture.requests.at(-1).reply.reject(new Error("Scope temporarily unavailable.")));
    await variables.getByText("Scope temporarily unavailable.").waitFor();
    await variables.getByRole("button", { name: "Retry" }).click();
    await variables.getByText("Loading variables…").waitFor();
    await variables.locator("summary", { hasText: "Third" }).click();
    await variables.locator("summary", { hasText: "Fourth" }).click();
    await page.waitForFunction(() => [8, 9].every(reference => window.inspectFixture.requests.some(
      request => request.command === "variables" && request.args.variablesReference === reference)));
    await page.evaluate(() => {
      const { inspect, requests } = window.inspectFixture;
      // Three variables requests occupy three slots; a new stack occupies the fourth.
      inspect.begin(2, "step");
      inspect.begin(3, "step");
      inspect.begin(4, "step");
      if (requests.some(request => request.args.threadId > 2)) throw new Error("An obsolete stack started in a full pool.");
      requests.find(request => request.args.threadId === 2).reply.resolve({ stackFrames: [{ id: 20, name: "Obsolete stack", line: 1 }] });
    });
    await page.waitForFunction(() => window.inspectFixture.requests.some(request => request.args.threadId === 4));
    await page.evaluate(() => {
      const { requests } = window.inspectFixture;
      if (requests.some(request => request.args.threadId === 3)) throw new Error("A superseded waiting stack ran.");
      requests.find(request => request.args.threadId === 4).reply.resolve({ stackFrames: [] });
    });
    await stack.getByText("No call stack was reported.").waitFor();
    await page.evaluate(async () => {
      const pending = window.inspectFixture.requests.filter(request => request.command === "variables").slice(-3);
      for (const [index, request] of pending.entries()) {
        if (index === 0) request.reply.reject(new Error("Obsolete variable error"));
        else request.reply.resolve({ variables: [{ name: "Obsolete variable", value: "unexpected", variablesReference: 0 }] });
      }
      await new Promise(requestAnimationFrame);
    });
    assert.equal(await stack.innerText(), "No call stack was reported.");
    assert.equal(await variables.innerText(), "");
    assert.equal(await variables.getByText(/^Item 0:/).count(), 0);
  });
});

test("Debug Go Program cannot launch a late adapter after Stop during build", async () => {
  await documentScenario("debug-program-build-stop", async page => {
    const outcome = await page.evaluate(async () => {
      const { DebugSession } = window.workflowFixture;
      const admitted = Promise.withResolvers();
      const stopped = Promise.withResolvers();
      const retired = Promise.withResolvers();
      const finished = Promise.withResolvers();
      const calls = [];
      let emit;
      let ended = false;
      const session = new DebugSession({ id: 8, path: "/project" }, {}, {
        isCurrent: () => true, running() {}, admitted: admitted.resolve,
        finished(reason) { ended = true; finished.resolve(reason); },
      }, {
        debugProgram: async (_id, _package, _launch, events) => { emit = events; return 42; },
        stopDebugProgram: id => { stopped.resolve(id); return retired.promise; },
        sendDebug: async (_server, request) => { calls.push(request.command); },
      });
      const starting = session.startProgram("./cmd/app", { directory: ".", args: [], environment: {} });
      await admitted.promise;
      const stopping = session.stop();
      const stopId = await stopped.promise;
      emit({ type: "ready", output: "/private/inferior", path: "/bin" });
      await starting;
      const beforeCleanup = { ended, paused: session.paused, canStop: session.canStop, calls: [...calls] };
      emit({ type: "closed", reason: "Debug session stopped" });
      retired.resolve();
      await stopping;
      return { beforeCleanup, stopId, reason: await finished.promise };
    });
    assert.deepEqual(outcome, { beforeCleanup: { ended: false, paused: false, canStop: false, calls: [] }, stopId: 42, reason: "Debug session stopped" });
  });
});

test("an imported test fixture uses the real workbench and quick open", async () => {
  await scenario("navigation", async page => {
    assert.equal(await page.locator(".titlebar #quick-open").count(), 1);
    assert.equal(await page.locator(".editor-actions #run").count(), 1, "Run belongs to the editor group");
    assert.equal(await page.getByRole("combobox", { name: "Run target" }).isDisabled(), true, "The preview does not discover local targets");
    assert.equal(await page.locator(".titlebar img").count(), 0);
    assert.deepEqual(await page.locator(".panel-tabs [data-panel]:visible").evaluateAll(tabs => tabs.map(tab => tab.dataset.panel)), ["problems", "output"]);
    const sidebar = page.getByRole("button", { name: "Toggle Side Bar", exact: true });
    await sidebar.click();
    await page.locator("#sidebar").waitFor({ state: "hidden" });
    await sidebar.click();
    await page.locator("#sidebar").waitFor({ state: "visible" });
    assert.equal(await page.locator("#module-name").innerText(), "example.com/orbit");
    assert.equal(await page.locator("#tool-version").innerText(), "Preview");
    await page.locator("#quick-open").click();
    const input = page.getByRole("textbox", { name: "Quick Open search" });
    await input.fill("report_test");
    await input.press("Enter");
    await page.getByRole("tab", { name: "report_test.go", exact: true, selected: true }).waitFor();
    assert.deepEqual(await page.locator("#breadcrumbs .crumb").allTextContents(), ["internal", "status", "report_test.go"]);
    await page.getByRole("button", { name: "Toggle Bottom Panel" }).click();
    await page.locator("#panel").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Show Problems" }).click();
    await page.getByRole("tab", { name: /Problems/, selected: true }).waitFor();
  });
});

test("keyboard cycles open editors in order without dropping unsaved edits", async () => {
  await scenario("keyboard-editor-cycle", async page => {
    const active = name => page.getByRole("tab", { name, exact: true, selected: true }).waitFor({ timeout: 2500 });
    await page.locator("#editor textarea.inputarea").focus();
    await page.keyboard.insertText("// keyboard edit\n");
    const savedCaret = await page.locator("#cursor").innerText();
    await page.locator('#explorer [data-path="go.mod"]').click();
    await active("go.mod");
    await page.locator('#explorer [data-path="README.md"]').click();
    await active("README.md");
    await page.keyboard.press("Meta+Shift+BracketRight");
    await active("main.go");
    assert.equal(await page.locator('.tab.dirty [data-path="cmd/orbit/main.go"]').count(), 1);
    assert.equal(await page.locator("#cursor").innerText(), savedCaret);
    assert.equal(await page.locator("#editor textarea.inputarea").evaluate(input => input === document.activeElement), true);
    assert.equal(await page.evaluate(() => !document.dispatchEvent(new KeyboardEvent("keydown", { code: "BracketRight", key: "[", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }))), true);
    await active("go.mod");
    await page.keyboard.press("Meta+Shift+BracketRight");
    await active("README.md");
    await page.keyboard.press("Meta+Shift+BracketLeft");
    await active("go.mod");
    await page.locator("#settings").click();
    assert.equal(await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "BracketLeft", key: "[", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }))), true);
    await active("go.mod");
  });
});

test("caret lookup wiring drops restored cursor, model and reservation intents before dispatch", async () => {
  await documentScenario("caret-test-wiring", async page => {
    const calls = await page.evaluate(async () => {
      const { documents: docs, workflowFixture: { createCursorTestWorkflow, ExecutionLane } } = window;
      const { lookup, projectWorkflow } = createCursorTestWorkflow(docs.editor, () => {});
      const executions = new ExecutionLane(() => {});
      const calls = [];
      docs.reset({ read: async () => "package main\n\nfunc TestA() {}\n" });
      await docs.open("first_test.go", { target: { lineNumber: 3, column: 1 } });
      await docs.open("second_test.go");
      docs.cycle(-1);
      async function deferred(event, mayLaunch = () => true) {
        const request = Promise.withResolvers();
        const settled = lookup.resolve(() => request.promise, () => true, value => calls.push(value), {
          available: mayLaunch, blocked: () => calls.push("busy"),
        });
        await event();
        request.resolve("TestA");
        await settled;
      }
      await deferred(() => {
        docs.editor.setPosition({ lineNumber: 1, column: 1 });
        docs.editor.setPosition({ lineNumber: 3, column: 1 });
      });
      await deferred(() => { docs.cycle(1); docs.cycle(-1); });
      await deferred(() => projectWorkflow.transition({ ready: () => true, confirm: async () => false, choose: async () => undefined, install: async () => {} }));
      await deferred(() => executions.start("project", "run", { revision: () => 0, save: async () => {}, dirty: () => false }, async () => {}), () => !executions.occupied);
      return calls;
    });
    assert.deepEqual(calls, ["busy"]);
  });
});

test("editor cycling wins activation over an earlier pending file read", async () => {
  await documentScenario("cycle-supersedes-open", async page => {
    const result = await page.evaluate(async () => {
      const { documents: docs } = window;
      const deferred = Promise.withResolvers();
      docs.reset({ read: path => path === "later.go" ? deferred.promise : Promise.resolve(path) });
      await docs.open("first.go");
      const single = docs.cycle(1);
      await docs.open("second.go");
      const pending = docs.open("later.go", { focus: true });
      const cycled = docs.cycle(1);
      deferred.resolve("later.go");
      await pending;
      return { single, cycled, active: docs.active.path, open: [...docs.tabs.keys()] };
    });
    assert.deepEqual(result, { single: false, cycled: true, active: "first.go", open: ["first.go", "second.go", "later.go"] });
  });
});

test("the gutter stays stable through 999 lines and expands one digit at a time through seven digits", async () => {
  await documentScenario("line-number-gutter-width", async page => {
    const { sizes, simulated } = await page.evaluate(async () => {
      const { documents: docs } = window;
      const sizes = [];
      for (const lines of [9, 10, 99, 100, 999, 1000, 1001]) {
        docs.reset({ read: async () => `package main${"\n".repeat(lines - 1)}// last line` });
        await docs.open("gutter.go");
        const editor = docs.editor;
        editor.setScrollTop(0);
        editor.render(true);
        const { glyphMarginWidth, lineNumbersWidth, contentLeft } = editor.getLayoutInfo();
        function edges() {
          return [...editor.getDomNode().querySelectorAll(".margin-view-overlays .line-numbers")].map(number => {
            const range = document.createRange();
            range.selectNodeContents(number);
            return { line: number.textContent, right: range.getBoundingClientRect().right,
              cell: number.getBoundingClientRect().right, align: getComputedStyle(number).textAlign };
          });
        }
        const selected = edges();
        editor.setScrollTop(editor.getTopForLineNumber(lines), 1);
        editor.render(true);
        sizes.push({ lines, count: editor.getModel().getLineCount(), glyphMarginWidth, lineNumbersWidth, contentLeft, edges: [...selected, ...edges()] });
      }
      const simulated = [999, 1000, 9999, 10000, 99999, 100000, 999999, 1000000, 1000001].map(window.gutterLayoutForCount);
      return { sizes, simulated };
    });
    const short = sizes.slice(0, 5);
    const four = sizes.slice(5);
    assert.ok(sizes.every(size => size.count === size.lines));
    assert.ok(short.every(size => size.lineNumbersWidth === short[0].lineNumbersWidth));
    const step = four[0].lineNumbersWidth - short[0].lineNumbersWidth;
    assert.ok(step > 0 && step <= 9);
    assert.equal(four[0].lineNumbersWidth, four[1].lineNumbersWidth);
    assert.equal(four[0].contentLeft - short[0].contentLeft, step);
    assert.ok(sizes.every(size => size.glyphMarginWidth === short[0].glyphMarginWidth &&
      size.contentLeft - size.lineNumbersWidth - size.glyphMarginWidth === 24));
    assert.equal(short[0].glyphMarginWidth, 18);
    assert.ok(sizes.every(size => size.edges.length && size.edges.every(edge =>
      edge.align === "right" && Math.abs(edge.right - edge.cell) <= 0.5)));
    for (const target of ["9", "10", "99", "100", "999", "1000"]) {
      assert.ok(sizes.some(size => size.edges.some(edge => edge.line === target)), `rendered ${target}`);
    }
    assert.equal(simulated[0].lineNumbersWidth, short[0].lineNumbersWidth);
    assert.equal(simulated[1].lineNumbersWidth, four[0].lineNumbersWidth);
    for (const [index, size] of simulated.entries()) {
      assert.equal(size.contentLeft - size.lineNumbersWidth - size.glyphMarginWidth, 24);
      if (index === 0) continue;
      const previous = simulated[index - 1];
      const increment = size.lineNumbersWidth - previous.lineNumbersWidth;
      if ([1, 3, 5, 7].includes(index)) assert.ok(increment > 0 && increment <= 9);
      else assert.equal(increment, 0);
      assert.equal(size.contentLeft - previous.contentLeft, increment);
    }
  });
});

test("the tighter gutter still leaves the code fold control clickable", async () => {
  await documentScenario("tight-gutter-fold", async page => {
    await page.evaluate(async () => {
      const docs = window.documents;
      docs.reset({ read: async () => "package main\n\nfunc main() {\n\tprintln(1)\n\tprintln(2)\n}\n" });
      const tab = await docs.open("fold.go");
      const { monaco } = window.workflowFixture;
      monaco.editor.setModelMarkers(tab.model, "fixture", [{ startLineNumber: 4, startColumn: 2, endLineNumber: 4,
        endColumn: 9, message: "fixture marker", severity: monaco.MarkerSeverity.Error }]);
    });
    const expanded = page.locator("#editor .margin-view-overlays .codicon-folding-expanded").first();
    await expanded.waitFor({ timeout: 5000 });
    await expanded.hover();
    await expanded.click({ position: { x: 6, y: 9 } });
    const collapsed = page.locator("#editor .margin-view-overlays .codicon-folding-collapsed").first();
    await collapsed.waitFor({ timeout: 5000 });
    assert.equal(await page.locator("#editor .view-lines").innerText().then(text => text.includes("println(1)")), false);
    await collapsed.click({ position: { x: 6, y: 9 } });
    await expanded.waitFor({ timeout: 5000 });
    assert.match(await page.locator("#editor .view-lines").innerText(), /println\(1\)/);
    const underline = page.locator("#editor .squiggly-error").first();
    await underline.waitFor({ timeout: 5000 });
    assert.ok(await underline.evaluate(marker => {
      const line = [...document.querySelectorAll("#editor .view-lines .view-line")].find(row => row.textContent.includes("println(1)"));
      const row = line.getBoundingClientRect();
      const lineInk = document.createRange();
      lineInk.selectNodeContents(line.firstElementChild);
      const ink = lineInk.getBoundingClientRect();
      const squiggle = marker.getBoundingClientRect();
      return row.height === 18 && ink.top >= row.top && ink.bottom <= row.bottom &&
        squiggle.width > 0 && squiggle.bottom <= row.bottom;
    }));
  });
});

test("an imported file becomes dirty, saves in memory, and is searchable", async () => {
  await scenario("edit-save-search", async page => {
    await page.locator('#explorer [data-path="README.md"]').click();
    await page.getByRole("tab", { name: "README.md", exact: true, selected: true }).waitFor();
    await page.locator("#editor textarea.inputarea").focus();
    await page.keyboard.insertText("agent-note-417 ");
    await page.locator('.tab.dirty [data-path="README.md"]').waitFor();
    await page.getByRole("button", { name: "Save File" }).click();
    await page.locator('.tab.dirty [data-path="README.md"]').waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("textbox", { name: "Search saved files" }).fill("agent-note-417");
    await page.locator('#search-results [data-path="README.md"]').waitFor();
    await page.locator('#search-results [data-path="README.md"]').click();
    await page.getByRole("tab", { name: "README.md", exact: true, selected: true }).waitFor();
  });
});

test("creates a nested file, rejects duplicates, and does not fake native tasks", async () => {
  await scenario("create-and-preview", async page => {
    const create = async () => {
      await page.getByRole("button", { name: "New File", exact: true }).click();
      await page.getByRole("textbox", { name: "Relative file path" }).fill("pkg/extra.go");
      await page.getByRole("button", { name: "Create", exact: true }).click();
    };
    await create();
    await page.getByRole("tab", { name: "extra.go", exact: true, selected: true }).waitFor();
    await create();
    assert.match(await page.locator("#form-error").innerText(), /already exists/i);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator("#run").click();
    assert.match(await page.locator("#toast").innerText(), /desktop app/i);
  });
});

test("Go to Line works without gopls and rejects invalid line numbers", async () => {
  await scenario("go-to-line", async page => {
    await page.locator('#explorer [data-path="go.mod"]').click();
    await page.getByRole("tab", { name: "go.mod", selected: true }).waitFor();
    await page.locator("#quick-open").click();
    const palette = page.getByRole("textbox", { name: "Quick Open search" });
    await palette.fill(">go to line");
    await page.getByRole("button", { name: "Go to Line…", exact: true }).click({ timeout: 3000 });
    const input = page.getByRole("textbox", { name: "Line number" });
    for (const invalid of ["0", "1.5", "1e0", "999"]) {
      await input.fill(invalid);
      await page.getByRole("button", { name: "Go to Line", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: /whole line/ }).waitFor();
    }
    await input.fill("3");
    await page.getByRole("button", { name: "Go to Line", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#cursor").textContent === "Ln 3, Col 1");
  });
});

test("Go navigation rejects malformed workspace locations and cancels an outstanding RPC", async () => {
  await documentScenario("go-navigation-cancellation", async page => {
    const checks = await page.evaluate(async () => {
      const { GoLanguage, AbstractMessageReader, AbstractMessageWriter, CancellationTokenSource, createMessageConnection, monaco, exactModelRange } = window.workflowFixture;
      const docs = window.documents;
      const native = { id: 1, path: "/navigation-fixture", name: "Fixture" };
      docs.reset({ native, read: async () => "package main\n// 🚀 token\n" });
      const tab = await docs.open("source.go");
      const service = new GoLanguage(native, docs, () => {});
      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
      try {
        await docs.open("closed.go", { validate(candidate) {
          if (!exactModelRange(candidate.model, new monaco.Range(99, 1, 99, 2))) throw new Error("invalid target");
        } });
        throw new Error("invalid target was accepted");
      } catch (error) {
        if (error.message !== "invalid target" || docs.tabs.has("closed.go")) throw error;
        if (monaco.editor.getModel(monaco.Uri.file(`${native.path}/closed.go`))) throw new Error("invalid target leaked a model");
      }
      const uris = ["file:///navigation-fixture/source.go", "file:///outside.go", "file:///navigation-fixture/../outside.go",
        "file:///navigation-fixture/%2e%2e/outside.go", "file:///navigation-fixture/source.go?query", "file:///navigation-fixture/source.go#fragment",
        "file://host/navigation-fixture/source.go", "https://example.com/navigation-fixture/source.go", "not a URI",
        "file:navigation-fixture/source.go", "file:///navigation-fixture/source.go?", "file:///navigation-fixture/source.go#",
        "file:///navigation-fixture/%ZZ.go", "file:///navigation-fixture%2Fsource.go",
        "file:///navigation-fixture/unescaped file.go", "file:///navigation-fixture/unescaped\tfile.go"];
      const results = uris.map(uri => service.workspaceLocation(uri, range)?.path ?? null);
      for (const invalid of [
        { start: { line: 1, character: 4 }, end: { line: 1, character: 6 } },
        { start: { line: 80, character: 0 }, end: { line: 80, character: 1 } },
        { start: { line: 1, character: 90 }, end: { line: 1, character: 90 } },
      ]) results.push(service.workspaceLocation(uris[0], invalid)?.path ?? null);
      results.push(service.workspaceLocation("file:///navigation-fixture/escaped%20file.go", range)?.path ?? null);
      const sent = [];
      class Reader extends AbstractMessageReader { listen() { return { dispose() {} }; } }
      class Writer extends AbstractMessageWriter {
        async write(message) { sent.push(message); }
        end() {}
      }
      const rpc = createMessageConnection(new Reader(), new Writer());
      rpc.listen();
      service.connection = rpc;
      service.ready = true;
      service.opened(tab);
      const source = new CancellationTokenSource();
      window.navigationRpc = { service, sent, source };
      void service.references(tab.model, new monaco.Position(1, 1), source.token);
      return results;
    });
    assert.deepEqual(checks, ["source.go", ...Array(18).fill(null), "escaped file.go"]);
    await page.waitForFunction(() => window.navigationRpc.sent.some(message => message.method === "textDocument/references"));
    await page.evaluate(() => window.navigationRpc.source.cancel());
    await page.waitForFunction(() => {
      const { sent } = window.navigationRpc;
      return sent.some(message => message.method === "$/cancelRequest" &&
        message.params.id === sent.find(request => request.method === "textDocument/references").id);
    });
    await page.evaluate(() => window.navigationRpc.service.dispose());
  });
});

test("an obsolete Go semantic token reply cannot style an edited or reopened model", async () => {
  await documentScenario("go-semantic-stale", async page => {
    const outcome = await page.evaluate(async () => {
      const { GoLanguage, CancellationTokenSource } = window.workflowFixture;
      const docs = window.documents;
      const native = { id: 1, path: "/semantic-fixture", name: "Fixture" };
      docs.reset({ native, read: async () => "package main\n" });
      const tab = await docs.open("source.go");
      const language = new GoLanguage(native, docs, () => {});
      const cancellations = new CancellationTokenSource();
      let reply;
      const send = () => language.request("textDocument/semanticTokens/full", tab.model, undefined, cancellations.token);
      language.connection = {
        sendRequest: () => new Promise(resolve => { reply = resolve; }),
        sendNotification: async () => {},
        dispose() {},
      };
      language.ready = true;
      language.opened(tab);
      try {
        const editing = send();
        tab.model.setValue("package main\nvar _ = 1\n");
        reply({ data: [] });
        const reopening = send();
        language.closed(tab);
        language.opened(tab);
        reply({ data: [] });
        const active = send();
        reply({ data: [] });
        return [await editing ?? null, await reopening ?? null, await active];
      } finally { cancellations.dispose(); language.dispose(); }
    });
    assert.deepEqual(outcome, [null, null, { data: [] }]);
  });
});

test("an explicit Go edit preserves unrelated auto-indent whitespace and line endings", async () => {
  await documentScenario("go-exact-edit", async page => {
    const outcome = await page.evaluate(async () => {
      const { monaco, applyExactTextEdits } = window.workflowFixture;
      const docs = window.documents;
      docs.reset({ read: async () => "package main\r\n\r\nvar _ = 1\r\n" });
      const { model } = await docs.open("source.go");
      model.pushStackElement();
      model.pushEditOperations([], [{ range: new monaco.Range(2, 1, 2, 1), text: "\t", isAutoWhitespaceEdit: true }], () => null);
      const before = model.getValue();
      const [decoration] = model.deltaDecorations([], [{ range: new monaco.Range(1, 1, 1, 1), options: {} }]);
      const changed = applyExactTextEdits(model, [{ range: new monaco.Range(3, 1, 3, 10), text: "var _ = 2\nvar _ = 3" }]);
      const after = model.getValue();
      const decorationLine = model.getDecorationRange(decoration)?.startLineNumber;
      await model.undo();
      return { changed, before, after, decorationLine, undone: model.getValue(), trimRestored: model.getOptions().trimAutoWhitespace };
    });
    const before = "package main\r\n\t\r\nvar _ = 1\r\n";
    assert.deepEqual(outcome, { changed: true, before, after: "package main\r\n\t\r\nvar _ = 2\r\nvar _ = 3\r\n", decorationLine: 1, undone: before, trimRestored: true });
  });
});

test("the dirty tab dialog defaults to Cancel and restores focus on Escape", async () => {
  await scenario("dirty-tab-dialog", async page => {
    await page.locator("#editor textarea.inputarea").focus();
    await page.keyboard.insertText("// Unsaved dialog check");
    await page.locator('.tab.dirty [data-path="cmd/orbit/main.go"]').waitFor();
    const close = page.getByRole("button", { name: "Close main.go" });
    await close.focus();
    await close.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Close unsaved file?" });
    await dialog.waitFor({ timeout: 3000 });
    assert.match(await dialog.innerText(), /cmd\/orbit\/main\.go/);
    assert.deepEqual(await dialog.getByRole("button").allTextContents(), ["Cancel", "Discard", "Save and Close"]);
    assert.equal(await dialog.getByRole("button", { name: "Cancel" }).evaluate(button => document.activeElement === button), true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await close.evaluate(button => document.activeElement === button), true);
    assert.match(await page.locator("#editor .view-lines").innerText(), /Unsaved\s+dialog\s+check/);
    await close.press("Enter");
    await dialog.getByRole("button", { name: "Discard", exact: true }).click();
    await close.waitFor({ state: "detached" });
    assert.equal(await page.locator("#empty-quick-open").evaluate(button => document.activeElement === button), true);
  });
});

test("an asynchronous tab close does not cancel a newer pending navigation", async () => {
  await documentScenario("close-preserves-navigation", async page => {
    const active = await page.evaluate(async () => {
      const { documents: docs } = window;
      const pending = Promise.withResolvers();
      docs.reset({ read: path => path === "next.txt" ? pending.promise : Promise.resolve(path) });
      const close = await docs.open("closing.txt");
      await docs.open("successor.txt", { activate: false });
      const next = docs.open("next.txt");
      docs.close(close, { focus: false, preserveNavigation: true });
      pending.resolve("latest navigation");
      await next;
      return docs.active.path;
    });
    assert.equal(active, "next.txt");
  });
});

test("Dark and Light switch the entire workbench and persist without dropping edits", async () => {
  await scenario("color-themes", async page => {
    const backgrounds = () => page.evaluate(() => [".monaco-editor-background", ".sidebar", ".bottom-panel"].map(selector =>
      getComputedStyle(document.querySelector(selector)).backgroundColor,
    ));
    const dark = ["rgb(31, 31, 31)", "rgb(24, 24, 24)", "rgb(24, 24, 24)"];
    const light = ["rgb(255, 255, 255)", "rgb(248, 248, 248)", "rgb(248, 248, 248)"];
    const rgb = (selector, property) => page.locator(selector).first().evaluate((el, property) => getComputedStyle(el)[property], property);
    async function checkRoles(lightTheme) {
      assert.equal(await rgb("#run", "backgroundColor"), lightTheme ? "rgb(0, 95, 184)" : "rgb(0, 120, 212)");
      await page.locator("#format").focus();
      await page.keyboard.press("Shift+Tab");
      assert.deepEqual(await page.locator("#run").evaluate(el => {
        const style = getComputedStyle(el);
        return { focused: el === document.activeElement && el.matches(":focus-visible"),
          outline: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
      }), { focused: true, outline: "solid", width: "1px", color: "rgb(255, 255, 255)" });
      assert.equal(await rgb("#quick-open", "color"), lightTheme ? "rgb(30, 30, 30)" : "rgb(204, 204, 204)");
      assert.equal(await rgb("#quick-open", "borderTopColor"), lightTheme ? "rgba(30, 30, 30, 0.2)" : "rgba(204, 204, 204, 0.2)");
      assert.equal(await rgb(".tab.active", "color"), lightTheme ? "rgb(59, 59, 59)" : "rgb(255, 255, 255)");
      assert.equal(await rgb(".tab:not(.active)", "color"), lightTheme ? "rgb(97, 97, 97)" : "rgb(157, 157, 157)");
      assert.equal(await rgb("#editor .line-numbers:not(.active-line-number)", "color"), "rgb(110, 118, 129)");
      assert.equal(await rgb("#editor .line-numbers.active-line-number", "color"), lightTheme ? "rgb(23, 17, 132)" : "rgb(204, 204, 204)");
      assert.equal(await rgb("#editor .view-overlays .current-line", "backgroundColor"), "rgba(0, 0, 0, 0)");
      assert.equal(await rgb("#editor .view-overlays .current-line", "borderTopColor"), lightTheme ? "rgb(238, 238, 238)" : "rgb(40, 40, 40)");

      const selectedFile = page.locator(".tree-row.active");
      assert.equal(await rgb(".tree-row.active", "backgroundColor"), lightTheme ? "rgb(228, 230, 241)" : "rgb(55, 55, 61)");
      await selectedFile.focus();
      assert.equal(await rgb(".tree-row.active", "backgroundColor"), lightTheme ? "rgb(232, 232, 232)" : "rgb(4, 57, 94)");
      assert.equal(await rgb(".tree-row.active", "color"), lightTheme ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)");
      await page.locator("#quick-open").click();
      const selected = ".palette-option[aria-current='true']";
      await page.locator(selected).waitFor();
      assert.equal(await rgb("#palette", "backgroundColor"), lightTheme ? "rgb(248, 248, 248)" : "rgb(34, 34, 34)");
      assert.equal(await rgb(selected, "backgroundColor"), lightTheme ? "rgb(0, 95, 184)" : "rgb(4, 57, 94)");
      assert.equal(await rgb(selected, "color"), "rgb(255, 255, 255)");
      await page.keyboard.press("Escape");
    }
    await page.locator('#explorer [data-path="go.mod"]').click();
    await page.getByRole("tab", { name: "go.mod", selected: true }).waitFor();
    await page.getByRole("tab", { name: "main.go", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const theme = page.getByRole("combobox", { name: "Color Theme" });
    await theme.waitFor({ timeout: 3000 });
    assert.deepEqual(await theme.locator("option").allTextContents(), ["Dark", "Light"]);
    assert.deepEqual(await backgrounds(), dark);
    await page.getByRole("button", { name: "Close settings" }).click();
    await checkRoles(false);
    await page.locator("#editor textarea.inputarea").focus();
    await page.keyboard.insertText("// Unsaved theme check");
    await page.locator('.tab.dirty [data-path="cmd/orbit/main.go"]').waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await theme.selectOption({ label: "Light" });
    await page.getByRole("button", { name: "Close settings" }).click();
    assert.deepEqual(await backgrounds(), light);
    await checkRoles(true);
    assert.match(await page.locator("#editor .view-lines").innerText(), /Unsaved\s+theme\s+check/);
    assert.equal(await page.locator('.tab.dirty [data-path="cmd/orbit/main.go"]').count(), 1);
    await page.getByRole("button", { name: "Save File" }).click();
    await page.locator(".tab.dirty").waitFor({ state: "detached" });
    await page.reload();
    await page.locator("#project-welcome").waitFor();
    await openFixture(page);
    assert.deepEqual(await backgrounds(), light);
    await page.locator("#quick-open").click();
    const palette = page.getByRole("textbox", { name: "Quick Open search" });
    await palette.fill(">color theme dark");
    await page.getByRole("button", { name: "Color Theme: Dark", exact: true }).waitFor({ timeout: 3000 });
    await palette.press("Enter");
    assert.deepEqual(await backgrounds(), dark);
  });
});

test("each theme separates rendered Go syntax roles on the real editor canvas", async () => {
  await scenario("go-syntax-colors", async page => {
    const editor = page.locator("#editor textarea.inputarea");
    await editor.focus();
    await page.keyboard.press("Meta+a");
    await page.keyboard.insertText(goSyntaxSample);
    await page.waitForFunction(() => document.querySelector("#editor .view-lines")?.textContent.includes("Readable"));
    const ratio = (foreground, background) => {
      const luminance = value => value.match(/\d+/g).slice(0, 3).map(byte => Number(byte) / 255)
        .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    for (const theme of ["dark", "light"]) {
      if (theme === "light") {
        await page.locator("#settings").click();
        await page.locator("#theme-setting").selectOption("light");
        await page.locator('[data-dialog-close="settings-dialog"]').click();
      }
      await page.waitForFunction(color => [...document.querySelectorAll("#editor .view-lines .view-line span[class*='mtk']")]
        .some(el => el.textContent.trim() === "func" && getComputedStyle(el).color === color), expectedGoSyntax[theme].declaration);
      const colors = await page.evaluate(renderedGoSyntax);
      assert.deepEqual(colors, expectedGoSyntax[theme]);
      const canvas = await page.locator(".monaco-editor-background").first().evaluate(el => getComputedStyle(el).backgroundColor);
      for (const token of Object.values(colors)) assert.ok(ratio(token, canvas) >= 4.5, `${theme}: ${token} on ${canvas}`);
      assert.equal(await page.locator('.tab.dirty [data-path="cmd/orbit/main.go"]').count(), 1);
      assert.match(await page.locator("#editor .view-lines").innerText(), /func\s+paint/);
    }
    await page.locator('#explorer [data-path="README.md"]').click();
    await page.getByRole("tab", { name: "README.md", exact: true, selected: true }).waitFor();
    await editor.focus();
    await page.keyboard.press("Meta+a");
    await page.keyboard.insertText(`type normally\n\n\`\`\`go\n${goSyntaxSample}\`\`\`\n`);
    await page.waitForFunction(() => [...document.querySelectorAll("#editor .view-lines .view-line span[class*='mtk']")].some(el => el.textContent.trim() === "func"));
    assert.deepEqual(await page.evaluate(renderedGoSyntax), expectedGoSyntax.light);
    const prose = page.locator("#editor .view-line [class*='mtk']").filter({ hasText: "type normally" }).first();
    assert.equal(await prose.evaluate(el => getComputedStyle(el).color), "rgb(59, 59, 59)");
  });
});

test("the browser also starts at welcome without an Orbit project", async () => {
  await scenario("empty-welcome", async page => {
    assert.equal(await page.locator("#tabs [role=tab]").count(), 0);
    assert.equal(await page.locator("#run").isDisabled(), true);
    assert.equal(await page.locator("#editor-toolbar").isHidden(), true);
    assert.equal(await page.getByRole("button", { name: "Search commands", exact: true }).count(), 1);
    const welcome = await page.locator("#project-welcome").innerText();
    assert.match(welcome, /Open Project/);
    assert.match(welcome, /New Project/);
    assert.doesNotMatch(welcome, /Orbit/);
    await page.waitForFunction(() => document.querySelector("#project-welcome img")?.naturalWidth === 128);
    assert.match(await page.locator("#project-welcome img").evaluate(image => getComputedStyle(image).filter), /grayscale\(1\)/);
  }, false);
});

test("adjacent workbench controls and visible dividers use a one-pixel gap", async () => {
  await scenario("dense-controls", async page => {
    const check = async (group, vertical = false, selector = "button, select, input") => {
      const gaps = await page.locator(group).evaluate((element, { vertical, selector }) => {
        const bounds = [...element.children].filter(child => child.matches(selector) && child.getClientRects().length)
          .map(child => child.getBoundingClientRect());
        return bounds.slice(1).map((current, index) => vertical ? current.top - bounds[index].bottom : current.left - bounds[index].right);
      }, { vertical, selector });
      assert.ok(gaps.length, `${group} should have adjacent controls`);
      for (const gap of gaps) assert.ok(Math.abs(gap - 1) < 0.1, `${group} gap: expected 1px, got ${gap}px`);
    };
    const horizontalGroups = [".title-actions", ".editor-actions", ".panel-tabs", "#explorer-view .inline-actions"];
    for (const group of horizontalGroups) await check(group, false, "button, select, input, .run-picker-field");
    await page.locator('#explorer [data-path="go.mod"]').click();
    await page.getByRole("tab", { name: "go.mod", selected: true }).waitFor();
    await check("#tabs", false, ".tab");
    await check("#explorer .tree-list", true);
    assert.equal((await page.locator("#sidebar-resize").boundingBox()).width, 1);
    assert.equal((await page.locator("#panel-resize").boundingBox()).height, 1);
    await page.getByRole("button", { name: "Run and Test", exact: true }).click();
    await check(".task-actions", true);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await check(".search-field");
    await page.getByRole("button", { name: "Project", exact: true }).click();
    await page.getByRole("button", { name: "New File", exact: true }).click();
    await check("#form-dialog .dialog-actions");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.setViewportSize({ width: 650, height: 560 });
    for (const group of horizontalGroups) await check(group, false, "button, select, input, .run-picker-field");
    assert.equal((await page.locator("#sidebar-resize").boundingBox()).width, 1);
  });
});

test("the app title bar stays 36 pixels at normal and compact widths", async () => {
  await scenario("titlebar-height", async page => {
    for (const width of [1440, 650]) {
      await page.setViewportSize({ width, height: 750 });
      const bounds = await page.locator(".titlebar").boundingBox();
      assert.equal(bounds.height, 36);
      assert.doesNotMatch(await page.locator(".titlebar").innerText(), /Iron\s*Go/);
      assert.equal(await page.locator(".titlebar .title-actions #toggle-panel").count(), 1);
      const command = await page.locator("#quick-open").boundingBox();
      assert.ok(command.y >= bounds.y && command.y + command.height <= bounds.y + bounds.height);
      assert.ok(Math.abs((command.x + command.width / 2) - (bounds.x + bounds.width / 2)) < 1);
    }
  });
});

test("compact chrome returns room to code without shrinking button targets", async () => {
  await scenario("compact-chrome-bounds", async page => {
    const box = selector => page.locator(selector).first().boundingBox();
    for (const [width, height, rail, side, panelHeight, editorHeight] of [[1320, 820, 44, 220, 188.2, 512.8], [760, 600, 36, 196, 120, 361], [650, 560, 34, 175, 112, 332]]) {
      await page.setViewportSize({ width, height });
      assert.equal((await box(".activity-bar")).width, rail);
      const action = await box(".activity");
      assert.ok(action.width >= rail - 1 && action.height >= 36);
      assert.equal((await box("#sidebar")).width, side);
      assert.equal((await box("#explorer-view .side-header")).height, 32);
      assert.equal((await box("#new-file")).height, 25);
      assert.equal((await box(".tree-row")).height, 27);
      assert.equal((await box("#sidebar-resize")).width, 1);
      const editor = await box("#editor");
      assert.equal(editor.width, width - rail - side - 1);
      assert.ok(Math.abs(editor.height - editorHeight) < 0.1, `editor height at ${width}: ${editor.height}`);
      assert.equal((await box("#editor-toolbar")).height, 32);
      assert.equal((await box("#breadcrumbs")).height, 22);
      assert.equal((await box(".panel-header")).height, 32);
      assert.ok(Math.abs((await box("#panel")).height - panelHeight) < 0.1);
      assert.equal((await box("#run-target")).height, 26);
      assert.equal((await box(".tab-close")).width, 24);
      assert.equal((await box(".tab-close")).height, 24);
      await page.locator("#toggle-sidebar").click();
      assert.equal(await box("#sidebar-resize"), null);
      assert.equal((await box("#editor")).width, width - rail);
      await page.locator("#settings").focus();
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest("#sidebar,#sidebar-resize")), false);
      await page.getByRole("button", { name: "Search", exact: true }).focus();
      await page.keyboard.press("Enter");
      assert.equal(await page.locator("#search-text").evaluate(el => el === document.activeElement), true);
      assert.equal((await box("#search-case")).height, 24);
      await page.getByRole("button", { name: "Run and Test", exact: true }).click();
      for (const control of ["#refresh-targets", "#package-scope", "[data-task=test]"]) {
        const bounds = await box(control);
        const sidebar = await box("#sidebar");
        assert.ok(bounds.x >= sidebar.x && bounds.x + bounds.width <= sidebar.x + sidebar.width);
      }
      await page.getByRole("button", { name: "Project", exact: true }).click();
    }
    const header = await box(".panel-header");
    for (const selector of ["#output-tab", "#problems-tab", "#clear-output"]) {
      const bounds = await box(selector);
      assert.ok(bounds.y >= header.y && bounds.y + bounds.height <= header.y + header.height);
    }
    assert.ok(await page.locator("#output-pane").evaluate(pane => {
      pane.querySelector("#output-log").append(document.createTextNode("sample output\n".repeat(30)));
      pane.scrollTop = pane.scrollHeight;
      return pane.clientHeight > 0 && pane.scrollTop > 0;
    }));
  });
});

test("Run Target's disabled styling dims the field and the chevron in both themes", async () => {
  await scenario("disabled-run-target-style", async page => {
    const picker = page.locator("#run-target");
    const appearance = () => picker.evaluate(select => {
      const wrapper = select.parentElement;
      const arrow = getComputedStyle(wrapper, "::after");
      return { opacity: Number(getComputedStyle(wrapper).opacity), caret: arrow.borderRightColor, disabled: select.disabled };
    });
    const dark = await appearance();
    await page.locator("#settings").click();
    await page.locator("#theme-setting").selectOption("light");
    await page.locator('[data-dialog-close="settings-dialog"]').click();
    const light = await appearance();
    assert.ok(dark.disabled && light.disabled);
    assert.ok(dark.opacity < 1 && light.opacity < 1);
    assert.notEqual(dark.caret, light.caret);
  });
});

test("editor typography defaults to bundled JetBrains Mono and remembers changes", async () => {
  await scenario("editor-typography", async page => {
    const line = page.locator("#editor .view-line").first();
    const verify = (family, size, height) => page.waitForFunction(({ family, size, height }) => {
      const row = document.querySelector("#editor .view-line");
      if (!row) return false;
      const { fontFamily, fontSize } = getComputedStyle(row);
      return fontFamily.replaceAll('"', '').startsWith(`${family},`) && fontSize === `${size}px` &&
        row.getBoundingClientRect().height === height;
    }, { family, size, height }, { timeout: 5000 });
    const font = page.getByLabel("Editor Font", { exact: true });
    const size = page.getByLabel("Editor Font Size", { exact: true });
    const open = () => page.locator("#settings").click();
    const close = () => page.getByRole("button", { name: "Close settings" }).click();
    const original = await line.textContent();
    await page.waitForFunction(() => [...document.fonts].some(face =>
      face.family.replaceAll('"', '') === "JetBrains Mono" && face.status === "loaded"));
    await verify("JetBrains Mono", 13, 18);

    await open();
    assert.equal(await font.locator("option:checked").textContent(), "JetBrains Mono");
    assert.equal(await size.inputValue(), "13");
    await font.selectOption({ label: "System Monospace" });
    await size.fill("16");
    await size.press("Enter");
    await verify("SF Mono", 16, 22);
    for (const invalid of ["", "16.5", "41"]) {
      await size.fill(invalid);
      await size.blur();
      assert.equal(await size.inputValue(), "16");
    }
    await close();
    assert.equal(await line.textContent(), original);

    await page.reload();
    await openFixture(page);
    await verify("SF Mono", 16, 22);
    await open();
    assert.equal(await font.locator("option:checked").textContent(), "System Monospace");
    assert.equal(await size.inputValue(), "16");

    await size.fill("8");
    await size.blur();
    await close();
    await verify("SF Mono", 8, 18);
    const expanded = page.locator("#editor .codicon-folding-expanded").first();
    await expanded.hover();
    await expanded.click();
    await page.locator("#editor .codicon-folding-collapsed").first().waitFor();

    await page.evaluate(() => {
      localStorage.setItem("irongo.editor-font", "unknown");
      localStorage.setItem("irongo.editor-font-size", "16.5");
    });
    await page.reload();
    await openFixture(page);
    await verify("JetBrains Mono", 13, 18);
  });
});

test("Monaco refreshes fallback measurements after the bundled font arrives", async () => {
  await documentScenario("editor-font-load", async page => {
    const release = Promise.withResolvers();
    await page.route(/JetBrainsMono-Regular.*\.woff2$/, async route => {
      await release.promise;
      await route.continue();
    });
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.documents);
      const characterWidth = () => {
        const { monaco } = window.workflowFixture;
        return window.documents.editor.getOption(monaco.editor.EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
      };
      const fallbackWidth = await page.evaluate(characterWidth);
      release.resolve();
      await page.waitForFunction(fallbackWidth => {
        const { monaco } = window.workflowFixture;
        const { typicalHalfwidthCharacterWidth } = window.documents.editor.getOption(monaco.editor.EditorOption.fontInfo);
        return typicalHalfwidthCharacterWidth !== fallbackWidth;
      }, fallbackWidth, { timeout: 5000 });
    } finally { release.resolve(); }
  });
});

test("resized chrome keeps its chosen dimensions across hiding and reopening", async () => {
  await scenario("compact-chrome-resize", async page => {
    await page.setViewportSize({ width: 760, height: 600 });
    const width = selector => page.locator(selector).boundingBox().then(box => box.width);
    const height = selector => page.locator(selector).boundingBox().then(box => box.height);
    const divider = page.locator("#sidebar-resize");
    const start = await divider.boundingBox();
    const initialEditor = await width("#editor");
    await page.mouse.move(start.x + .5, start.y + 100);
    await page.mouse.down();
    await page.mouse.move(start.x + 20, start.y + 100);
    await page.mouse.up();
    const dragged = await width("#sidebar");
    assert.ok(dragged > 196);
    await divider.focus();
    await page.keyboard.press("ArrowRight");
    const chosen = await width("#sidebar");
    assert.equal(chosen, dragged + 14);
    assert.equal(await width("#editor"), initialEditor - (chosen - 196));
    await page.locator("#toggle-sidebar").click();
    await page.locator("#toggle-sidebar").click();
    assert.equal(await width("#sidebar"), chosen);
    await page.locator("#panel-resize").focus();
    const panel = await height("#panel");
    const editor = await height("#editor");
    await page.keyboard.press("ArrowUp");
    assert.equal(await height("#panel"), panel + 14);
    assert.equal(await height("#editor"), editor - 14);
    await page.locator("#toggle-panel").click();
    await page.locator("#toggle-panel").click();
    assert.equal(await height("#panel"), panel + 14);
  });
});

test("one persistent panel toggle preserves output, selection and keyboard focus", async () => {
  await scenario("single-bottom-panel-toggle", async page => {
    const panel = page.locator("#panel");
    const toggle = page.getByRole("button", { name: "Toggle Bottom Panel" });
    const problems = page.getByRole("tab", { name: /Problems/ });
    const output = page.getByRole("tab", { name: "Output" });
    const log = page.locator("#output-log");
    await panel.waitFor({ state: "visible" });
    assert.equal(await panel.getByText("Go Output", { exact: true }).count(), 0);
    assert.equal(await panel.getByRole("button", { name: "Hide Panel" }).count(), 0);
    assert.equal(await toggle.count(), 1);
    assert.equal(await toggle.getAttribute("aria-controls"), "panel");
    const original = await log.textContent();
    assert.match(original, /Project opened:/);

    await problems.click();
    await page.keyboard.press("Meta+j");
    await panel.waitFor({ state: "hidden" });
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    assert.ok(await toggle.evaluate(el => el === document.activeElement));
    await page.keyboard.press("Enter");
    await panel.waitFor({ state: "visible" });
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    assert.equal(await problems.getAttribute("aria-selected"), "true");

    await page.locator("#panel-resize").focus();
    await page.keyboard.press("Meta+j");
    await panel.waitFor({ state: "hidden" });
    assert.ok(await toggle.evaluate(el => el === document.activeElement));
    await page.getByRole("button", { name: "Show Problems" }).click();
    await panel.waitFor({ state: "visible" });
    assert.equal(await problems.getAttribute("aria-selected"), "true");

    const editorInput = page.locator("#editor textarea.inputarea");
    await editorInput.focus();
    await page.keyboard.press("Meta+j");
    await panel.waitFor({ state: "hidden" });
    assert.ok(await editorInput.evaluate(el => el === document.activeElement));
    await page.keyboard.press("Meta+j");
    await panel.waitFor({ state: "visible" });
    assert.ok(await editorInput.evaluate(el => el === document.activeElement));
    await toggle.click();
    await panel.waitFor({ state: "hidden" });
    await toggle.click();
    await panel.waitFor({ state: "visible" });
    await output.click();
    assert.equal(await log.textContent(), original);
    await page.getByRole("button", { name: "Clear Output" }).click();
    assert.equal(await log.textContent(), "");
  });
});

test("project actions have one visible entry per state and tool status is informational", async () => {
  await scenario("single-project-entry-points", async page => {
    const opens = page.getByRole("button", { name: "Open Project", exact: true });
    const welcome = page.locator("#welcome-open");
    const header = page.locator("#open-folder");
    assert.equal(await opens.count(), 1);
    await welcome.waitFor({ state: "visible" });
    await header.waitFor({ state: "hidden" });
    await welcome.focus();
    const choosing = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await (await choosing).setFiles(fixture);
    await page.getByRole("tab", { name: "main.go", exact: true, selected: true }).waitFor();
    await header.waitFor({ state: "visible" });
    await welcome.waitFor({ state: "hidden" });
    assert.equal(await opens.count(), 1);

    const status = page.locator("#tool-status");
    assert.equal(await status.innerText(), "Preview");
    assert.equal(await status.evaluate(el => el.tabIndex), -1);
    assert.equal(await page.getByRole("button", { name: "Go tools and settings" }).count(), 0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("dialog", { name: "Workbench Settings" }).waitFor();
    await page.keyboard.press("Escape");

    assert.equal(await page.getByRole("button", { name: "Refresh Project", exact: true }).count(), 0);
    const projectActions = page.getByRole("button", { name: "Project Actions" });
    await projectActions.click();
    const palette = page.getByRole("textbox", { name: "Quick Open search" });
    await palette.fill("refresh project");
    await page.getByRole("button", { name: "Refresh Project", exact: true }).waitFor();
    await palette.press("Enter");
    await projectActions.click();
    await palette.fill("close project");
    await palette.press("Enter");
    await welcome.waitFor({ state: "visible" });
    assert.equal(await opens.count(), 1);
  }, false);
});

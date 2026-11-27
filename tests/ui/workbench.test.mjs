import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build, preview } from "vite";
import { runtimeClean } from "../native/plan.mjs";

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
        isCurrent: () => true, admitted: () => trace.push("admitted"), finished: done.resolve,
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
    assert.deepEqual(outcome, { beforeAdmission: { finished: false, stoppable: false, trace: [] }, beforeCleanup: false,
      reason: "early exit", trace: [41], launched: true });
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

test("an imported test fixture uses the real workbench and quick open", async () => {
  await scenario("navigation", async page => {
    assert.equal(await page.locator(".titlebar #quick-open").count(), 1);
    assert.equal(await page.locator(".editor-actions #run").count(), 1, "Run belongs to the editor group");
    assert.equal(await page.getByRole("combobox", { name: "Run target" }).isDisabled(), true, "The preview does not discover local targets");
    assert.equal(await page.locator(".titlebar img").count(), 0);
    assert.deepEqual(await page.locator(".panel-tabs [data-panel]").evaluateAll(tabs => tabs.map(tab => tab.dataset.panel)), ["problems", "output"]);
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

test("Dark and Light switch the entire workbench and persist without dropping edits", async () => {
  await scenario("color-themes", async page => {
    const backgrounds = () => page.evaluate(() => [".monaco-editor-background", ".sidebar", ".bottom-panel"].map(selector =>
      getComputedStyle(document.querySelector(selector)).backgroundColor,
    ));
    const dark = ["rgb(18, 19, 20)", "rgb(25, 26, 27)", "rgb(25, 26, 27)"];
    const light = ["rgb(255, 255, 255)", "rgb(250, 250, 253)", "rgb(250, 250, 253)"];
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const theme = page.getByRole("combobox", { name: "Color Theme" });
    await theme.waitFor({ timeout: 3000 });
    assert.deepEqual(await theme.locator("option").allTextContents(), ["Dark", "Light"]);
    assert.deepEqual(await backgrounds(), dark);
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.locator("#editor textarea.inputarea").focus();
    await page.keyboard.insertText("// Unsaved theme check");
    await page.locator('.tab.dirty [data-path="cmd/orbit/main.go"]').waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await theme.selectOption({ label: "Light" });
    await page.getByRole("button", { name: "Close settings" }).click();
    assert.deepEqual(await backgrounds(), light);
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
    const horizontalGroups = [".title-actions", ".editor-actions", ".panel-tabs", ".panel-actions", "#explorer-view .inline-actions"];
    for (const group of horizontalGroups) await check(group);
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
    for (const group of horizontalGroups) await check(group);
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

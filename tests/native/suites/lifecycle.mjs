import assert from "node:assert/strict";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function lifecycleSuite({
  fixture, eventually, js, click, text, set, current, chooseCommand,
  refreshThroughProjectActions, record, openOrbit, addWaitTarget, app, replace, output,
  openProjectControl, terminalCheckpoint, requestNativeQuit, selectTarget,
}) {
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
    const root = path.join(path.dirname(fixture), "native-menu-go");
    await js("return window.__ironTest.cancelNextPicker().then(() => true);");
    await click("#form-submit");
    await eventually("canceling the location chooser keeps the form available", () => js(`
      return document.querySelector('#form-dialog').open && !document.querySelector('#form-submit').disabled;`));
    await assert.rejects(stat(root), { code: "ENOENT" });
    await click("#form-submit");
    await eventually("the new project is open", current, entry => entry?.root === root && entry.path === "main.go");
    assert.match(await readFile(path.join(root, "go.mod"), "utf8"), /^module example\.com\/native-menu-go/m);
    await chooseCommand("new project");
    await set("#form-name", "native-menu-go");
    await set("#form-module", "example.com/not-replaced");
    await click("#form-submit");
    await eventually("an existing destination is rejected before creation", () => text("#form-error"), value => /Create module folder/.test(value));
    assert.match(await readFile(path.join(root, "go.mod"), "utf8"), /^module example\.com\/native-menu-go/m);
    await click('[data-dialog-close="form-dialog"]');
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
  await lifecycleTransitions({ fixture, app, eventually, js, click, text, set, current, replace, output, chooseCommand, openProjectControl, record, terminalCheckpoint, requestNativeQuit, selectTarget });
}

async function lifecycleTransitions({
  fixture, app, eventually, js, click, text, set, current, replace, output, chooseCommand,
  openProjectControl, record, terminalCheckpoint, requestNativeQuit, selectTarget,
}) {
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

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectedGoSyntax, goSyntaxSample, renderedGoSyntax } from "../../go-syntax-sample.mjs";

export async function fileSuite({
  values, fixture, home, eventually, js, click, text, set, current, replace, output,
  chooseCommand, refreshThroughProjectActions, assertLineAlignment, clickGlyphBreakpoint,
  traceGutterClick, record, setNativeTheme, checkTheme, openOrbit,
}) {
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
    await js("return window.__ironTest.holdFormat(true);");
    try {
      await click("#format");
      await eventually("format is in progress", () => js("return window.__ironTest.holdFormat();"));
      await eventually("native Reload and New File are disabled during Format", () => js(`
        return Promise.all(['Reload File from Disk', 'New File…'].map(item => window.__ironTest.menuItem('File', item)));`),
      options => options?.every(enabled => enabled === false));
      assert.equal(await js("return document.querySelector('#new-file').disabled;"), true);
    } finally { await js("return window.__ironTest.holdFormat(false);"); }
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

  await record("a blocked path operation does not hold the native session mutex", async () => {
    const name = "folder-after-save-lock";
    await js("return window.__ironTest.holdSaveLock(true);");
    try {
      await js(`window.__pathChange = null;
        void window.__ironTest.makeFixtureFolder(arguments[0]).then(result => window.__pathChange = result.outcome.kind,
          error => window.__pathChange = String(error)); return true;`, name);
      await eventually("the path operation reserves the workspace while the Save lock is held", () => js("return window.__ironTest.holdSaveLock();"));
      assert.equal((await js("return window.__ironTest.inspectFixtureFile('go.mod');")).directory, false);
      assert.equal(await js("return window.__pathChange;"), null);
      await assert.rejects(stat(path.join(fixture, name)), { code: "ENOENT" });
      const before = await js("return window.__ironTest.quitRequests();");
      for (let attempt = 1; attempt <= 2; attempt++) {
        await js("void window.__ironTest.quitMenu(); return true;");
        await eventually("the busy mutation does not consume later Quit input", () => js("return window.__ironTest.quitRequests();"),
          count => count === before + attempt);
        await eventually("the unadmitted Quit ticket is refused", () => js("return window.__ironTest.quitDeadline();"), ticket => ticket === null);
        await eventually("the workbench can handle the next Quit", () => js("return !document.querySelector('#open-folder').disabled;"));
      }
    } finally { await js("return window.__ironTest.holdSaveLock(false);"); }
    await eventually("the reserved operation finishes after the Save lock is released", () => js("return window.__pathChange;"), result => result === "folder");
    assert.ok((await stat(path.join(fixture, name))).isDirectory());

    const newFile = "queued-create/file.txt";
    await js("return window.__ironTest.holdSaveLock(true);");
    try {
      await js(`window.__fileCreation = null;
        void window.__ironTest.makeFixtureFile(arguments[0]).then(() => window.__fileCreation = 'created',
          error => window.__fileCreation = String(error)); return true;`, newFile);
      await eventually("queued New File reserves its original workspace", () => js("return window.__ironTest.holdSaveLock();"));
      assert.match(await js("return window.__ironTest.closeFixtureProject().then(() => '', error => String(error));"),
        /Another workspace operation is in progress/);
      await assert.rejects(stat(path.join(fixture, "queued-create")), { code: "ENOENT" });
      assert.equal(await js("return window.__fileCreation;"), null);
    } finally { await js("return window.__ironTest.holdSaveLock(false);"); }
    await eventually("New File settles on the retained project", () => js("return window.__fileCreation;"), value => value === "created");
    assert.equal(await readFile(path.join(fixture, newFile), "utf8"), "");
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

import assert from "node:assert/strict";
import { mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { goLanguageCases, missingGopls } from "../plan.mjs";

export async function goSuite({
  values, fixture, eventually, js, click, text, set, current, replace, output, chooseCommand,
  openProjectControl, prepareKeyboardCommand, traceGutterClick, record, probeTools,
  setNativeTheme, openOrbit, addWaitTarget, holdConfiguredBuild, openTestFile, setGoCapability,
  skipCase,
}) {
  const capabilities = await probeTools({ gopls: !!values["require-gopls"] });
  setGoCapability(capabilities.gopls);
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
    for (const name of goLanguageCases) {
      skipCase(name, missingGopls);
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
  await goScopeCases({ eventually, js, click, set, current, output, record, openTestFile });
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

      const replacedDirectory = await holdConfiguredBuild();
      await rename(runtime, backup);
      await mkdir(runtime);
      try {
        await releaseHandoff();
        const invalid = await eventually("a different regular directory cannot admit the executable", output,
          value => /ended without an exit code|configured-start/.test(value));
        assert.match(invalid, /configured working directory was replaced[\s\S]*ended without an exit code/i);
        assert.doesNotMatch(invalid, /configured-start/);
        await cleanup(replacedDirectory);
      } finally {
        await rename(runtime, path.join(fixture, "runtime-replacement"));
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

      const preflight = await holdConfiguredBuild();
      const occupied = "occupied-new-project-preflight";
      await mkdir(path.join(path.dirname(fixture), occupied));
      await chooseCommand("new project");
      await set("#form-name", occupied);
      await set("#form-module", `example.com/${occupied}`);
      await js("return window.__ironTest.holdSave(true, '@new-project-preflight');");
      try {
        await click("#form-submit");
        await eventually("project switch prompts for a running build", () => js("return document.querySelector('#project-transition-dialog').open;"));
        await click("#project-transition-continue");
        await eventually("New Project has a reservation but has not started teardown", () => js("return window.__ironTest.holdSave();"));
        await releaseHandoff();
        await eventually("the reserved preflight does not cancel the admitted Go launch", output, value => /configured-start/.test(value));
      } finally { await js("return window.__ironTest.holdSave(false);"); }
      await eventually("New Project reports the pre-existing directory", () => text("#form-error"), value => /Create module folder/.test(value));
      await click('[data-dialog-close="form-dialog"]');
      assert.equal((await current()).root, fixture);
      assert.match(await output(), /configured-start/);
      await click("#run");
      await eventually("the preserved launch stops on explicit Stop", output, value => /Task stopped/.test(value));
      await cleanup(preflight);
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

export async function reopenGoSuite({
  artifacts, fixture, eventually, js, click, text, set, current, output, chooseCommand,
  openProjectControl, record, holdConfiguredBuild,
}) {
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

async function goScopeCases({
  eventually, js, click, set, current, output, record, openTestFile,
}) {
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

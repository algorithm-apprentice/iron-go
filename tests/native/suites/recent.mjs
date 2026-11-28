import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function recentSuite({
  reopen, fixture, home, app, eventually, js, click, text, set, current, openProjectControl,
  refreshThroughProjectActions, record, terminalCheckpoint, openOrbit,
}) {
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
      await eventually("the old viewport was durably recorded", stored, data => data?.tabs.find(tab => tab.path === paths[2])?.line === expected[paths[2]].line);
      const old = expected[paths[2]];
      await js("window.__ironTest.scrollToLine(33); return true;");
      const scrolled = await eventually("scrolling alone changes the viewport without moving the caret", view,
        state => state?.line === old.line && state.column === old.column && state.firstLine !== old.firstLine);
      const earlier = await eventually("a scroll-only change is durably recorded", stored, data => {
        const tab = data?.tabs.find(tab => tab.path === paths[2]);
        return tab?.line === old.line && tab.column === old.column && tab.firstLine === scrolled.firstLine;
      });
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

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function accessibilitySuite({
  artifacts, fixture, pid, accessibilityHelper, eventually, js, click, text, current, record,
  openOrbit,
}) {
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

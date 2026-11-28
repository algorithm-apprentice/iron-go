import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function trashSuite({
  fixture, trashRoot, eventually, js, click, text, set, current, replace, chooseCommand,
  record, openOrbit,
}) {
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

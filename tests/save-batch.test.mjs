import assert from "node:assert/strict";
import { test } from "node:test";
import { saveDirtyTabs } from "../src/save-batch.ts";

test("a newer edit in an earlier tab stops queued saves and reports committed paths", async () => {
  const second = Promise.withResolvers();
  const admittedSecond = Promise.withResolvers();
  const tabs = ["first", "second", "third"].map(path => ({ path, dirty: true, model: { version: 1, getVersionId() { return this.version; } } }));
  const written = [];
  const pending = saveDirtyTabs(() => tabs, async tab => {
    if (tab.path === "second") {
      admittedSecond.resolve();
      await second.promise;
    }
    tab.dirty = false;
    written.push(tab.path);
    return true;
  });
  await admittedSecond.promise;
  tabs[0].model.version++;
  tabs[0].dirty = true;
  second.resolve();
  const result = await pending;
  assert.deepEqual(result.committed, ["first", "second"]);
  assert.match(result.issue, /first.*newer|newer.*first/i);
  assert.deepEqual(written, ["first", "second"]);
  assert.equal(tabs[2].dirty, true);
});

test("an expired decision reports admitted writes and stops before the next save", async () => {
  const first = Promise.withResolvers();
  const tabs = ["first", "second"].map(path => ({ path, dirty: true, model: { getVersionId: () => 1 } }));
  const admitted = [];
  let live = true;
  const save = saveDirtyTabs(() => tabs, async tab => {
    admitted.push(tab.path);
    await first.promise;
    tab.dirty = false;
    return true;
  }, () => live);
  assert.deepEqual(admitted, ["first"]);
  live = false;
  first.resolve();
  assert.deepEqual(await save, { committed: ["first"], issue: "The save decision expired." });
  assert.deepEqual(admitted, ["first"]);
  assert.equal(tabs[1].dirty, true);
});

test("a failed or throwing save preserves partial results without admitting later files", async () => {
  for (const reject of [false, true]) {
    const tabs = ["first", "second", "third"].map(path => ({ path, dirty: true, model: { getVersionId: () => 1 } }));
    const admitted = [];
    const result = await saveDirtyTabs(() => tabs, async tab => {
      admitted.push(tab.path);
      if (tab.path === "second") {
        if (reject) throw new Error("disk write failed");
        return false;
      }
      tab.dirty = false;
      return true;
    });
    assert.deepEqual(admitted, ["first", "second"]);
    assert.deepEqual(result.committed, ["first"]);
    assert.equal(result.issue, reject ? "Could not save second: disk write failed" : "Could not save second.");
    assert.deepEqual(tabs.map(tab => tab.dirty), [false, true, true]);
  }
});

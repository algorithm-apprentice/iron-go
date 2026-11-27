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

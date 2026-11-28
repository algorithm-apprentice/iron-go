import assert from "node:assert/strict";
import { test } from "node:test";
import { NavigationHistory } from "../src/navigation-history.ts";

const point = (path, line = 1, top = 0) => ({ path, anchorLine: line, anchorColumn: 1, line, column: 1, top, left: 0 });

test("Back and Forward preserve the indexed location after an unrecorded switch", () => {
  const history = new NavigationHistory();
  history.record(point("a.go"), point("b.go", 3));
  history.refresh(point("c.go"));
  history.refresh(undefined);
  const back = history.candidate(-1);
  assert.deepEqual(back, point("a.go"));
  history.arrive(back);
  assert.deepEqual(history.candidate(1), point("b.go", 3));
});

test("replay refreshes only the current file and a new jump removes the forward branch", () => {
  const history = new NavigationHistory();
  history.record(point("a.go"), point("b.go"));
  history.refresh(point("b.go", 2, 60));
  history.arrive(history.candidate(-1));
  assert.deepEqual(history.candidate(1), point("b.go", 2, 60));
  history.record(point("a.go"), point("c.go"));
  assert.equal(history.candidate(1), undefined);
  assert.deepEqual(history.candidate(-1), point("a.go"));
});

test("history deduplicates viewport changes, skips missing entries and stays bounded", () => {
  const history = new NavigationHistory();
  for (let i = 0; i < 110; i++) history.record(point("a.go", i + 1), point("a.go", i + 2));
  assert.equal(history.entries.length, 100);
  history.record(point("a.go", 111), point("a.go", 111, 40));
  assert.equal(history.candidate(-1).line, 110);
  history.discard(history.candidate(-1));
  assert.equal(history.candidate(-1).line, 109);
});

test("replay skips confirmed missing paths and preserves transient failures", async () => {
  const history = new NavigationHistory();
  history.record(point("a.go"), point("missing.go"));
  history.record(point("missing.go"), point("c.go"));
  const attempted = [];
  await history.replay(-1, {
    current: () => true,
    async open(location, activated) {
      attempted.push(location.path);
      if (location.path === "missing.go") throw new Error("open failed");
      activated();
    },
    inspect: async () => ({ kind: "missing" }),
  });
  assert.deepEqual(attempted, ["missing.go", "a.go"]);
  for (const kind of ["unavailable", "retry"]) {
    await assert.rejects(history.replay(1, {
      current: () => true,
      open: async () => { throw new Error("open failed"); },
      inspect: async () => ({ kind }),
    }), /open failed/);
    assert.deepEqual(history.candidate(1), point("c.go"));
  }
});

test("an obsolete activation does not advance the replay cursor", async () => {
  const history = new NavigationHistory();
  history.record(point("a.go"), point("b.go"));
  const read = Promise.withResolvers();
  let current = true;
  const replay = history.replay(-1, {
    current: () => current,
    async open(_location, activated) { await read.promise; activated(); },
    inspect: async () => undefined,
  });
  current = false;
  read.resolve();
  await replay;
  assert.deepEqual(history.candidate(-1), point("a.go"));
  assert.equal(history.candidate(1), undefined);
});

test("moving paths and removing the active entry preserve surviving code locations", () => {
  const history = new NavigationHistory();
  history.record(point("a.go", 3, 60), point("old/b.go", 5, 120));
  history.record(point("old/b.go", 5, 120), point("c.go", 7, 180));
  history.arrive(history.candidate(-1));
  history.updatePaths(path => path.replace(/^old\//, "new/"));
  assert.deepEqual(history.entries[1], point("new/b.go", 5, 120));
  assert.deepEqual(history.candidate(-1), point("a.go", 3, 60));
  history.updatePaths(path => path === "new/b.go" ? undefined : path);
  assert.deepEqual(history.entries, [point("a.go", 3, 60), point("c.go", 7, 180)]);
  assert.deepEqual(history.candidate(1), point("c.go", 7, 180));
  history.reset();
  assert.equal(history.candidate(-1), undefined);
  assert.equal(history.candidate(1), undefined);
});

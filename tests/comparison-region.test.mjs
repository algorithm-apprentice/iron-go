import assert from "node:assert/strict";
import { test } from "node:test";
import { changedLineRegion } from "../src/comparison-region.ts";

test("identical lines do not produce a changed region", () => {
  assert.equal(changedLineRegion(["same", ""], ["same", ""]), undefined);
});

test("the shared suffix never consumes the prefix or the empty side", () => {
  assert.deepEqual(changedLineRegion(["a", "end"], ["a", "inserted", "end"]), { first: 2, beforeEnd: 1, afterEnd: 2 });
  assert.deepEqual(changedLineRegion(["a", "removed", "end"], ["a", "end"]), { first: 2, beforeEnd: 2, afterEnd: 1 });
  assert.deepEqual(changedLineRegion(["repeat", "repeat"], ["repeat"]), { first: 2, beforeEnd: 2, afterEnd: 1 });
});

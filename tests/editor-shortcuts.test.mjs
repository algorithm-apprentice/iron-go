import assert from "node:assert/strict";
import { test } from "node:test";
import { handleEditorCycle } from "../src/editor-shortcuts.ts";

test("cycling leaves composition, busy workbench, inexact modifiers and absent destinations unconsumed", () => {
  const event = extras => ({ key: "Tab", ctrlKey: true, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extras });
  for (const [extras, blocked, hasDestination] of [[{isComposing:true}, false, true], [{}, true, true],
    [{altKey:true}, false, true], [{metaKey:true}, false, true], [{}, false, false]]) {
    const candidate = event(extras);
    assert.equal(handleEditorCycle(candidate, blocked, () => hasDestination), false);
    assert.equal(candidate.prevented, false);
    assert.equal(candidate.stopped, false);
  }
  const candidate = event({ shiftKey: true });
  assert.equal(handleEditorCycle(candidate, false, direction => direction === -1), true);
  assert.equal(candidate.prevented, true);
});

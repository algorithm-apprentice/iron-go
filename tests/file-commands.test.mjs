import assert from "node:assert/strict";
import { test } from "node:test";
import { FileActivity, fileCommands } from "../src/file-commands.ts";

const active = { go: true, saving: false, reloading: false };
const state = { active, blocked: false, busy: false, modal: false, desktop: true };
const enabled = context => Object.fromEntries(Object.entries(fileCommands(context)).map(([key, action]) => [key, action.enabled]));

test("file controls share the same eligibility through modal and file activity settlement", () => {
  assert.deepEqual(enabled(state), { save: true, reload: true, format: true });
  for (const context of [{ blocked: true }, { busy: true }, { modal: true },
    { active: { ...active, saving: true } }, { active: { ...active, reloading: true } }, { active: undefined }]) {
    assert.deepEqual(enabled({ ...state, ...context }), { save: false, reload: false, format: false });
  }
  assert.deepEqual(enabled({ ...state, desktop: false }), { save: true, reload: true, format: false });
  assert.match(fileCommands({ ...state, desktop: false }).format.reason, /macOS desktop app/);
  assert.equal(fileCommands({ ...state, active: { ...active, go: false } }).format.enabled, false);
});

test("a stale file release cannot unblock a newer operation", () => {
  const states = [];
  const activity = new FileActivity(() => states.push(activity.busy));
  const close = activity.reserve("decision");
  assert.equal(activity.decision, true);
  assert.equal(activity.reserve("format"), undefined);
  close();
  const format = activity.reserve("format");
  close();
  assert.equal(activity.busy, true);
  assert.equal(activity.decision, false);
  format();
  assert.deepEqual(states, [true, false, true, false]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { decideExit } from "../src/quit-flow.ts";

function decision({ ready = true, dirty = true, discard = false, accept = true, send = undefined } = {}) {
  const calls = [];
  return {
    calls,
    canDecide: () => ready,
    hasUnsavedChanges: () => dirty,
    confirmDiscard: () => { calls.push("confirm"); return discard; },
    freeze: frozen => { calls.push(frozen ? "freeze" : "thaw"); },
    reply: async approve => { calls.push(approve); return send ? send() : accept; },
  };
}

test("an in-flight mutation vetoes Quit without asking to discard", async () => {
  const attempt = decision({ ready: false });
  await decideExit(attempt);
  assert.deepEqual(attempt.calls, [false]);
});

test("cancellation and expired approval let the user resume editing", async () => {
  const cancel = decision();
  await decideExit(cancel);
  assert.deepEqual(cancel.calls, ["freeze", "confirm", false, "thaw"]);
  const expired = decision({ discard: true, accept: false });
  await decideExit(expired);
  assert.deepEqual(expired.calls, ["freeze", "confirm", true, "thaw"]);
});

test("a clean editor needs no confirmation and stays frozen after approval", async () => {
  let acknowledge;
  const attempt = decision({ dirty: false, send: () => new Promise(resolve => { acknowledge = resolve; }) });
  const pending = decideExit(attempt);
  assert.deepEqual(attempt.calls, ["freeze", true]);
  acknowledge(true);
  await pending;
  assert.deepEqual(attempt.calls, ["freeze", true]);
});

test("an unsuccessful reply cannot leave the editor frozen", async () => {
  const attempt = decision({ discard: true, send: () => Promise.reject(new Error("IPC failed")) });
  await assert.rejects(() => decideExit(attempt), /IPC failed/);
  assert.deepEqual(attempt.calls, ["freeze", "confirm", true, false, "thaw"]);
});

test("an unsuccessful save decision releases its native ticket before thawing", async () => {
  const attempt = decision();
  attempt.confirmDiscard = async () => { throw new Error("save failed"); };
  await assert.rejects(() => decideExit(attempt), /save failed/);
  assert.deepEqual(attempt.calls, ["freeze", false, "thaw"]);
});

test("the editor stays frozen while the dialog awaits a choice", async () => {
  let answer;
  const attempt = decision();
  attempt.confirmDiscard = () => {
    attempt.calls.push("confirm");
    return new Promise(resolve => { answer = resolve; });
  };
  const pending = decideExit(attempt);
  assert.deepEqual(attempt.calls, ["freeze", "confirm"]);
  answer(false);
  await pending;
  assert.deepEqual(attempt.calls, ["freeze", "confirm", false, "thaw"]);
});

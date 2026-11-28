import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorSessionRecorder } from "../src/editor-session-recorder.ts";

test("project replacement and newer flushes supersede pending editor-session writes", async () => {
  const first = Promise.withResolvers();
  const errors = [];
  const writes = [];
  let firstLine = 1;
  const recorder = new EditorSessionRecorder({ capture: () => ({ firstLine }), liveTicket: () => true,
    write(project, revision, view) { writes.push({ project, revision, view }); return writes.length === 1 ? first.promise : Promise.resolve(); },
    error: error => errors.push(error),
  });
  recorder.holdDebounce(true);
  recorder.beginProject("old")();
  const writing = recorder.flush();
  await Promise.resolve();
  firstLine = 9;
  const oldQueued = recorder.flush();
  recorder.beginProject("new")();
  firstLine = 21;
  const newQueued = recorder.flush();
  first.reject(new Error("old project write failed"));
  await Promise.all([writing, oldQueued, newQueued]);
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, [{ project: "old", revision: 1, view: { firstLine: 1 } },
    { project: "new", revision: 3, view: { firstLine: 21 } }]);
});

test("failed restore and expired Quit cannot replace recent state, but later changes can", async () => {
  const writes = [];
  const first = Promise.withResolvers();
  let live = true;
  let view = 1;
  const recorder = new EditorSessionRecorder({ capture: () => view, liveTicket: () => live,
    write(_project, _revision, snapshot) { writes.push(snapshot); return writes.length === 1 ? first.promise : Promise.resolve(); },
    error: error => assert.fail(String(error)),
  });
  recorder.holdDebounce(true);
  const finish = recorder.beginProject("workspace");
  recorder.failRestore();
  recorder.openedDocument(); // A fallback open during restore is not a user decision.
  finish();
  await recorder.flush();
  assert.deepEqual(writes, []);
  recorder.openedDocument();
  const initial = recorder.flush();
  await Promise.resolve();
  view = 10;
  const quitting = recorder.flush(3);
  live = false;
  first.resolve();
  await Promise.all([initial, quitting]);
  assert.deepEqual(writes, [1]);
  view = 24; // Only the viewport changed after Quit was refused.
  recorder.changed();
  await recorder.flush();
  assert.deepEqual(writes, [1, 24]);
});

test("an admitted Quit or chooser flush pauses automatic writes until the same project resumes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes = [];
  let view = 1;
  const recorder = new EditorSessionRecorder({ capture: () => view, liveTicket: () => true,
    write(project, _revision, snapshot, ticket) { writes.push({ project, snapshot, ticket }); return Promise.resolve(); },
    error: error => assert.fail(String(error)),
  });
  recorder.beginProject("workspace")();
  t.mock.timers.tick(280); // Start a scheduled flush, but don't let its continuation admit the write.
  recorder.pauseAutomatic(true);
  await Promise.resolve();
  assert.deepEqual(writes, []);
  await recorder.flush(7);
  view = 2;
  recorder.changed();
  t.mock.timers.tick(1_000);
  await Promise.resolve();
  assert.deepEqual(writes, [{ project: "workspace", snapshot: 1, ticket: 7 }]);
  recorder.pauseAutomatic(false);
  t.mock.timers.tick(280);
  await Promise.resolve();
  assert.deepEqual(writes, [{ project: "workspace", snapshot: 1, ticket: 7 }, { project: "workspace", snapshot: 2, ticket: undefined }]);
});

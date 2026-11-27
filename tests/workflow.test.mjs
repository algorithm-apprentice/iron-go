import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionLane } from "../src/execution.ts";
import { ProjectWorkflow, publishProjectSnapshot } from "../src/project-workflow.ts";

const clean = { revision: () => 0, save: async () => {}, dirty: () => false };

test("only the committed project's snapshot can publish data or errors", async () => {
  const old = { id: 1 }, next = { id: 2 };
  let project = old;
  const events = [];
  const open = Promise.withResolvers();
  const error = Promise.withResolvers();
  const result = Promise.withResolvers();
  const request = read => ({ current: () => project, read, apply: value => events.push(value), fail: error => events.push(error.message) });
  const obsoleteError = publishProjectSnapshot(old, request(() => error.promise));
  const obsoleteResult = publishProjectSnapshot(old, request(() => result.promise));
  const workflow = new ProjectWorkflow(() => {});
  const switching = workflow.transition({ ready: () => true, confirm: async () => true, choose: () => open.promise,
    install: async target => { project = target; } });
  open.resolve(next);
  assert.equal(await switching, true);
  error.reject(new Error("old error"));
  result.resolve("old result");
  await Promise.all([obsoleteError, obsoleteResult]);
  assert.deepEqual(events, []);
  await publishProjectSnapshot(next, request(async () => { throw new Error("current error"); }));
  await publishProjectSnapshot(next, request(async () => "current result"));
  assert.deepEqual(events, ["current error", "current result"]);
});

test("project transition reserves the editor; cancel and host failure never install", async () => {
  const changes = [];
  const workflow = new ProjectWorkflow(value => changes.push(value));
  const picker = Promise.withResolvers();
  const picked = Promise.withResolvers();
  const request = {
    ready: () => true,
    confirm: async () => true,
    choose: () => { picked.resolve(); return picker.promise; },
    install: async target => changes.push(target),
  };
  const waiting = workflow.transition(request);
  await picked.promise;
  assert.equal(workflow.reserve(), undefined, "Quit cannot reserve while the picker is pending");
  assert.equal(await workflow.transition({ ...request, choose: () => assert.fail("second picker") }), false);
  picker.resolve(undefined);
  assert.equal(await waiting, false);
  const failed = { ...request, choose: async () => { throw new Error("host failed"); } };
  await assert.rejects(workflow.transition(failed), /host failed/);
  assert.equal(await workflow.transition({ ...request, choose: async () => "replacement" }), true);
  assert.deepEqual(changes, [true, false, true, false, true, "replacement", false]);
});

test("terminal task waits for delayed native Stop execution before reusing its slot", async () => {
  const lane = new ExecutionLane(() => {});
  const delayedStop = Promise.withResolvers();
  const sameProject = { id: 1 };
  let slot;
  let stopTarget;
  const launch = () => lane.start(sameProject, "run", clean, async token => { slot = token; lane.taskEvent(token, "started"); });
  await launch();
  const old = slot;
  const stopping = lane.stopTask(async () => { await delayedStop.promise; stopTarget = slot; });
  slot = undefined;
  assert.equal(lane.taskEvent(old, "finished"), true);
  await launch();
  assert.equal(slot, undefined, "new task must not be in the slot when Stop actually executes");
  delayedStop.resolve();
  await stopping;
  assert.equal(stopTarget, undefined);
  await launch();
  assert.notEqual(slot, old);
  assert.equal(lane.taskEvent(old, "finished"), false);
  assert.equal(lane.canStopTask, true);
});

test("a terminal event wins over late admission and Stop failures", async () => {
  const lane = new ExecutionLane(() => {});
  const admission = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const launch = lane.start(1, "run", clean, token => { lane.taskEvent(token, "started"); entered.resolve(token); return admission.promise; });
  const token = await entered.promise;
  const stop = Promise.withResolvers();
  const stopping = lane.stopTask(() => stop.promise);
  lane.taskEvent(token, "finished");
  admission.reject(new Error("old launch rejection"));
  stop.reject(new Error("old stop rejection"));
  await Promise.all([launch, stopping]);
  assert.equal(lane.occupied, false);
});

test("Run and Debug share save rejection, successful ordering, and exclusive admission", async () => {
  for (const [kind, competitor] of [["run", "debug"], ["debug", "run"]]) {
    const lane = new ExecutionLane(() => {});
    const save = Promise.withResolvers();
    const trace = [];
    const barrier = { ...clean, save: () => { trace.push("saving"); return save.promise; } };
    const launch = lane.start(1, kind, barrier, async () => assert.fail("a save failure must not launch"));
    await lane.start(1, competitor, clean, async () => assert.fail("competing launch"));
    save.reject(new Error("save conflict"));
    await assert.rejects(launch, /save conflict/);
    assert.equal(lane.occupied, false);
    await lane.start(1, kind, { ...clean, save: async () => { trace.push("saved"); } }, async token => {
      trace.push(token.kind); lane.release(token);
    });
    assert.deepEqual(trace, ["saving", "saved", kind]);
  }
});

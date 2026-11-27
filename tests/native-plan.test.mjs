import assert from "node:assert/strict";
import { test } from "node:test";
import { collectGroups, nativePlan, runtimeClean, summarizeGroup } from "./native/plan.mjs";

test("native group selection checks every required tool has compatible coverage", () => {
  assert.deepEqual(nativePlan(["--group", "go", "--group", "debug", "--require-delve"]).groups, ["go", "debug"]);
  assert.ok(nativePlan(["--require-delve"]).groups.includes("debug"));
  assert.deepEqual(nativePlan(["--quit-only"]).groups, ["quit"]);
  assert.deepEqual(nativePlan(["--project", "repo", "--test-file", "raft_test.go", "--debug-test", "TestLeaderElection"]).groups, ["external"]);
  assert.throws(() => nativePlan(["--group", "files", "--require-delve"]), /requires the debug group/);
  assert.throws(() => nativePlan(["--quit-only", "--require-gopls"]), /requires the go or debug group/);
  assert.throws(() => nativePlan(["--group", "files", "--group", "files"]), /more than once/);
  assert.throws(() => nativePlan(["--group", "not-real"]), /Unknown native group/);
  assert.throws(() => nativePlan(["--group", "files", "--project", "repo"]), /mutually exclusive/);
  assert.throws(() => nativePlan(["--project", "repo", "--require-gopls"]), /requires --test-file/);
});

test("a failed group or a zero exit without a matching report never hides later results", async () => {
  const results = await collectGroups(["crash", "missing", "files"], async group => {
    if (group === "crash") throw new Error("worker was killed");
    const report = group === "files" ? { version: 1, group, cases: [{ name: "opens", result: "pass" }] } : undefined;
    return summarizeGroup(group, { worker: { code: 0, signal: null }, report });
  });
  assert.deepEqual(results.map(result => result.result), ["fail", "fail", "pass"]);
  assert.match(results[1].failure, /invalid matching group report/);
  const verdict = summarizeGroup("go", { worker: { code: 0, signal: null }, report: { version: 1, group: "files", cases: [{ name: "wrong", result: "pass" }] } });
  assert.equal(verdict.result, "fail");
});

test("worker and cleanup failures override green cases and retain primary diagnostics", () => {
  const report = { version: 1, group: "files", cases: [{ name: "opens", result: "pass" }] };
  assert.equal(summarizeGroup("files", { report, worker: { code: 0 }, cleanup: "not cleaned" }).failure, "not cleaned");
  const crash = summarizeGroup("files", { report, worker: { code: null, signal: "SIGKILL" }, cleanup: "still alive" });
  assert.equal(crash.result, "fail");
  assert.match(crash.failure, /SIGKILL/);
  assert.deepEqual(crash.diagnostics, ["still alive"]);
  const startup = summarizeGroup("go", { report: { version: 1, group: "go", failure: "gopls probe rejected", cases: [] },
    worker: { code: 1 }, cleanup: "cleanup unavailable" });
  assert.equal(startup.failure, "gopls probe rejected");
  assert.deepEqual(startup.diagnostics, ["cleanup unavailable"]);
  assert.throws(() => runtimeClean(undefined), /unavailable/);
  assert.throws(() => runtimeClean([{ kind: "error", detail: "fixture" }]), /Unexpected WebView errors/);
});

test("an early success cannot omit native Quit or report only skips", () => {
  const worker = { code: 0, signal: null };
  const report = { version: 1, group: "lifecycle", cases: [{ name: "opens", result: "pass" }] };
  assert.match(summarizeGroup("lifecycle", { worker, report }).failure, /native Quit/);
  const terminal = { action: "clean system Quit", rendererObserved: "last live checkpoint" };
  assert.match(summarizeGroup("lifecycle", { worker, report: { ...report, terminal } }).failure, /native Quit/);
  assert.equal(summarizeGroup("lifecycle", { worker, report: { ...report, terminal }, nativeTerminal: true }).result, "pass");
  const allSkipped = { version: 1, group: "go", cases: [{ name: "go", result: "skip" }] };
  assert.match(summarizeGroup("go", { worker, report: allSkipped }).failure, /passing case/);
});

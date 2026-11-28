import assert from "node:assert/strict";
import { test } from "node:test";
import { collectGroups, goLanguageCases, missingGopls, nativePlan, runtimeClean, summarizeGroup } from "./native/plan.mjs";

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

test("a passing build alone cannot hide missing Go language-service cases", () => {
  const report = { version: 1, group: "go", goplsAvailable: true,
    cases: [{ name: "builds, runs, and tests the actual Go module", result: "pass" }] };
  const result = summarizeGroup("go", { worker: { code: 0 }, report });
  assert.equal(result.result, "fail");
  assert.match(result.failure, /Missing native Go cases: gopls publishes\/clears real errors/);
});

test("a passing case from the initial app cannot stand in for Go relaunch", () => {
  const report = { version: 1, group: "go", cases: [{ name: "builds, runs, and tests the actual Go module", result: "pass" }] };
  const result = summarizeGroup("go", { worker: { code: 0 }, report, reopen: true });
  assert.equal(result.result, "fail");
  assert.match(result.failure, /missing.*restores the selected Go configuration/i);
  report.cases = [{ name: "a new native app restores the selected Go configuration without session secrets", result: "pass" }];
  assert.equal(summarizeGroup("go", { worker: { code: 0 }, report, reopen: true, requireGopls: true }).result, "pass");
});

function goReport(goplsAvailable) {
  return { version: 1, group: "go", goplsAvailable, cases: [
    { name: "builds, runs, and tests the actual Go module", result: "pass" },
    ...goLanguageCases.map(name => goplsAvailable ? { name, result: "pass" } : { name, result: "skip", reason: missingGopls }),
  ] };
}

test("Go case results must agree with the recorded tool probe and required-tool mode", () => {
  const check = (report, requireGopls) => summarizeGroup("go", { worker: { code: 0 }, report, requireGopls });
  assert.equal(check(goReport(true), true).result, "pass");
  assert.equal(check(goReport(false), false).result, "pass");
  assert.match(check(goReport(false), true).failure, /required native gopls/i);
  assert.match(check(goReport(undefined), false).failure, /missing native gopls capability/i);

  const unexpectedPass = goReport(false);
  unexpectedPass.cases[1].result = "pass";
  assert.match(check(unexpectedPass, false).failure, /disagrees with the gopls capability/i);
  const unexpectedSkip = goReport(true);
  unexpectedSkip.cases[1] = { ...unexpectedSkip.cases[1], result: "skip", reason: missingGopls };
  assert.match(check(unexpectedSkip, false).failure, /disagrees with the gopls capability/i);
  const unexplainedSkip = goReport(false);
  delete unexplainedSkip.cases[1].reason;
  assert.match(check(unexplainedSkip, false).failure, /disagrees with the gopls capability/i);
});

test("duplicate records cannot substitute for a missing Go case and cleanup stays primary", () => {
  const report = goReport(true);
  const keyboardCase = "keyboard command runs only the test at a dirty renamed declaration";
  assert.equal(report.cases.at(-1).name, keyboardCase);
  report.cases.pop();
  const options = { worker: { code: 0 }, report, requireGopls: true };
  assert.match(summarizeGroup("go", options).failure, /missing.*dirty renamed declaration/i);
  report.cases.push(report.cases[1]);
  assert.match(summarizeGroup("go", options).failure, /duplicate native Go case/i);
  assert.equal(summarizeGroup("go", { ...options, cleanup: "not cleaned" }).failure, "not cleaned");
});

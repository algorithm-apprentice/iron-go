import assert from "node:assert/strict";
import { parseArgs } from "node:util";

export const fixtureGroups = ["lifecycle", "files", "go", "debug", "quit", "quit-save", "recovery", "recent", "trash", "terminal", "accessibility"];

export const missingGopls = "gopls not installed";
export const goLanguageCases = [
  "gopls publishes/clears real errors and completes a Go symbol",
  "gopls hover and definition work through Monaco",
  "gopls symbol and reference navigation uses unsaved UTF-16 locations",
  "Organize Imports updates only the Go buffer as one undoable edit",
  "Rename previews real cross-file changes and rejects a stale workspace",
  "opens Go standard library and offline dependency source in an isolated read-only viewer",
  "runs exactly one Go test from its editor action",
  "whole-line selection highlights the selected number, not its endpoint",
  "gopls colors identifiers in an unsaved Go buffer",
  "native Go Back and Forward restore a dirty editor across a gopls jump",
  "keyboard command runs only the test at a dirty renamed declaration",
];
const goBuildCase = "builds, runs, and tests the actual Go module";
const goRelaunchCase = "a new native app restores the selected Go configuration without session secrets";

export function nativePlan(args) {
  const { values } = parseArgs({ args, options: {
    "skip-build": { type: "boolean" }, "require-gopls": { type: "boolean" },
    "require-delve": { type: "boolean" }, "trace-editor": { type: "boolean" },
    "gutter-line": { type: "string" }, "quit-only": { type: "boolean" },
    "probe-runner-crash": { type: "boolean" }, group: { type: "string", multiple: true },
    project: { type: "string" }, "test-file": { type: "string" }, "debug-test": { type: "string" },
  } });
  const selectors = [values.group, values["quit-only"], values.project, values["probe-runner-crash"]].filter(Boolean);
  assert.ok(selectors.length < 2, "--group, --quit-only, --project and --probe-runner-crash are mutually exclusive.");
  if (values["test-file"] && !values.project) throw new Error("--test-file requires --project.");
  if (values["debug-test"] && (!values.project || !values["test-file"])) throw new Error("--debug-test requires --project and --test-file.");
  if (values["gutter-line"] && (!values.project || !values["test-file"] || !/^[1-9]\d*$/.test(values["gutter-line"]))) {
    throw new Error("--gutter-line requires a positive line number, --project and --test-file.");
  }
  if (values.project) {
    if (values["require-gopls"] && !values["test-file"]) throw new Error("External --require-gopls requires --test-file.");
    if (values["require-delve"] && !values["debug-test"]) throw new Error("External --require-delve requires --debug-test.");
    return { values, groups: ["external"] };
  }
  const groups = values.group ?? (values["quit-only"] ? ["quit"] : values["probe-runner-crash"] ? ["crash", "files"]
    : fixtureGroups.filter(group => group !== "accessibility" && (group !== "debug" || values["require-delve"])));
  if (values.group) {
    for (const group of groups) if (!fixtureGroups.includes(group)) throw new Error(`Unknown native group: ${group}.`);
    if (new Set(groups).size !== groups.length) throw new Error("Do not select a native group more than once.");
  }
  if (values["require-delve"] && !groups.includes("debug")) throw new Error("--require-delve requires the debug group.");
  if (values["require-gopls"] && !groups.some(group => group === "go" || group === "debug")) throw new Error("--require-gopls requires the go or debug group.");
  return { values, groups };
}

export function runtimeClean(errors) {
  assert.ok(Array.isArray(errors), "The startup runtime-error collector is unavailable.");
  assert.equal(errors.length, 0, `Unexpected WebView errors: ${JSON.stringify(errors)}`);
}

export function validReport(group, report) {
  return report?.version === 1 && report.group === group && Array.isArray(report.cases)
    && (report.cases.length > 0 || (typeof report.failure === "string" && report.failure.length > 0))
    && report.cases.every(entry => typeof entry?.name === "string" && ["pass", "fail", "skip"].includes(entry.result))
    && (report.failure === undefined || typeof report.failure === "string")
    && (report.diagnostics === undefined || (Array.isArray(report.diagnostics) && report.diagnostics.every(message => typeof message === "string")))
    && (report.terminal === undefined || validTerminal(group, report.terminal));
}

export function validTerminal(group, terminal) {
  if (group === "recovery") return ["crash with completed draft", "discard recovery and Quit"].includes(terminal?.action)
    && typeof terminal.rendererObserved === "string";
  const action = { lifecycle: "clean system Quit", quit: "dirty Discard", "quit-save": "dirty Save and Quit", debug: "Quit with executable debugger",
    recent: "Quit with editor session", terminal: "Quit with PTY" }[group];
  return typeof action === "string" && terminal?.action === action && typeof terminal.rendererObserved === "string";
}

function goReportFailure(report, { reopen, requireGopls }) {
  const cases = new Map();
  for (const entry of report.cases) {
    if (cases.has(entry.name)) return `Duplicate native Go case: ${entry.name}`;
    cases.set(entry.name, entry);
  }
  const expected = reopen ? [goRelaunchCase] : [goBuildCase, ...goLanguageCases];
  const missing = expected.filter(name => !cases.has(name));
  if (missing.length) return `Missing native Go cases: ${missing.join("; ")}`;
  const baseline = reopen ? goRelaunchCase : goBuildCase;
  if (cases.get(baseline).result !== "pass") return `Native Go case did not pass: ${baseline}`;
  if (reopen) return;
  if (typeof report.goplsAvailable !== "boolean") return "Missing native gopls capability result.";
  if (!report.goplsAvailable && requireGopls) return "Required native gopls was unavailable.";
  for (const name of goLanguageCases) {
    const entry = cases.get(name);
    if (report.goplsAvailable ? entry.result !== "pass" : entry.result !== "skip" || entry.reason !== missingGopls) {
      return `Native Go case disagrees with the gopls capability result: ${name}`;
    }
  }
}

const recoveryPhases = {
  initial: { ids: ["draft-crash"], action: "crash with completed draft", proof: "observed_crash" },
  reopen: { ids: ["draft-reopened", "draft-writer-isolated", "draft-quit-refused", "draft-discard-quit"],
    action: "discard recovery and Quit", proof: "native_quit" },
  after: { ids: ["draft-retired"], action: undefined, proof: "supervised" },
};
const criticalCases = {
  quit: ["dirty-quit"],
  "quit-save": ["save-quit"],
  terminal: ["pty-io", "pty-credit", "pty-survivor", "pty-cutover"],
};
const recoveryCaseIds = new Set(Object.values(recoveryPhases).flatMap(phase => phase.ids));

function criticalFailure(group, report, reopen, processEvidence) {
  const phase = group === "recovery" ? recoveryPhases[reopen === "after-quit" ? "after" : reopen ? "reopen" : "initial"] : undefined;
  const expected = phase?.ids ?? (Object.hasOwn(criticalCases, group) ? criticalCases[group] : undefined);
  if (!expected) return;
  const byId = new Map();
  for (const entry of report.cases) {
    if (entry.id === undefined) continue;
    if (byId.has(entry.id)) return `Duplicate native case ID: ${entry.id}`;
    if (phase && recoveryCaseIds.has(entry.id) && !expected.includes(entry.id)) {
      return `Native case belongs to another Recovery phase: ${entry.id}`;
    }
    byId.set(entry.id, entry.result);
  }
  for (const id of expected) {
    if (!byId.has(id)) return `Missing native case: ${id}`;
    if (byId.get(id) !== "pass") return `Native case did not pass: ${id}`;
  }
  if (phase && (report.terminal?.action !== phase.action || processEvidence !== phase.proof)) {
    return `Recovery phase is missing matching primary process evidence: ${phase.proof}`;
  }
}

export function summarizeGroup(group, { worker, report, failure, cleanup, nativeTerminal, processEvidence, diagnostics = [], reopen, requireGopls }) {
  const valid = validReport(group, report);
  const primary = failure || (valid && report.failure) || (valid && report.cases.find(entry => entry.result === "fail")?.error)
    || (worker?.code !== 0 || worker.signal ? `Worker exited: ${JSON.stringify(worker ?? null)}` : undefined)
    || (!valid ? "Missing or invalid matching group report." : undefined)
    || (report.cases.some(entry => entry.result === "fail") ? "A worker case failed." : undefined)
    || (!report.cases.some(entry => entry.result === "pass") ? "No passing case in the selected group." : undefined)
    || (["lifecycle", "quit", "quit-save", "debug", "terminal"].includes(group) && (!validTerminal(group, report.terminal) || !nativeTerminal)
      ? "Missing verified native Quit; watchdog EOF is not the Quit oracle." : undefined);
  const secondary = [...diagnostics, ...(valid ? report.diagnostics ?? [] : [])];
  if (cleanup && primary) secondary.push(cleanup);
  const verdict = primary || cleanup || (group === "go" ? goReportFailure(report, { reopen, requireGopls })
    : criticalFailure(group, report, reopen, processEvidence));
  return { group, result: verdict ? "fail" : "pass", ...(verdict ? { failure: verdict } : {}),
    ...(secondary.length ? { diagnostics: secondary } : {}), ...(worker ? { worker } : {}),
    ...(valid ? { cases: report.cases, terminal: report.terminal } : { cases: [] }) };
}

export async function collectGroups(groups, run) {
  const results = [];
  for (const group of groups) {
    try { results.push(await run(group)); }
    catch (error) { results.push({ group, result: "fail", failure: String(error.stack ?? error), cases: [] }); }
  }
  return results;
}

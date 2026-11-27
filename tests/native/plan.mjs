import assert from "node:assert/strict";
import { parseArgs } from "node:util";

export const fixtureGroups = ["lifecycle", "files", "go", "debug", "quit", "quit-save"];

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
    : fixtureGroups.filter(group => group !== "debug" || values["require-delve"]));
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
  const action = { lifecycle: "clean system Quit", quit: "dirty Discard", "quit-save": "dirty Save and Quit" }[group];
  return typeof action === "string" && terminal?.action === action && typeof terminal.rendererObserved === "string";
}

export function summarizeGroup(group, { worker, report, failure, cleanup, nativeTerminal, diagnostics = [] }) {
  const valid = validReport(group, report);
  const primary = failure || (valid && report.failure) || (valid && report.cases.find(entry => entry.result === "fail")?.error)
    || (worker?.code !== 0 || worker.signal ? `Worker exited: ${JSON.stringify(worker ?? null)}` : undefined)
    || (!valid ? "Missing or invalid matching group report." : undefined)
    || (report.cases.some(entry => entry.result === "fail") ? "A worker case failed." : undefined)
    || (!report.cases.some(entry => entry.result === "pass") ? "No passing case in the selected group." : undefined)
    || (["lifecycle", "quit", "quit-save"].includes(group) && (!validTerminal(group, report.terminal) || !nativeTerminal)
      ? "Missing verified native Quit; watchdog EOF is not the Quit oracle." : undefined);
  const secondary = [...diagnostics, ...(valid ? report.diagnostics ?? [] : [])];
  if (cleanup && primary) secondary.push(cleanup);
  return { group, result: primary || cleanup ? "fail" : "pass", ...(primary || cleanup ? { failure: primary || cleanup } : {}),
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

export interface TestSourceLocation { absolute: string; line: number; column: number }
export type TestStatus = "running" | "pass" | "fail" | "skip" | "incomplete";
export interface TestResult {
  status: TestStatus;
  elapsed?: number;
  location?: TestSourceLocation;
  sawFailure?: boolean;
  errorLocation?: boolean;
  started?: boolean;
}
export interface PackageResult extends TestResult { tests: Map<string, TestResult>; failedBuild?: string }
interface BuildResult { failed: boolean; location?: TestSourceLocation; diagnostic?: string }

const MAX_LINE = 64 * 1024;
const MAX_RESULTS = 2000;

function sourceLocation(text: string): TestSourceLocation | undefined {
  for (const line of text.split("\n")) {
    const match = /^\s*(\/[^\r\n]+?\.go):([1-9]\d*)(?::([1-9]\d*))?:/.exec(line);
    if (!match) continue;
    const row = Number(match[2]);
    const column = Number(match[3] ?? 1);
    if (Number.isSafeInteger(row) && Number.isSafeInteger(column)) return { absolute: match[1], line: row, column };
  }
}

export class GoTestStream {
  readonly packages = new Map<string, PackageResult>();
  readonly buildFailures = new Map<string, BuildResult>();
  incomplete = false;
  private readonly decoder = new TextDecoder();
  private pending = "";
  private discarding = false;
  private rows = 0;

  push(bytes: Uint8Array) { return this.lines(this.decoder.decode(bytes, { stream: true })); }

  wireTruncated() { this.incomplete = true; }

  finish(cancelled: boolean) {
    let output = this.lines(this.decoder.decode());
    if (this.pending) {
      output += this.event(this.pending);
      this.pending = "";
    }
    if (cancelled || this.discarding) this.incomplete = true;
    for (const pkg of this.packages.values()) {
      if (pkg.status === "running") { pkg.status = "incomplete"; this.incomplete = true; }
      for (const result of pkg.tests.values()) if (result.status === "running") { result.status = "incomplete"; this.incomplete = true; }
    }
    return output;
  }

  private lines(chunk: string) {
    const lines = (this.pending + chunk).split("\n");
    this.pending = lines.pop()!;
    const output: string[] = [];
    for (const line of lines) {
      if (this.discarding) { this.discarding = false; continue; }
      output.push(this.event(line));
    }
    if (this.pending.length > MAX_LINE) {
      this.pending = "";
      this.discarding = true;
      this.incomplete = true;
    }
    if (this.discarding) this.pending = "";
    return output.join("");
  }

  private takeRow() {
    if (this.rows >= MAX_RESULTS) { this.incomplete = true; return false; }
    this.rows++;
    return true;
  }

  private event(line: string): string {
    let event: Record<string, unknown>;
    try { event = line.length <= MAX_LINE ? JSON.parse(line) : null; }
    catch { this.incomplete = true; return line + "\n"; }
    if (!event || typeof event.Action !== "string") { this.incomplete = true; return line + "\n"; }
    const action = event.Action;
    const output = typeof event.Output === "string" ? event.Output : "";
    if (action === "build-output" || action === "build-fail") {
      const id = event.ImportPath;
      if (typeof id !== "string" || !id) { this.incomplete = true; return output || line + "\n"; }
      let build = this.buildFailures.get(id);
      if (!build && this.takeRow()) { build = { failed: false }; this.buildFailures.set(id, build); }
      if (build) {
        build.failed ||= action === "build-fail";
        build.location ??= sourceLocation(output);
        if (output.trim()) build.diagnostic ??= output.trim().slice(0, 1000);
      }
      return output;
    }
    if (!["start", "run", "pause", "cont", "pass", "fail", "skip", "output", "bench"].includes(action)) return line + "\n";
    const id = event.Package;
    if (typeof id !== "string" || !id) { this.incomplete = true; return output || line + "\n"; }
    let pkg = this.packages.get(id);
    if (!pkg && this.takeRow()) { pkg = { status: "running", tests: new Map() }; this.packages.set(id, pkg); }
    if (!pkg) return output;
    const name = typeof event.Test === "string" ? event.Test : "";
    let result: TestResult | undefined = pkg;
    if (name) {
      result = pkg.tests.get(name);
      if (!result && this.takeRow()) { result = { status: "running" }; pkg.tests.set(name, result); }
    } else if (typeof event.FailedBuild === "string") pkg.failedBuild = event.FailedBuild;
    if (result) {
      if (action === "run" || action === "start") result.status = "running";
      if (action === "run") result.started = true;
      if (action === "fail") result.sawFailure = true;
      if (action === "pass" || action === "fail" || action === "skip") result.status = result.sawFailure ? "fail" : action;
      if (typeof event.Elapsed === "number" && Number.isFinite(event.Elapsed) && event.Elapsed >= 0) result.elapsed = event.Elapsed;
      const location = output && sourceLocation(output);
      if (location && !result.errorLocation) {
        result.location = location;
        result.errorLocation = event.OutputType === "error";
      }
    }
    return output;
  }
}

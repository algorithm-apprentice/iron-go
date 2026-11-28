import { message } from "./dialogs";
import { DebugInspection, type DebugInspectionState } from "./debug-inspection";
import { monaco, type DocumentTab } from "./editor";
import { dirname, inPath } from "./project-model";
import { packageForFile } from "./run-targets";
import { host, type NativeFolder, type ProgramDebugEvent, type RunLaunch, type TaskEvent } from "./workspace";

interface BreakpointFile {
  lines: number[];
  model?: monaco.editor.ITextModel;
  ids: string[];
  verified: Set<number>;
}

export class Breakpoints {
  private readonly files = new Map<string, BreakpointFile>();

  private capture(file: BreakpointFile) {
    if (file.model && file.ids.length) {
      file.lines = [...new Set(file.ids.flatMap(id => {
        const range = file.model?.getDecorationRange(id);
        return range ? [range.startLineNumber] : [];
      }))].sort((a, b) => a - b);
    }
    return file.lines;
  }

  private paint(file: BreakpointFile) {
    file.ids = file.model?.deltaDecorations(file.ids, file.lines.map(line => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: `debug-breakpoint${file.verified.has(line) ? " verified" : ""}`,
        glyphMarginHoverMessage: { value: file.verified.has(line) ? "Verified breakpoint" : "Pending breakpoint" },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }))) ?? [];
  }

  open(tab: DocumentTab) {
    const file = this.files.get(tab.path);
    if (!file) return;
    file.model = tab.model;
    this.paint(file);
  }

  close(tab: DocumentTab) {
    const file = this.files.get(tab.path);
    if (!file) return;
    this.capture(file);
    file.model = undefined;
    file.ids = [];
  }

  toggle(tab: DocumentTab, line: number) {
    const file = this.files.get(tab.path) ?? { model: tab.model, lines: [], ids: [], verified: new Set<number>() };
    const lines = new Set(this.capture(file));
    if (lines.has(line)) lines.delete(line); else lines.add(line);
    file.lines = [...lines].sort((a,b) => a-b);
    file.verified.clear();
    this.files.set(tab.path, file);
    this.paint(file);
  }

  entries() { return [...this.files].map(([path, file]) => [path, this.capture(file)] as const); }
  at(path: string) { const file = this.files.get(path); return file ? this.capture(file) : []; }
  verify(path: string, lines: number[]) {
    const file = this.files.get(path);
    if (!file) return;
    this.capture(file);
    file.verified = new Set(lines);
    this.paint(file);
  }
  clearVerification() { for (const [path] of this.files) this.verify(path, []); }
  rebind(source: string, destination?: string) {
    for (const [path, file] of [...this.files]) {
      if (!inPath(path, source)) continue;
      this.files.delete(path);
      const lines = this.capture(file);
      if (destination) this.files.set(`${destination}${path.slice(source.length)}`, { lines, ids: [], verified: new Set() });
    }
  }
  reset() {
    for (const file of this.files.values()) file.model?.deltaDecorations(file.ids, []);
    this.files.clear();
  }
}

type DebugMessage =
  | { type: "response"; request_seq: number; success: boolean; message?: string; body?: unknown }
  | { type: "event"; event: string; body?: unknown };

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: number;
}

interface DebugEvents {
  isCurrent(): boolean;
  admitted(): void;
  paused(path: string | undefined, line: number, reason: string, currentSelection: () => boolean, focus: boolean): void;
  pauseReady?(): void;
  inspection?(state?: DebugInspectionState): void;
  running(): void;
  closing?(): void;
  finished(reason: string): void;
  output(text: string): void;
  build?(event: TaskEvent): void;
  stopError?(error: unknown): void;
}

type DebugHost = Pick<typeof host, "debug" | "sendDebug" | "stopDebug" | "debugProgram" | "stopDebugProgram">;
type DebugTarget = { path: string; name: string } | { package: string; launch: RunLaunch };

export class DebugSession {
  private server?: number;
  private admission?: Promise<{ server: number; output?: string }>;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private initialized = false;
  private configDone = false;
  private closed = false;
  private stopping = false;
  private thread?: number;
  private pauseRevision = 0;
  private outputRemaining = 512 * 1024;
  private program = false;
  private cancelProgramReady?: () => void;
  private finishReason?: string;
  private ended = false;
  private readonly inspection = new DebugInspection(
    (command, args) => this.request(command, args),
    state => this.events.inspection?.(state),
    (frame, reason, current, focus) => {
      const prefix = `${this.folder.path.replace(/\/$/, "")}/`;
      const file = frame?.source?.path;
      this.events.paused(file?.startsWith(prefix) ? file.slice(prefix.length) : undefined, frame?.line ?? 1, reason, current, focus);
    },
    () => !this.closed && !this.stopping && this.events.isCurrent(),
  );

  constructor(private readonly folder: NativeFolder, private readonly marks: Breakpoints, private readonly events: DebugEvents, private readonly native: DebugHost = host) {}

  get paused() { return !this.closed && !this.stopping && this.thread !== undefined; }
  get ready() { return this.configDone; }
  get canStop() { return this.server !== undefined && !this.ended && (!this.closed || this.program) && !this.stopping; }
  private absolute(path: string) { return `${this.folder.path.replace(/\/$/, "")}/${path}`; }

  async start(path: string, name: string) {
    await this.startTarget({ path, name });
  }

  async startProgram(packageName: string, launch: RunLaunch) {
    await this.startTarget({ package: packageName, launch });
  }

  private async startTarget(target: DebugTarget) {
    this.program = "package" in target;
    let publishReady!: (ready?: { output: string; path: string | null }) => void;
    const readiness = new Promise<{ output: string; path: string | null } | undefined>(resolve => { publishReady = resolve; });
    this.cancelProgramReady = () => publishReady();
    const handle = (event: ProgramDebugEvent) => {
      switch (event.type) {
        case "closed": this.finish(this.stopping ? "Debug session stopped" : event.reason, this.program); break;
        case "message": void this.receive(event.message as DebugMessage); break;
        case "build": if (!this.closed && this.events.isCurrent()) this.events.build?.(event.event); break;
        case "ready": publishReady(event); break;
      }
    };
    // Store the admission promise before any channel event can call finish.
    const admission: NonNullable<DebugSession["admission"]> = Promise.resolve().then(async () => "package" in target
      ? { server: await this.native.debugProgram(this.folder.id, target.package, target.launch, handle) }
      : this.native.debug(this.folder.id, packageForFile(target.path), handle));
    this.admission = admission;
    try {
      const { server, output } = await admission;
      if (this.closed) return;
      this.server = server;
      this.events.admitted();
      let launch: object;
      if ("package" in target) {
        const ready = await readiness;
        if (!ready || this.closed || this.stopping) return;
        const env = { PATH: ready.path, ...target.launch.environment };
        launch = { mode: "exec", program: ready.output, cwd: ".", args: target.launch.args, env, outputMode: "remote", stopOnEntry: false };
      } else {
        const dir = dirname(target.path);
        const program = dir ? this.absolute(dir) : this.folder.path;
        const filter = target.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        launch = { mode: "test", program, cwd: program, output, args: ["-test.run", `^${filter}$`], stopOnEntry: false };
      }
      await this.request("initialize", { adapterID: "go", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" });
      if (this.closed || this.stopping) return;
      await this.request("launch", launch, 90_000);
      if (this.closed || this.stopping) return;
      if (!this.initialized) throw new Error("Delve did not initialize the debug session.");
      for (const [file, lines] of this.marks.entries()) await this.setBreakpoints(file, lines);
      if (this.closed || this.stopping) return;
      this.configDone = true;
      this.events.running();
      await this.request("configurationDone", {});
    } catch (error) { if (!this.closed && !this.stopping) this.finish(`Debug failed: ${message(error)}`); }
  }

  private request<T = unknown>(command: string, args: object, timeout = 8_000): Promise<T> {
    const server = this.server;
    if (this.closed || server === undefined) return Promise.reject(new Error("Delve is not connected."));
    const seq = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const fail = (error: unknown) => {
        const pending = this.pending.get(seq);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        this.pending.delete(seq);
        reject(new Error(message(error)));
      };
      const timer = window.setTimeout(() => fail(`Delve ${command} timed out.`), timeout);
      this.pending.set(seq, { resolve: value => resolve(value as T), reject, timer });
      void this.native.sendDebug(server, { seq, type: "request", command, arguments: args }).catch(fail);
    });
  }

  async setBreakpoints(path: string, lines = this.marks.at(path)) {
    const result = await this.request<{ breakpoints: { verified: boolean }[] }>("setBreakpoints", {
      source: { path: this.absolute(path) }, breakpoints: lines.map(line => ({ line })),
    });
    if (!this.closed && this.events.isCurrent()) this.marks.verify(path, lines.filter((_, index) => result.breakpoints[index]?.verified));
  }

  private async receive(event: DebugMessage) {
    if (this.closed) return;
    if (event.type === "response") {
      const pending = this.pending.get(event.request_seq);
      if (!pending) return;
      this.pending.delete(event.request_seq);
      window.clearTimeout(pending.timer);
      if (event.success) pending.resolve(event.body);
      else pending.reject(new Error(event.message ?? "Delve rejected a request."));
    } else if (event.type === "event") {
      switch (event.event) {
        case "initialized": this.initialized = true; break;
        case "continued":
          if (!this.stopping) this.clearPause();
          break;
        case "terminated": this.finish(this.stopping ? "Debug session stopped" : "Debug session finished"); break;
        case "output": {
          const value = (event.body as { output?: string } | undefined)?.output;
          if (typeof value !== "string" || !this.outputRemaining) break;
          const chunk = value.slice(0, this.outputRemaining);
          this.events.output(chunk);
          this.outputRemaining -= chunk.length;
          if (!this.outputRemaining) this.events.output("Debug output limit reached.\n");
          break;
        }
        case "stopped": {
          const body = event.body as { threadId?: number; reason?: string } | undefined;
          const thread = body?.threadId;
          if (thread === undefined || this.stopping || !this.events.isCurrent()) break;
          const reason = body?.reason ?? "pause";
          this.thread = thread;
          this.pauseRevision++;
          this.events.pauseReady?.();
          this.inspection.begin(thread, reason);
          break;
        }
      }
    }
  }

  private clearPause() {
    this.thread = undefined;
    this.inspection.clear();
    this.events.running();
  }

  async resume(command: "continue" | "next" | "stepIn" | "stepOut") {
    const thread = this.thread;
    if (thread === undefined || !this.paused) return;
    const revision = this.pauseRevision;
    this.clearPause();
    try { await this.request(command, { threadId: thread }); }
    catch (error) {
      if (!this.closed && !this.stopping && this.events.isCurrent() && this.pauseRevision === revision) this.finish(`Debug failed: ${message(error)}`);
    }
  }

  async stop() {
    if (!this.canStop) return;
    this.stopping = true;
    this.clearPause();
    if (this.program) {
      try { await this.native.stopDebugProgram(this.server!); }
      catch (error) {
        this.stopping = false;
        if (!this.ended) this.events.stopError?.(error);
      }
      return;
    }
    try { await this.request("disconnect", { terminateDebuggee: true }, 2500); } catch { /* The host still owns process teardown. */ }
    this.finish("Debug session stopped");
  }

  retire() { this.finish("Debug session stopped"); }

  private finish(reason: string, nativeRetired = false) {
    if (this.closed) {
      if (nativeRetired) this.complete(this.finishReason ?? reason);
      return;
    }
    this.closed = true;
    this.finishReason = reason;
    this.cancelProgramReady?.();
    this.thread = undefined;
    this.inspection.clear();
    this.events.closing?.();
    // Drop the native lane before re-enabling Run and Test controls.
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    if (nativeRetired) { this.complete(reason); return; }
    void Promise.resolve(this.admission).catch(() => undefined).then(async result => {
      if (result) {
        if (this.program) await this.native.stopDebugProgram(result.server);
        else await this.native.stopDebug(result.server);
      }
      this.complete(reason);
    }).catch(error => {
      if (!this.program) this.complete(reason);
      else if (!this.ended) this.events.stopError?.(error);
    });
  }

  private complete(reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.events.finished(reason);
  }
}

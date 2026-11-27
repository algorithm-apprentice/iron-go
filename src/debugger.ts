import { message } from "./dialogs";
import { monaco, type DocumentTab } from "./editor";
import { dirname } from "./project-model";
import { packageForFile } from "./run-targets";
import { host, type NativeFolder } from "./workspace";

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
  paused(path: string | undefined, line: number, reason: string, currentPause: () => boolean): void;
  running(): void;
  finished(reason: string): void;
  output(text: string): void;
}

type DebugHost = Pick<typeof host, "debug" | "sendDebug" | "stopDebug">;

export class DebugSession {
  private server?: number;
  private admission?: ReturnType<DebugHost["debug"]>;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private initialized = false;
  private configDone = false;
  private closed = false;
  private stopping = false;
  private thread?: number;
  private pauseRevision = 0;
  private outputRemaining = 512 * 1024;

  constructor(private readonly folder: NativeFolder, private readonly marks: Breakpoints, private readonly events: DebugEvents, private readonly native: DebugHost = host) {}

  get paused() { return this.thread !== undefined; }
  get ready() { return this.configDone; }
  get canStop() { return this.server !== undefined && !this.closed && !this.stopping; }
  private absolute(path: string) { return `${this.folder.path.replace(/\/$/, "")}/${path}`; }

  async start(path: string, name: string) {
    // Store the admission promise before any channel event can call finish.
    const admission = Promise.resolve().then(() => this.native.debug(this.folder.id, packageForFile(path), event => {
      if (event.type === "closed") this.finish(this.stopping ? "Debug session stopped" : event.reason);
      else void this.receive(event.message as DebugMessage);
    }));
    this.admission = admission;
    try {
      const { server, output } = await admission;
      if (this.closed) return;
      this.server = server;
      this.events.admitted();
      await this.request("initialize", { adapterID: "go", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" });
      const dir = dirname(path);
      const program = dir ? this.absolute(dir) : this.folder.path;
      const filter = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      await this.request("launch", { mode: "test", program, cwd: program, output, args: ["-test.run", `^${filter}$`], stopOnEntry: false }, 90_000);
      if (!this.initialized) throw new Error("Delve did not initialize the debug session.");
      for (const [file, lines] of this.marks.entries()) await this.setBreakpoints(file, lines);
      this.configDone = true;
      this.events.running();
      await this.request("configurationDone", {});
    } catch (error) { if (!this.closed) this.finish(`Debug failed: ${message(error)}`); }
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
        case "continued": this.thread = undefined; this.events.running(); break;
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
          if (thread === undefined) break;
          const reason = body?.reason ?? "pause";
          this.thread = thread;
          const revision = ++this.pauseRevision;
          const currentPause = () => !this.closed && this.thread === thread && this.pauseRevision === revision;
          try {
            const result = await this.request<{ stackFrames: { source?: { path?: string }; line: number }[] }>("stackTrace", { threadId: thread, levels: 1 });
            if (!currentPause()) break;
            const frame = result.stackFrames[0];
            const prefix = `${this.folder.path.replace(/\/$/, "")}/`;
            const file = frame?.source?.path;
            this.events.paused(file?.startsWith(prefix) ? file.slice(prefix.length) : undefined, frame?.line ?? 1, reason, currentPause);
          } catch { if (currentPause()) this.events.paused(undefined, 1, reason, currentPause); }
          break;
        }
      }
    }
  }

  async resume(command: "continue" | "next") {
    const thread = this.thread;
    if (thread === undefined || this.closed) return;
    this.thread = undefined;
    this.events.running();
    try { await this.request(command, { threadId: thread }); }
    catch (error) { if (!this.closed) this.finish(`Debug failed: ${message(error)}`); }
  }

  async stop() {
    if (!this.canStop) return;
    this.stopping = true;
    try { await this.request("disconnect", { terminateDebuggee: true }, 2500); } catch { /* The host still owns process teardown. */ }
    this.finish("Debug session stopped");
  }

  retire() { this.finish("Debug session stopped"); }

  private finish(reason: string) {
    if (this.closed) return;
    this.closed = true;
    // Drop the native lane before re-enabling Run and Test controls.
    void Promise.resolve(this.admission).then(result => result && this.native.stopDebug(result.server))
      .catch(() => {}).then(() => this.events.finished(reason));
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

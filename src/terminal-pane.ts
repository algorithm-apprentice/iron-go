import type { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { byId, message } from "./dialogs";
import { host, type NativeFolder, type TaskEvent, type TerminalEvent, type TerminalLaunch, type TerminalSize } from "./workspace";

interface TerminalSession {
  folder: NativeFolder;
  launch: TerminalLaunch;
  active: boolean;
  closing: boolean;
  retiring: boolean;
  discard: boolean;
  terminal?: Terminal;
  fit?: ResizeObserver;
  admission?: Promise<number>;
  id?: number;
  input: Promise<void>;
  pendingInput: number;
}

export class TerminalPane {
  private session?: TerminalSession;
  private readonly encoder = new TextEncoder();
  private readonly mount = byId("terminal-view");
  private readonly tab = byId("terminal-tab");
  private readonly status = byId("terminal-status");
  private holdAck = false;
  private readonly heldAcks: { ack(): void; bytes: number }[] = [];

  constructor(private readonly reveal: (visible: boolean) => void, private readonly report: (error: unknown) => void,
    private readonly activityChanged: () => void) {}

  get active() { return this.session?.active ?? false; }
  isGo(folder: NativeFolder) { return this.session?.folder === folder && this.session.launch.kind === "go" && this.session.active; }

  async start(folder: NativeFolder, launch: TerminalLaunch, events?: { started(): void; build(event: TaskEvent): void; closed(reason: string): void }) {
    if (this.active) throw new Error("Close the active terminal before starting another.");
    this.reset();
    const session: TerminalSession = { folder, launch, active: true, closing: false, retiring: false, discard: false, input: Promise.resolve(), pendingInput: 0 };
    this.session = session;
    this.tab.hidden = false;
    this.reveal(true);
    this.status.textContent = launch.kind === "shell" ? "Starting local shell…" : "Building Go program…";
    const current = () => this.session === session;
    try {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (!current()) return;
      const terminal = session.terminal = new Terminal({ scrollback: 2000, cursorBlink: true, allowProposedApi: false,
        fontFamily: '"JetBrains Mono", Menlo, monospace', fontSize: 13 });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(this.mount);
      fit.fit();
      session.fit = new ResizeObserver(() => { if (this.mount.clientWidth > 0 && this.mount.clientHeight > 0) fit.fit(); });
      session.fit.observe(this.mount);
      terminal.onData(data => this.input(session, data));
      terminal.onResize(size => { if (current() && session.id !== undefined && session.active && !session.retiring) this.resize(session.id, size); });
      if (session.closing) { events?.closed("Terminal stopped"); this.reset(); return; }
      const deliver = (event: TerminalEvent) => {
        if (!current()) return;
        session.id ??= event.id;
        if (event.id !== session.id) return;
        if (event.type === "ready") {
          this.status.textContent = launch.kind === "shell" ? "Local shell" : "Go program";
          this.resize(event.id, { cols: terminal.cols, rows: terminal.rows });
          if (!session.closing && !byId("terminal-pane").hidden) terminal.focus();
        } else if (event.type === "output") {
          terminal.write(Uint8Array.from(event.bytes), () => {
            const ack = () => { if (current() && session.active) void host.terminalAck(event.id, event.sequence).catch(() => {}); };
            if (import.meta.env.VITE_IRON_E2E === "1" && this.holdAck) this.heldAcks.push({ ack, bytes: event.bytes.length });
            else ack();
          });
        } else if (event.type === "build") {
          events?.build(event.event);
        } else if (event.type === "cleanup") {
          session.retiring = true;
          this.status.textContent = event.reason;
        } else {
          session.active = false;
          session.closing = false;
          this.activityChanged();
          this.status.textContent = event.reason;
          events?.closed(event.reason);
          if (session.discard) this.reset();
        }
      };
      session.admission = host.startTerminal(folder.id, launch, { cols: terminal.cols, rows: terminal.rows }, deliver);
      const id = await session.admission;
      if (!current()) return;
      session.id ??= id;
      if (session.active) events?.started();
    } catch (error) {
      if (!current()) return;
      this.reset();
      throw error;
    }
  }

  async stop(discard = false) {
    const session = this.session;
    if (!session) return;
    if (!session.active) { if (discard) this.reset(); return; }
    if (session.closing) return;
    session.closing = true;
    session.discard ||= discard;
    try {
      const id = session.id ?? await session.admission;
      if (id !== undefined && this.session === session) await host.stopTerminal(id);
    } catch (error) {
      if (this.session === session) { session.closing = false; this.status.textContent = message(error); }
      throw error;
    }
  }

  reset() {
    const previous = this.session;
    this.session = undefined;
    if (!this.tab.hidden) this.reveal(false);
    previous?.fit?.disconnect();
    previous?.terminal?.dispose();
  }

  private resize(id: number, size: TerminalSize) {
    if (size.cols < 2 || size.rows < 2) return;
    void host.terminalResize(id, { cols: Math.min(size.cols, 500), rows: Math.min(size.rows, 300) }).catch(() => {});
  }

  private input(session: TerminalSession, data: string) {
    if (!session.active || session.closing || session.retiring) return;
    const size = this.encoder.encode(data).length;
    // Rust reserves the other 32 KiB, including its partially written chunk.
    if (size + session.pendingInput > 32 * 1024) { this.report("The terminal input queue is full."); return; }
    session.pendingInput += size;
    session.input = session.input.then(async () => {
      const id = session.id ?? await session.admission;
      if (id === undefined) return;
      for (let start = 0; start < data.length;) {
        if (this.session !== session || !session.active || session.closing || session.retiring) return;
        let end = Math.min(start + 2048, data.length);
        if (end < data.length && /[\ud800-\udbff]/.test(data[end - 1])) end--;
        await host.terminalInput(id, data.slice(start, end));
        start = end;
      }
    }).catch(error => { if (this.session === session && session.active) this.report(error); })
      .finally(() => { session.pendingInput -= size; });
  }

  acceptanceInput(value: string) { this.session?.terminal?.input(value, true); }
  acceptanceHoldAck(hold: boolean) {
    this.holdAck = hold;
    if (!hold) for (const { ack } of this.heldAcks.splice(0)) ack();
  }
  acceptanceSnapshot() {
    const buffer = this.session?.terminal?.buffer.active;
    const lines: string[] = [];
    for (let index = 0; buffer && index < buffer.length; index++) {
      const line = buffer.getLine(index);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return { active: this.active, text: lines.join("\n"), held: this.heldAcks.length,
      heldBytes: this.heldAcks.reduce((total, entry) => total + entry.bytes, 0), id: this.session?.id,
      cols: this.session?.terminal?.cols, rows: this.session?.terminal?.rows };
  }
}

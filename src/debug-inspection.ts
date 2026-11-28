import { message } from "./dialogs";

const stackLimit = 32;
const scopeLimit = 16;
export const variableLimit = 100;
const requestLimit = 4;

export interface DebugFrame { id: number; name: string; line: number; source?: { path?: string } }
export interface DebugScope { name: string; variablesReference: number; expensive?: boolean }
export interface DebugVariable { name: string; value: string; variablesReference: number }
export interface DebugInspectionState {
  frames: readonly DebugFrame[];
  stackNote?: string;
  select(frame: DebugFrame): void;
  selected?: DebugFrame;
  scopes: readonly DebugScope[];
  scopesNote?: string;
  load(reference: number): Promise<{ variables: DebugVariable[]; truncated: boolean } | undefined>;
  current(): boolean;
}

interface Pause {
  reason: string;
  frames: DebugFrame[];
  stackNote?: string;
  selection?: FrameSelection;
}

interface FrameSelection {
  frame: DebugFrame;
  scopes: DebugScope[];
  note?: string;
}

export class DebugInspection {
  private pause?: Pause;
  private requests = 0;
  private waiting?: () => void;

  constructor(
    private readonly request: <T>(command: string, args: object) => Promise<T>,
    private readonly changed: (state?: DebugInspectionState) => void,
    private readonly reveal: (frame: DebugFrame | undefined, reason: string, current: () => boolean, focus: boolean) => void,
    private readonly owned: () => boolean,
  ) {}

  begin(thread: number, reason: string) {
    const pause: Pause = { reason, frames: [], stackNote: "Loading call stack…" };
    this.pause = pause;
    this.waiting = undefined;
    this.publish(pause);
    const current = () => this.current(pause);
    this.topLevel(current, async () => {
      try {
        const result = await this.request<{ stackFrames: DebugFrame[]; totalFrames?: number }>("stackTrace", { threadId: thread, levels: stackLimit });
        if (!current()) return;
        pause.frames = result.stackFrames.slice(0, stackLimit);
        pause.stackNote = (result.totalFrames ?? result.stackFrames.length) > stackLimit ? `Showing the first ${stackLimit} frames.` : undefined;
        if (pause.frames.length) this.select(pause, pause.frames[0], true);
        else pause.stackNote = "No call stack was reported.";
      } catch (error) {
        if (current()) pause.stackNote = message(error);
      }
      if (current() && !pause.selection) {
        this.publish(pause);
        this.reveal(undefined, reason, current, false);
      }
    });
  }

  clear() {
    if (!this.pause) return;
    this.pause = undefined;
    this.waiting = undefined;
    this.changed();
  }

  private current(pause: Pause) { return this.pause === pause && this.owned(); }

  private select(pause: Pause, frame: DebugFrame, focus = false) {
    if (!this.current(pause) || !pause.frames.includes(frame) || pause.selection?.frame === frame) return;
    const selection: FrameSelection = { frame, scopes: [], note: "Loading scopes…" };
    pause.selection = selection;
    const current = () => this.current(pause) && pause.selection === selection;
    this.publish(pause);
    this.reveal(frame, pause.reason, current, focus);
    this.topLevel(current, async () => {
      try {
        const result = await this.request<{ scopes: DebugScope[] }>("scopes", { frameId: frame.id });
        if (!current()) return;
        selection.scopes = result.scopes.slice(0, scopeLimit);
        selection.note = result.scopes.length > scopeLimit ? `Showing the first ${scopeLimit} scopes.` :
          selection.scopes.length ? undefined : "No variable scopes were reported.";
      } catch (error) { if (current()) selection.note = message(error); }
      if (current()) this.publish(pause);
    });
  }

  private publish(pause: Pause) {
    const selection = pause.selection;
    const current = () => this.current(pause) && pause.selection === selection;
    this.changed({ frames: pause.frames, stackNote: pause.stackNote, select: frame => this.select(pause, frame),
      selected: selection?.frame, scopes: selection?.scopes ?? [], scopesNote: selection?.note, current,
      load: async reference => {
        if (!current()) return;
        if (this.requests >= requestLimit) throw new Error("Waiting for other inspection requests. Retry when they finish.");
        return this.withSlot(async () => {
          const result = await this.request<{ variables: DebugVariable[] }>("variables", { variablesReference: reference, start: 0, count: variableLimit + 1 });
          if (!current()) return;
          return { variables: result.variables.slice(0, variableLimit), truncated: result.variables.length > variableLimit };
        });
      },
    });
  }

  private topLevel(current: () => boolean, run: () => Promise<void>) {
    const start = () => { if (current()) void this.withSlot(run); };
    this.waiting = undefined;
    if (this.requests >= requestLimit) this.waiting = start;
    else start();
  }

  private async withSlot<T>(run: () => Promise<T>) {
    this.requests++;
    try { return await run(); }
    finally {
      this.requests--;
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting?.();
    }
  }
}

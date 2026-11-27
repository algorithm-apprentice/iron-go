import type { TaskEvent, TaskKind } from "./workspace";

type LaunchKind = TaskKind | "debug";
export type Launch<P> = Readonly<{ project: P; kind: LaunchKind }>;
type Activity<P, D> =
  | { token: Launch<P>; phase: "preparing" | "task-starting" | "task-running" }
  | { token: Launch<P>; phase: "task-stopping"; requestPending: boolean; finished: boolean }
  | { token: Launch<P>; phase: "debug"; session: D };

interface SaveBarrier {
  revision(): number;
  save(): Promise<void>;
  dirty(): boolean;
}

export class ExecutionLane<P, D> {
  private activity?: Activity<P, D>;
  private readonly changed: () => void;

  constructor(changed: () => void) { this.changed = changed; }

  get occupied() { return this.activity !== undefined; }
  get preparing() { return this.activity?.phase === "preparing"; }
  get task() {
    const token = this.activity?.token;
    return token?.kind !== "debug" ? token?.kind : undefined;
  }
  get canStopTask() { return this.activity?.phase === "task-running"; }
  get debug() { return this.activity?.phase === "debug" ? this.activity.session : undefined; }

  owns(token: Launch<P>) { return this.activity?.token === token; }

  private set(activity?: Activity<P, D>) {
    this.activity = activity;
    this.changed();
  }

  release(token: Launch<P>) {
    if (!this.owns(token)) return false;
    this.set();
    return true;
  }

  retire() {
    const debug = this.debug;
    this.set();
    return debug;
  }

  async start(project: P, kind: LaunchKind, barrier: SaveBarrier, dispatch: (token: Launch<P>) => Promise<void>) {
    if (this.occupied) return;
    const token: Launch<P> = { project, kind };
    const revision = barrier.revision();
    this.set({ token, phase: "preparing" });
    try {
      await barrier.save();
      if (!this.owns(token)) return;
      if (barrier.revision() !== revision || barrier.dirty()) {
        throw new Error(kind === "debug" ? "Files changed while saving. Debug again." : "Files changed while saving. Run the task again.");
      }
      if (kind !== "debug") this.set({ token, phase: "task-starting" });
      await dispatch(token);
    } catch (error) {
      if (!this.owns(token) || (this.activity?.phase === "task-stopping" && this.activity.finished)) return;
      this.release(token);
      throw error;
    }
  }

  attachDebug(token: Launch<P>, session: D) {
    if (!this.owns(token)) return false;
    this.set({ token, phase: "debug", session });
    return true;
  }

  taskEvent(token: Launch<P>, type: TaskEvent["type"]) {
    const state = this.activity;
    if (!state || state.token !== token || (state.phase === "task-stopping" && state.finished)) return false;
    if (type === "started" && state.phase === "task-starting") this.set({ token, phase: "task-running" });
    if (type === "finished") {
      if (state.phase === "task-stopping" && state.requestPending) this.set({ ...state, finished: true });
      else this.release(token);
    }
    return true;
  }

  async stopTask(stop: (project: P) => Promise<void>) {
    const state = this.activity;
    if (state?.phase !== "task-running") return;
    const { token } = state;
    this.set({ token, phase: "task-stopping", requestPending: true, finished: false });
    try {
      await stop(token.project);
    } catch (error) {
      const current = this.activity;
      if (current?.token !== token || current.phase !== "task-stopping") return;
      if (current.finished) { this.release(token); return; }
      this.set(state);
      throw error;
    }
    const current = this.activity;
    if (current?.token !== token || current.phase !== "task-stopping") return;
    if (current.finished) this.release(token);
    else this.set({ ...current, requestPending: false });
  }
}

import { message } from "./dialogs";
import { bufferText, type DocumentTab } from "./editor";
import { host, type DraftRetirement, type NativeFolder, type ReadableDisk } from "./workspace";

interface PendingDraft {
  folder: NativeFolder;
  started: number;
  revision: number;
  due?: number;
  error?: string;
  saved: boolean;
  completion?: { promise: Promise<void>; resolve(): void };
}

export class DraftRecorder {
  private revision = 0;
  private timer?: number;
  private running = false;
  private freezes = 0;
  private readonly pending = new Map<DocumentTab, PendingDraft>();

  constructor(private readonly indicator: HTMLElement) {}

  plan(folder?: NativeFolder): DraftRetirement | undefined {
    return folder ? { id: folder.id, revision: ++this.revision } : undefined;
  }

  freeze() {
    this.freezes++;
    clearTimeout(this.timer);
    return () => { this.freezes--; this.pump(); };
  }

  schedule(folder: NativeFolder | undefined, tab: DocumentTab, immediate = false) {
    if (!folder || (!tab.dirty && !this.pending.has(tab))) return;
    let task = this.pending.get(tab);
    const now = performance.now();
    if (!task) {
      task = { folder, started: now, revision: 0, saved: false };
      this.pending.set(tab, task);
    }
    task.revision = ++this.revision;
    task.saved = false;
    if (task.due === undefined) task.started = now;
    const due = immediate || !tab.dirty || (task.due !== undefined && task.due <= now) ? now : Math.min(now + 300, task.started + 1200);
    task.due = due;
    task.completion?.resolve();
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    task.completion = { promise, resolve };
    this.pump();
    this.render();
  }

  settled(tab: DocumentTab) { return this.pending.get(tab)?.completion?.promise; }
  recorded(tab: DocumentTab) { return this.pending.get(tab)?.saved === true; }

  async discard(folder: NativeFolder | undefined, tab: DocumentTab, reviewed?: ReadableDisk) {
    const task = this.pending.get(tab);
    if (!folder || (!task && !reviewed)) return;
    const revision = ++this.revision;
    if (task) {
      task.revision = revision;
      task.due = undefined;
      task.completion?.resolve();
    }
    try { await host.retireDraft(folder.id, tab.path, revision, reviewed); }
    catch (error) {
      if (!tab.model.isDisposed()) this.schedule(folder, tab, true);
      else if (task) { task.error = `Old draft not retired for ${tab.path}: ${message(error)}`; this.render(); }
      throw error;
    }
    if (task && this.pending.get(tab) === task && task.revision === revision) this.pending.delete(tab);
    this.render();
  }

  reset() {
    clearTimeout(this.timer);
    for (const task of this.pending.values()) task.completion?.resolve();
    this.pending.clear();
    this.render();
  }

  forget(tabs: readonly DocumentTab[]) {
    for (const tab of tabs) {
      this.pending.get(tab)?.completion?.resolve();
      this.pending.delete(tab);
    }
    this.render();
  }

  private pump() {
    clearTimeout(this.timer);
    if (this.running || this.freezes) return;
    let next: [DocumentTab, PendingDraft] | undefined;
    for (const entry of this.pending) {
      const { due } = entry[1];
      if (due !== undefined && (!next || due < next[1].due!)) next = entry;
    }
    if (!next) return;
    const [tab, task] = next;
    const delay = task.due! - performance.now();
    if (delay > 0) { this.timer = window.setTimeout(() => this.pump(), delay); return; }
    void this.write(tab, task);
  }

  private async write(tab: DocumentTab, task: PendingDraft) {
    this.running = true;
    task.due = undefined;
    const { revision, folder, completion } = task;
    const current = () => this.pending.get(tab) === task && task.revision === revision;
    try {
      if (!tab.dirty) {
        await host.retireDraft(folder.id, tab.path, revision);
        if (current()) this.pending.delete(tab);
      } else {
        if (tab.model.isDisposed() || !tab.diskVersion) throw new Error("This buffer has no stable disk baseline.");
        await host.writeDraft(folder.id, tab.path, revision, { text: bufferText(tab.model), baseline: tab.disk, version: tab.diskVersion });
        if (current()) { task.saved = true; task.error = undefined; }
      }
    } catch (error) {
      if (current()) {
        if (this.freezes) this.schedule(folder, tab, true);
        else task.error = `Draft not saved for ${tab.path}: ${message(error)}`;
      }
    } finally {
      this.running = false;
      completion?.resolve();
      this.render();
      this.pump();
    }
  }

  private render() {
    const drafts = [...this.pending.values()];
    const error = drafts.find(task => task.error)?.error;
    const text = error ?? (drafts.some(task => task.saved) ? "Draft saved" : "");
    this.indicator.hidden = !text;
    this.indicator.textContent = text;
    this.indicator.title = text;
  }
}

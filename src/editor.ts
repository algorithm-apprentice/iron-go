import * as monaco from "monaco-editor/editor/editor.api.js";
import { caseFold } from "unicode-case-folding";
import "monaco-editor/languages/definitions/go/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/codelens/browser/codelensController.js";
import "monaco-editor/editor/contrib/comment/browser/comment.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/features/find/register.js";
import "./editor-font.css";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import type { DiskObservation, Project, ReadableDisk, SavedEditorSession, SavedEditorTab, VersionedText } from "./workspace";
import { inPath } from "./project-model";

export { monaco };

Object.assign(globalThis, { MonacoEnvironment: { getWorker: () => new EditorWorker() } });

const systemMonospace = '"SF Mono", Menlo, Monaco, Consolas, monospace';
const jetBrainsMono = '"JetBrains Mono"';
export const defaultEditorFontSize = 13;

export function editorTypography(font = "jetbrains", fontSize = defaultEditorFontSize) {
  return {
    fontFamily: font === "system" ? systemMonospace : `${jetBrainsMono}, ${systemMonospace}`,
    fontSize,
    lineHeight: Math.max(18, Math.round(fontSize * 18 / defaultEditorFontSize)),
  };
}

// Monaco can cache the fallback widths while the bundled face is still loading.
void document.fonts.load(`${defaultEditorFontSize}px ${jetBrainsMono}`).then(
  () => monaco.editor.remeasureFonts(),
  () => { /* Keep using the system fallback. */ },
);

export interface DocumentTab {
  path: string;
  model: monaco.editor.ITextModel;
  disk: string;
  diskVersion?: string;
  recovered?: boolean;
  requiresReviewedSave?: boolean;
  clean: string;
  dirty: boolean;
  saving: boolean;
  reloadRevision: number;
  reloading?: number;
  diskChange?: "changed" | "missing" | "unavailable";
  viewState: monaco.editor.ICodeEditorViewState | null;
  sessionView?: SavedEditorTab;
  subscription: monaco.IDisposable;
}

export interface DocumentEvents {
  changed(): void;
  opened(tab: DocumentTab): void;
  closed(tab: DocumentTab): void;
  edited(tab: DocumentTab): void;
  saved(tab: DocumentTab): void;
  fileSettled?(): void;
}

export interface SaveOptions {
  reviewed?: ReadableDisk;
  quitTicket?: number;
  format?: (text: string) => Promise<string>;
}

export const bufferText = (model: monaco.editor.ITextModel) => model.getValue(undefined, true);

const readVersioned = async (folder: Project, path: string): Promise<VersionedText> =>
  folder.readVersioned ? folder.readVersioned(path) : { text: await folder.read(path) };

export function exactModelRange(model: monaco.editor.ITextModel, range: monaco.IRange) {
  const endpoint = (line: number, column: number) => {
    if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || line > model.getLineCount() ||
        column < 1 || column > model.getLineMaxColumn(line)) return false;
    const text = model.getLineContent(line);
    const before = text.charCodeAt(column - 2);
    const after = text.charCodeAt(column - 1);
    return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
  };
  return endpoint(range.startLineNumber, range.startColumn) && endpoint(range.endLineNumber, range.endColumn);
}

export function replaceBuffer(model: monaco.editor.ITextModel, text: string) {
  if (model.getValue() === text) return;
  model.pushStackElement();
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  model.pushStackElement();
}

export type BufferEdit = { range: monaco.IRange; text: string };

export function prepareExactTextEdits(model: monaco.editor.ITextModel, edits: readonly BufferEdit[]) {
  const original = model.getValue();
  const eol = model.getEOL();
  const offsets = edits.map(({ range, text }) => {
    if (!exactModelRange(model, range)) throw new Error("The edit no longer matches the buffer.");
    const start = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
    const end = model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
    if (end < start) throw new Error("The edit has an invalid range.");
    return { range, start, end, text: text.replace(/\r\n|\n|\r/g, eol) };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  let last = 0;
  let previousStart = -1;
  const pieces: string[] = [];
  for (const edit of offsets) {
    if (edit.start < last || edit.start === previousStart) throw new Error("The edits overlap or have ambiguous ordering.");
    pieces.push(original.slice(last, edit.start), edit.text);
    previousStart = edit.start;
    last = edit.end;
  }
  pieces.push(original.slice(last));
  return { original, updated: pieces.join(""), version: model.getVersionId(), operations: offsets.map(({ range, text }) => ({ range, text })) };
}

export function applyPreparedTextEdits(model: monaco.editor.ITextModel, prepared: ReturnType<typeof prepareExactTextEdits>) {
  const { original, updated, version, operations } = prepared;
  if (model.getVersionId() !== version || model.getValue() !== original) throw new Error("The buffer changed before applying the edit.");
  if (updated === original) return false;
  const trimAutoWhitespace = model.getOptions().trimAutoWhitespace;
  model.updateOptions({ trimAutoWhitespace: false });
  try {
    model.pushStackElement();
    model.pushEditOperations([], operations, () => null);
    model.pushStackElement();
  }
  finally { model.updateOptions({ trimAutoWhitespace }); }
  if (model.getValue() !== updated) throw new Error("The editor did not apply the exact text. Use Undo to restore the previous buffer.");
  return true;
}

export function applyExactTextEdits(model: monaco.editor.ITextModel, edits: readonly BufferEdit[]) {
  return applyPreparedTextEdits(model, prepareExactTextEdits(model, edits));
}

type Target = monaco.IRange | monaco.IPosition;

// Be conservative about missing paths, which have no inode to compare. Case
// folding and canonical normalization catch aliases even on macOS volumes
// that would currently allow two distinct names.
const destinationKey = (path: string) => caseFold(path.normalize("NFD"))
  .replace(/\p{Default_Ignorable_Code_Point}/gu, "").normalize("NFD");

export class Documents {
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  readonly tabs = new Map<string, DocumentTab>();
  active: DocumentTab | undefined;
  private folder: Project | undefined;
  private location = 0;
  private edits = 0;
  private opening = new Map<string, Promise<VersionedText>>();
  private applyingDisk?: DocumentTab;
  private reviewingDisk?: DocumentTab;
  private newDestination?: { key: string };
  private pathMutation?: (path: string) => boolean;

  get editRevision() { return this.edits; }

  constructor(private readonly element: HTMLElement, private readonly events: DocumentEvents) {
    this.editor = monaco.editor.create(element, {
      model: null, theme: "vs-dark", automaticLayout: true, editContext: false,
      accessibilitySupport: "off", ariaLabel: "Code editor content",
      ...editorTypography(), fontLigatures: false,
      lineNumbersMinChars: 3, lineDecorationsWidth: 8, padding: { top: 10, bottom: 8 },
      glyphMargin: true,
      renderLineHighlight: "all", scrollBeyondLastLine: false, roundedSelection: false,
      minimap: { enabled: true, renderCharacters: false, showSlider: "mouseover", maxColumn: 75 },
      guides: { bracketPairs: false, indentation: true, highlightActiveIndentation: true },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      overviewRulerBorder: false, bracketPairColorization: { enabled: true },
      wordBasedSuggestions: "off", suggest: { showWords: false },
      stickyScroll: { enabled: false },
    });
    this.bindGutterSelection();
    monaco.editor.registerEditorOpener({
      openCodeEditor: async (_source, uri, selection) => {
        const path = this.relative(uri);
        if (path === undefined) return false;
        return !!await this.open(path, { focus: true, target: selection });
      },
    });
  }

  private bindGutterSelection() {
    const numbers = this.editor.createDecorationsCollection();
    let fromGutter = false;
    const clear = () => {
      fromGutter = false;
      numbers.clear();
      this.element.classList.remove("has-gutter-selection");
    };
    const update = () => {
      const selections = this.editor.getSelections();
      const selection = selections?.[0];
      if (selections?.length !== 1 || !selection || selection.isEmpty()) { clear(); return; }
      // The forward caret may sit at column 1 of the following row; the
      // newline belongs to the selection, but that following row does not.
      const end = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
        ? selection.endLineNumber - 1 : selection.endLineNumber;
      numbers.set([{
        range: new monaco.Range(selection.startLineNumber, 1, end, 1),
        options: { lineNumberClassName: "gutter-selected-number" },
      }]);
      this.element.classList.add("has-gutter-selection");
    };
    // Monaco has already performed its normal whole-line selection when it
    // emits this event. Only change the gutter decoration, not the selection.
    this.editor.onMouseDown(event => {
      if (event.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS && event.event.leftButton && !event.event.ctrlKey) {
        fromGutter = true;
        update();
      } else if (fromGutter) clear();
    });
    this.editor.onDidChangeCursorSelection(event => {
      if (!fromGutter) return;
      if (event.source === "mouse") update(); else clear();
    });
    this.editor.onDidChangeModel(clear);
  }

  layout() {
    const width = this.element.clientWidth;
    const height = this.element.clientHeight;
    const previous = this.editor.getLayoutInfo();
    if (width > 0 && height > 0 && (width !== previous.width || height !== previous.height)) {
      this.editor.layout({ width, height });
    }
  }

  refreshView() {
    this.layout();
    this.editor.render(true);
  }

  reset(folder: Project) {
    this.location++;
    this.opening.clear();
    this.newDestination = undefined;
    this.pathMutation = undefined;
    this.editor.setModel(null);
    this.active = undefined;
    for (const tab of this.tabs.values()) this.remove(tab);
    this.tabs.clear();
    this.folder = folder;
    this.events.changed();
  }

  relative(uri: monaco.Uri) {
    const root = this.folder?.native?.path;
    if (!root || uri.scheme !== "file" || uri.authority) return undefined;
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return uri.path.startsWith(prefix) ? uri.path.slice(prefix.length) || undefined : undefined;
  }

  async open(path: string, options: { focus?: boolean; activate?: boolean; target?: Target; current?: () => boolean;
    userNavigation?: boolean; observedDisk?: ReadableDisk; validate?: (tab: DocumentTab) => void; beforeActivate?: () => void } = {}) {
    const folder = this.folder;
    const { focus = false, activate = true, target, current = () => true } = options;
    if (!folder || !current() || this.destinationReserved(path)) return;
    // A speculative Debug lookup must never invalidate a user's pending
    // navigation, even when the two callers share the same disk read.
    const location = activate && (!options.current || options.userNavigation) ? ++this.location : this.location;
    let tab = this.tabs.get(path);
    if (!tab) {
      let pending = this.opening.get(path);
      if (!pending) {
        const read = options.observedDisk === undefined ? readVersioned(folder, path) : Promise.resolve(options.observedDisk);
        const load = read.finally(() => { if (this.opening.get(path) === load) this.opening.delete(path); });
        this.opening.set(path, load);
        pending = load;
      }
      try {
        const disk = await pending;
        if (folder !== this.folder || !current() || this.destinationReserved(path)) return;
        tab = this.tabs.get(path);
        if (!tab) {
          const created = this.makeTab(folder, path, disk.text, disk.text);
          created.diskVersion = disk.version;
          try { options.validate?.(created); }
          catch (error) {
            created.subscription.dispose();
            created.model.dispose();
            throw error;
          }
          this.tabs.set(path, created);
          this.events.opened(created);
          this.events.changed();
          tab = created;
        }
      } catch (error) { if (folder === this.folder && current()) throw error; }
    }
    if (!tab || folder !== this.folder || !current()) return;
    if (activate && location === this.location) {
      options.validate?.(tab);
      options.beforeActivate?.();
      this.activate(tab, focus, target);
    }
    return tab;
  }

  private destinationReserved(path: string) {
    return this.pathMutation?.(path) || (this.newDestination !== undefined && this.newDestination.key === destinationKey(path));
  }

  reservePaths(source: string, destination?: string) {
    if (this.pathMutation || this.saving) throw new Error("Wait for the current file operation before changing workspace paths.");
    const sourceKey = destinationKey(source);
    const targetKey = destination && destinationKey(destination);
    const reserved = (path: string) => inPath(destinationKey(path), sourceKey) || !!(targetKey && inPath(destinationKey(path), targetKey));
    if ([...this.opening.keys()].some(reserved)) throw new Error("A file is still opening at an affected path. Try again when it settles.");
    const affected = [...this.tabs.values()].filter(tab => inPath(tab.path, source));
    if ([...this.tabs.values()].some(tab => reserved(tab.path) && !affected.includes(tab))) {
      throw new Error("A different editor already owns an affected destination or alias. Close it before moving the item.");
    }
    this.pathMutation = reserved;
    return { affected, release: () => { if (this.pathMutation === reserved) this.pathMutation = undefined; } };
  }

  rebindPaths(source: string, destination: string, versions: Readonly<Record<string, string>>, affected: DocumentTab[]) {
    const folder = this.folder;
    if (!folder) return [];
    const previous = [...this.tabs.values()];
    const selected = this.active;
    const activeView = selected && this.editor.saveViewState();
    const activeSaved = selected && this.readView(selected.path);
    const moved = new Map<DocumentTab, DocumentTab>();
    this.location++;
    for (const old of affected) {
      const path = `${destination}${old.path.slice(source.length)}`;
      const text = bufferText(old.model);
      const view = old === selected ? activeView : old.viewState;
      const saved = old === selected ? activeSaved : old.sessionView;
      this.remove(old);
      const next = this.makeTab(folder, path, text, old.disk, old.clean);
      next.dirty = old.dirty;
      next.viewState = view ?? null;
      if (saved) next.sessionView = { ...saved, path };
      const version = Object.hasOwn(versions, path) ? versions[path] : undefined;
      next.diskVersion = version ?? old.diskVersion;
      next.recovered = old.recovered;
      next.requiresReviewedSave = old.requiresReviewedSave || !version;
      next.diskChange = next.requiresReviewedSave ? "changed" : old.diskChange;
      moved.set(old, next);
    }
    this.tabs.clear();
    for (const old of previous) {
      const tab = moved.get(old) ?? old;
      this.tabs.set(tab.path, tab);
    }
    for (const tab of moved.values()) this.events.opened(tab);
    if (selected && moved.has(selected)) {
      this.active = undefined;
      this.activate(moved.get(selected)!, false);
    } else this.events.changed();
    return [...moved.values()];
  }

  requirePathReview(affected: DocumentTab[]) {
    for (const tab of affected) {
      tab.requiresReviewedSave = true;
      tab.diskChange = "changed";
      tab.reloadRevision++;
    }
    this.events.changed();
  }

  recover(path: string, text: string, baseline: ReadableDisk, observed: Exclude<DiskObservation, { kind: "retry" }>) {
    const folder = this.folder;
    const existing = this.tabs.get(path);
    if (!folder || existing?.dirty || existing?.saving || existing?.reloading !== undefined || this.opening.has(path) || this.destinationReserved(path)) {
      throw new Error("This file has a live or pending edit. Keep the existing buffer and recover the draft separately.");
    }
    const tab = existing ?? this.makeTab(folder, path, text, baseline.text, baseline.text);
    this.applyingDisk = tab;
    try { if (existing) tab.model.setValue(text); }
    finally { this.applyingDisk = undefined; }
    tab.disk = baseline.text;
    tab.clean = baseline.text;
    tab.diskVersion = baseline.version;
    tab.recovered = true;
    tab.dirty = true;
    tab.diskChange = observed.kind !== "text" ? observed.kind :
      observed.text !== baseline.text || observed.version !== baseline.version ? "changed" : undefined;
    if (!existing) { this.tabs.set(path, tab); this.events.opened(tab); }
    this.activate(tab, true);
    this.events.edited(tab);
    this.events.changed();
  }

  private makeTab(folder: Project, path: string, text: string, disk: string, saved?: string): DocumentTab {
    const root = folder.native?.path;
    const uri = root ? monaco.Uri.file(`${root.replace(/\/$/, "")}/${path}`) : monaco.Uri.from({ scheme: "irongo-preview", path: `/${path}` });
    const language = path.endsWith(".go") ? "go" : path.endsWith(".md") ? "markdown" : "plaintext";
    const model = monaco.editor.createModel(text, language, uri);
    model.updateOptions({ insertSpaces: language !== "go", tabSize: 4, indentSize: 4, trimAutoWhitespace: true });
    const current = bufferText(model);
    const clean = saved ?? current;
    const tab: DocumentTab = {
      path, model, disk, clean, dirty: current !== clean, saving: false, reloadRevision: 0, viewState: null,
      subscription: model.onDidChangeContent(() => {
        this.edits++;
        if (this.applyingDisk === tab) return;
        const dirty = bufferText(model) !== tab.clean;
        if (dirty !== tab.dirty) {
          tab.dirty = dirty;
          this.events.changed();
        }
        this.events.edited(tab);
      }),
    };
    return tab;
  }

  async saveToNew(tab: DocumentTab, path: string) {
    const folder = this.folder;
    if (!folder?.createFromBuffer || !this.isLive(folder, tab) || this.newDestination || tab.saving || tab.reloading !== undefined) return;
    const key = destinationKey(path);
    if ([...this.tabs.keys(), ...this.opening.keys()].some(existing => destinationKey(existing) === key)) {
      throw new Error("This path matches an open or opening tab. Choose a different path.");
    }
    const destination = this.newDestination = { key };
    const submitted = bufferText(tab.model);
    tab.reloadRevision++;
    tab.saving = true;
    this.events.changed();
    try {
      const saved = await folder.createFromBuffer(path, submitted);
      const actualPath = typeof saved === "string" ? saved : saved.path;
      if (!this.isLive(folder, tab)) return;
      const rebound = this.makeTab(folder, actualPath, bufferText(tab.model), submitted, submitted);
      if (typeof saved !== "string") rebound.diskVersion = saved.version ?? undefined;
      const wasActive = this.active === tab;
      const sessionView = wasActive ? this.readView(actualPath) : tab.sessionView;
      if (sessionView) rebound.sessionView = { ...sessionView, path: actualPath };
      rebound.viewState = wasActive ? this.editor.saveViewState() : tab.viewState;
      const order = [...this.tabs.values()];
      this.tabs.clear();
      for (const existing of order) {
        const current = existing === tab ? rebound : existing;
        this.tabs.set(current.path, current);
      }
      if (wasActive) {
        this.active = undefined;
        this.activate(rebound, false);
      }
      this.remove(tab);
      this.events.opened(rebound);
      this.events.changed();
      return rebound;
    } finally {
      if (this.newDestination === destination) this.newDestination = undefined;
      tab.saving = false;
      if (this.isLive(folder, tab)) this.events.changed();
    }
  }

  private activate(tab: DocumentTab, focus: boolean, target?: Target) {
    if (this.active !== tab) {
      if (this.active) {
        this.active.viewState = this.editor.saveViewState();
        this.active.sessionView = this.readView(this.active.path);
      }
      this.active = tab;
      this.editor.setModel(tab.model);
      if (tab.viewState) this.editor.restoreViewState(tab.viewState);
      else if (tab.sessionView) {
        const { line, column, firstLine } = tab.sessionView;
        this.editor.setPosition(tab.model.validatePosition({ lineNumber: line, column }));
        this.layout();
        this.editor.setScrollTop(this.editor.getTopForLineNumber(Math.min(tab.model.getLineCount(), firstLine)), monaco.editor.ScrollType.Immediate);
      }
      this.events.changed();
      this.refreshView();
    }
    if (target) {
      if (monaco.Range.isIRange(target)) {
        this.editor.setSelection(target);
        this.editor.revealRangeInCenterIfOutsideViewport(target);
      } else {
        this.editor.setPosition(target);
        this.editor.revealPositionInCenterIfOutsideViewport(target);
      }
    }
    if (focus) this.editor.focus();
  }

  private readView(path: string): SavedEditorTab {
    const position = this.editor.getPosition();
    return { path, line: position?.lineNumber ?? 1, column: position?.column ?? 1,
      firstLine: this.editor.getVisibleRanges()[0]?.startLineNumber ?? 1 };
  }

  captureSession(): SavedEditorSession {
    const encoder = new TextEncoder();
    const eligible = [...this.tabs.values()].filter(tab => encoder.encode(tab.path).length <= 1024);
    const active = this.active && eligible.includes(this.active) ? this.active : undefined;
    const selected = eligible.slice(0, 32);
    if (active && !selected.includes(active)) selected.splice(31, 1, active);
    const tabs = selected.map(tab => tab === active ? this.readView(tab.path) :
      (tab.sessionView ?? { path: tab.path, line: 1, column: 1, firstLine: 1 }));
    return { tabs, active: active?.path };
  }

  async restoreSession(session: SavedEditorSession, indexed: Set<string>, current: () => boolean) {
    let skipped = 0;
    for (const view of session.tabs) {
      if (!current()) return { opened: false, skipped };
      if (!indexed.has(view.path)) { skipped++; continue; }
      const tab = await this.open(view.path, { activate: false, current }).catch(() => undefined);
      if (!current()) return { opened: false, skipped };
      if (tab) tab.sessionView = view;
      else skipped++;
    }
    const active = (session.active && this.tabs.get(session.active)) || this.tabs.values().next().value;
    if (active && current()) this.activate(active, false);
    return { opened: !!active, skipped };
  }

  cycle(direction: 1 | -1) {
    if (!this.active || this.tabs.size < 2) return false;
    const tabs = [...this.tabs.values()];
    const index = tabs.indexOf(this.active);
    if (index < 0) return false;
    this.location++;
    this.activate(tabs[(index + direction + tabs.length) % tabs.length], true);
    return true;
  }

  private remove(tab: DocumentTab) {
    this.events.closed(tab);
    tab.subscription.dispose();
    tab.model.dispose();
  }

  close(tab: DocumentTab, { focus = true, preserveNavigation = false } = {}) {
    if (!preserveNavigation) this.location++;
    const paths = [...this.tabs.keys()];
    const index = paths.indexOf(tab.path);
    const next = this.tabs.get(paths[index + 1] ?? paths[index - 1]);
    if (tab === this.active) {
      this.active = undefined;
      this.editor.setModel(null);
    }
    this.tabs.delete(tab.path);
    this.remove(tab);
    if (!this.active && next) this.activate(next, focus);
    this.events.changed();
  }

  private isLive(folder: Project, tab: DocumentTab) {
    return this.folder === folder && this.tabs.get(tab.path) === tab && !tab.model.isDisposed();
  }

  async save(tab: DocumentTab, options: SaveOptions = {}) {
    const folder = this.folder;
    if (!folder || !this.isLive(folder, tab) || !tab.dirty || tab.saving) return false;
    if (tab.requiresReviewedSave && !options.reviewed) throw new Error("Review the current disk version or use Save to a New Path before saving this buffer.");
    const submitted = bufferText(tab.model);
    const version = tab.model.getVersionId();
    const expected = options.reviewed?.text ?? tab.disk;
    const expectedVersion = options.reviewed?.version ?? (tab.recovered ? tab.diskVersion : undefined);
    const eol = tab.model.getEOL();
    const bom = submitted.startsWith("\ufeff") ? "\ufeff" : "";
    tab.reloadRevision++;
    tab.saving = true;
    this.events.changed();
    try {
      let text = submitted;
      if (options.format) {
        const formatted = await options.format(submitted.slice(bom.length));
        if (!this.isLive(folder, tab)) return false;
        text = bom + formatted.replace(/^\ufeff/, "").replace(/\r\n|\n|\r/g, eol);
      }
      const writtenVersion = await folder.save(tab.path, expected, text, expectedVersion, options.quitTicket);
      if (!this.isLive(folder, tab)) return false;
      tab.disk = text;
      tab.diskVersion = writtenVersion ?? undefined;
      tab.recovered = undefined;
      tab.requiresReviewedSave = undefined;
      tab.clean = text;
      if (text !== submitted && tab.model.getVersionId() === version) {
        const view = this.active === tab ? this.editor.saveViewState() : null;
        this.applyingDisk = tab;
        try { applyExactTextEdits(tab.model, [{ range: tab.model.getFullModelRange(), text: text.slice(bom.length) }]); }
        finally { this.applyingDisk = undefined; }
        if (view) this.editor.restoreViewState(view);
      }
      tab.dirty = bufferText(tab.model) !== text;
      tab.diskChange = undefined;
      this.events.saved(tab);
      return true;
    } catch (error) {
      if (!this.isLive(folder, tab)) return false;
      throw error;
    } finally {
      tab.saving = false;
      if (this.isLive(folder, tab)) {
        this.events.changed();
        this.events.fileSettled?.();
      }
    }
  }

  private async applyFileResult<T>(tab: DocumentTab, folder: Project, read: () => Promise<T>, apply: (value: T) => void,
    current = () => true, beforeApply?: () => Promise<void>) {
    const version = tab.model.getVersionId();
    const applicable = () => this.isLive(folder, tab) && version === tab.model.getVersionId() && current();
    let text: T;
    try { text = await read(); }
    catch (error) {
      if (!applicable()) return false;
      throw error;
    }
    if (!applicable()) return false;
    if (beforeApply) await beforeApply();
    if (!applicable()) return false;
    apply(text);
    return true;
  }

  async reload(tab: DocumentTab, reviewed?: ReadableDisk, beforeApply?: () => Promise<void>) {
    const folder = this.folder;
    if (!folder || !this.isLive(folder, tab) || tab.saving) return false;
    const revision = ++tab.reloadRevision;
    tab.reloading = revision;
    try {
      return await this.applyFileResult(tab, folder, async () => {
        if (!reviewed) return readVersioned(folder, tab.path);
        const observed = await folder.inspect?.(tab.path);
        if (observed?.kind !== "text" || observed.version !== reviewed.version || observed.text !== reviewed.text) {
          throw new Error("The reviewed disk version changed. Compare again before reloading.");
        }
        return observed;
      }, disk => {
        this.adoptDisk(tab, disk, false);
      }, () => revision === tab.reloadRevision, beforeApply);
    } finally {
      if (tab.reloading === revision) tab.reloading = undefined;
      if (this.isLive(folder, tab)) this.events.fileSettled?.();
    }
  }

  holdDiskReview(tab: DocumentTab) {
    tab.reloadRevision++;
    this.reviewingDisk = tab;
    return () => { if (this.reviewingDisk === tab) this.reviewingDisk = undefined; };
  }

  async reconcile(tab: DocumentTab) {
    const folder = this.folder;
    if (!folder?.inspect || !this.isLive(folder, tab) || this.reviewingDisk === tab || this.pathMutation?.(tab.path) || tab.saving || tab.reloading !== undefined) return true;
    const version = tab.model.getVersionId();
    const revision = tab.reloadRevision;
    const observed = await folder.inspect(tab.path);
    if (!this.isLive(folder, tab) || this.reviewingDisk === tab || this.pathMutation?.(tab.path)) return true;
    if (version !== tab.model.getVersionId() || revision !== tab.reloadRevision || observed.kind === "retry") return false;

    let change: DocumentTab["diskChange"];
    if (observed.kind === "text") {
      if (tab.requiresReviewedSave || observed.text !== tab.disk || (tab.recovered && observed.version !== tab.diskVersion)) {
        if (!tab.dirty) {
          this.adoptDisk(tab, observed, true);
          return true;
        }
        change = "changed";
      } else if (!tab.dirty) tab.diskVersion = observed.version;
    } else { change = observed.kind; }
    if (tab.diskChange !== change) {
      tab.diskChange = change;
      this.events.changed();
    }
    return true;
  }

  private adoptDisk(tab: DocumentTab, { text: disk, version }: VersionedText, automatic: boolean) {
    const view = automatic && this.active === tab ? this.editor.saveViewState() : null;
    const bom = disk.startsWith("\ufeff");
    const sameConvention = bom === tab.clean.startsWith("\ufeff") &&
      (disk.match(/\r\n|\r|\n/g) ?? []).every(ending => ending === tab.model.getEOL());
    this.applyingDisk = tab;
    try {
      if (automatic && sameConvention) replaceBuffer(tab.model, bom ? disk.slice(1) : disk);
      else tab.model.setValue(disk);
      tab.disk = disk;
      tab.diskVersion = version;
      tab.recovered = undefined;
      tab.requiresReviewedSave = undefined;
      tab.clean = bufferText(tab.model);
      tab.dirty = false;
      tab.diskChange = undefined;
    } finally { this.applyingDisk = undefined; }
    if (view) this.editor.restoreViewState(view);
    this.events.changed();
    this.events.saved(tab);
  }

  async format(tab: DocumentTab, format: (text: string) => Promise<string>) {
    const folder = this.folder;
    if (!folder || !this.isLive(folder, tab)) return false;
    return this.applyFileResult(tab, folder, () => format(tab.model.getValue()), text => replaceBuffer(tab.model, text));
  }

  get dirty() { return [...this.tabs.values()].some(tab => tab.dirty); }
  get saving() { return [...this.tabs.values()].some(tab => tab.saving); }
}

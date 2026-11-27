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
import type { Project, ReadableDisk } from "./workspace";

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
  clean: string;
  dirty: boolean;
  saving: boolean;
  reloadRevision: number;
  reloading?: number;
  diskChange?: "changed" | "missing" | "unavailable";
  viewState: monaco.editor.ICodeEditorViewState | null;
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

export const bufferText = (model: monaco.editor.ITextModel) => model.getValue(undefined, true);

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
  private opening = new Map<string, Promise<string>>();
  private applyingDisk?: DocumentTab;
  private reviewingDisk?: DocumentTab;
  private newDestination?: { key: string };

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
    userNavigation?: boolean; validate?: (tab: DocumentTab) => void; beforeActivate?: () => void } = {}) {
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
        const load = folder.read(path).finally(() => { if (this.opening.get(path) === load) this.opening.delete(path); });
        this.opening.set(path, load);
        pending = load;
      }
      try {
        const disk = await pending;
        if (folder !== this.folder || !current() || this.destinationReserved(path)) return;
        tab = this.tabs.get(path);
        if (!tab) {
          const created = this.makeTab(folder, path, disk, disk);
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
    return this.newDestination !== undefined && this.newDestination.key === destinationKey(path);
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
      const actualPath = await folder.createFromBuffer(path, submitted);
      if (!this.isLive(folder, tab)) return;
      const rebound = this.makeTab(folder, actualPath, bufferText(tab.model), submitted, submitted);
      const wasActive = this.active === tab;
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
      if (this.active) this.active.viewState = this.editor.saveViewState();
      this.active = tab;
      this.editor.setModel(tab.model);
      if (tab.viewState) this.editor.restoreViewState(tab.viewState);
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

  async save(tab: DocumentTab, options: { reviewed?: ReadableDisk; quitTicket?: number } = {}) {
    const folder = this.folder;
    if (!folder || !this.isLive(folder, tab) || !tab.dirty || tab.saving) return false;
    const text = bufferText(tab.model);
    tab.reloadRevision++;
    tab.saving = true;
    this.events.changed();
    try {
      await folder.save(tab.path, options.reviewed?.text ?? tab.disk, text, options.reviewed?.version, options.quitTicket);
      if (!this.isLive(folder, tab)) return false;
      tab.disk = text;
      tab.clean = text;
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

  private async applyFileResult(tab: DocumentTab, folder: Project, read: () => Promise<string>, apply: (text: string) => void, current = () => true) {
    const version = tab.model.getVersionId();
    const applicable = () => this.isLive(folder, tab) && version === tab.model.getVersionId() && current();
    let text: string;
    try { text = await read(); }
    catch (error) {
      if (!applicable()) return false;
      throw error;
    }
    if (!applicable()) return false;
    apply(text);
    return true;
  }

  async reload(tab: DocumentTab, reviewed?: ReadableDisk) {
    const folder = this.folder;
    if (!folder || !this.isLive(folder, tab) || tab.saving) return false;
    const revision = ++tab.reloadRevision;
    tab.reloading = revision;
    try {
      return await this.applyFileResult(tab, folder, async () => {
        if (!reviewed) return folder.read(tab.path);
        const observed = await folder.inspect?.(tab.path);
        if (observed?.kind !== "text" || observed.version !== reviewed.version || observed.text !== reviewed.text) {
          throw new Error("The reviewed disk version changed. Compare again before reloading.");
        }
        return observed.text;
      }, disk => {
        this.adoptDisk(tab, disk, false);
      }, () => revision === tab.reloadRevision);
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
    if (!folder?.inspect || !this.isLive(folder, tab) || this.reviewingDisk === tab || tab.saving || tab.reloading !== undefined) return true;
    const version = tab.model.getVersionId();
    const revision = tab.reloadRevision;
    const observed = await folder.inspect(tab.path);
    if (!this.isLive(folder, tab) || this.reviewingDisk === tab) return true;
    if (version !== tab.model.getVersionId() || revision !== tab.reloadRevision || observed.kind === "retry") return false;

    let change: DocumentTab["diskChange"];
    if (observed.kind === "text") {
      if (observed.text !== tab.disk) {
        if (!tab.dirty) {
          this.adoptDisk(tab, observed.text, true);
          return true;
        }
        change = "changed";
      }
    } else { change = observed.kind; }
    if (tab.diskChange !== change) {
      tab.diskChange = change;
      this.events.changed();
    }
    return true;
  }

  private adoptDisk(tab: DocumentTab, disk: string, automatic: boolean) {
    const view = automatic && this.active === tab ? this.editor.saveViewState() : null;
    const bom = disk.startsWith("\ufeff");
    const sameConvention = bom === tab.clean.startsWith("\ufeff") &&
      (disk.match(/\r\n|\r|\n/g) ?? []).every(ending => ending === tab.model.getEOL());
    this.applyingDisk = tab;
    try {
      if (automatic && sameConvention) replaceBuffer(tab.model, bom ? disk.slice(1) : disk);
      else tab.model.setValue(disk);
      tab.disk = disk;
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

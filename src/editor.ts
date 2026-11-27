import * as monaco from "monaco-editor/editor/editor.api.js";
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
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import type { Project } from "./workspace";

export { monaco };

Object.assign(globalThis, { MonacoEnvironment: { getWorker: () => new EditorWorker() } });

export interface DocumentTab {
  path: string;
  model: monaco.editor.ITextModel;
  disk: string;
  clean: string;
  dirty: boolean;
  saving: boolean;
  reloadRevision: number;
  viewState: monaco.editor.ICodeEditorViewState | null;
  subscription: monaco.IDisposable;
}

export interface DocumentEvents {
  changed(): void;
  opened(tab: DocumentTab): void;
  closed(tab: DocumentTab): void;
  edited(tab: DocumentTab): void;
  saved(tab: DocumentTab): void;
}

export const bufferText = (model: monaco.editor.ITextModel) => model.getValue(undefined, true);

export function replaceBuffer(model: monaco.editor.ITextModel, text: string) {
  if (model.getValue() === text) return;
  model.pushStackElement();
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  model.pushStackElement();
}

type Target = monaco.IRange | monaco.IPosition;

export class Documents {
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  readonly tabs = new Map<string, DocumentTab>();
  active: DocumentTab | undefined;
  private folder: Project | undefined;
  private location = 0;
  private edits = 0;
  private opening = new Map<string, Promise<string>>();

  get editRevision() { return this.edits; }

  constructor(private readonly element: HTMLElement, private readonly events: DocumentEvents) {
    this.editor = monaco.editor.create(element, {
      model: null, theme: "vs-dark", automaticLayout: true, editContext: false,
      accessibilitySupport: "off", ariaLabel: "Code editor content", fontSize: 13,
      fontFamily: '"SF Mono", Menlo, Monaco, Consolas, monospace', fontLigatures: false,
      lineHeight: 22, lineNumbersMinChars: 4, padding: { top: 10, bottom: 8 },
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

  async open(path: string, options: { focus?: boolean; activate?: boolean; target?: Target; current?: () => boolean } = {}) {
    const folder = this.folder;
    const { focus = false, activate = true, target, current = () => true } = options;
    if (!folder || !current()) return;
    // A speculative Debug lookup must never invalidate a user's pending
    // navigation, even when the two callers share the same disk read.
    const location = activate && !options.current ? ++this.location : this.location;
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
        if (folder !== this.folder || !current()) return;
        tab = this.tabs.get(path);
        if (!tab) {
          const root = folder.native?.path;
          const uri = root ? monaco.Uri.file(`${root.replace(/\/$/, "")}/${path}`) : monaco.Uri.from({ scheme: "irongo-preview", path: `/${path}` });
          const language = path.endsWith(".go") ? "go" : path.endsWith(".md") ? "markdown" : "plaintext";
          const model = monaco.editor.createModel(disk, language, uri);
          model.updateOptions({ insertSpaces: language !== "go", tabSize: 4, indentSize: 4, trimAutoWhitespace: true });
          const created: DocumentTab = {
             path, model, disk, clean: bufferText(model), dirty: false, saving: false, reloadRevision: 0, viewState: null,
             subscription: model.onDidChangeContent(() => {
              this.edits++;
              const dirty = bufferText(model) !== created.clean;
              if (dirty !== created.dirty) {
                created.dirty = dirty;
                this.events.changed();
              }
              this.events.edited(created);
            }),
          };
          this.tabs.set(path, created);
          this.events.opened(created);
          this.events.changed();
          tab = created;
        }
      } catch (error) { if (folder === this.folder && current()) throw error; }
    }
    if (!tab || folder !== this.folder || !current()) return;
    if (activate && location === this.location) this.activate(tab, focus, target);
    return tab;
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

  private remove(tab: DocumentTab) {
    this.events.closed(tab);
    tab.subscription.dispose();
    tab.model.dispose();
  }

  close(tab: DocumentTab) {
    this.location++;
    const paths = [...this.tabs.keys()];
    const index = paths.indexOf(tab.path);
    const next = this.tabs.get(paths[index + 1] ?? paths[index - 1]);
    if (tab === this.active) {
      this.active = undefined;
      this.editor.setModel(null);
    }
    this.tabs.delete(tab.path);
    this.remove(tab);
    if (!this.active && next) this.activate(next, true);
    this.events.changed();
  }

  private isLive(folder: Project, tab: DocumentTab) {
    return this.folder === folder && this.tabs.get(tab.path) === tab && !tab.model.isDisposed();
  }

  async save(tab: DocumentTab) {
    const folder = this.folder;
    if (!folder || !this.isLive(folder, tab) || !tab.dirty || tab.saving) return false;
    const text = bufferText(tab.model);
    tab.reloadRevision++;
    tab.saving = true;
    this.events.changed();
    try {
      await folder.save(tab.path, tab.disk, text);
      if (!this.isLive(folder, tab)) return false;
      tab.disk = text;
      tab.clean = text;
      tab.dirty = bufferText(tab.model) !== text;
      this.events.saved(tab);
      return true;
    } catch (error) {
      if (!this.isLive(folder, tab)) return false;
      throw error;
    } finally {
      tab.saving = false;
      if (this.isLive(folder, tab)) this.events.changed();
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

  async reload(tab: DocumentTab) {
    const folder = this.folder;
    if (!folder || !this.isLive(folder, tab) || tab.saving) return false;
    const revision = ++tab.reloadRevision;
    return this.applyFileResult(tab, folder, () => folder.read(tab.path), disk => {
      tab.model.setValue(disk);
      tab.disk = disk;
      tab.clean = bufferText(tab.model);
      tab.dirty = false;
      this.events.changed();
      this.events.saved(tab);
    }, () => revision === tab.reloadRevision);
  }

  async format(tab: DocumentTab, format: (text: string) => Promise<string>) {
    const folder = this.folder;
    if (!folder || !this.isLive(folder, tab)) return false;
    return this.applyFileResult(tab, folder, () => format(tab.model.getValue()), text => replaceBuffer(tab.model, text));
  }

  get dirty() { return [...this.tabs.values()].some(tab => tab.dirty); }
  get saving() { return [...this.tabs.values()].some(tab => tab.saving); }
}

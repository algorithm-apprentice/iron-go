import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/languages/definitions/go/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
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

monaco.editor.defineTheme("iron-night", {
  base: "vs-dark", inherit: true,
  rules: [
    { token: "keyword", foreground: "C79AF1" },
    { token: "keyword.package.go", foreground: "8AB8FF" },
    { token: "keyword.import.go", foreground: "8AB8FF" },
    { token: "keyword.func.go", foreground: "C4A5F0" },
    { token: "keyword.nil.go", foreground: "F1AFB8" },
    { token: "keyword.false.go", foreground: "F1AFB8" },
    { token: "string", foreground: "A8D9A5" },
    { token: "number", foreground: "EDC995" },
    { token: "comment", foreground: "7B90A6", fontStyle: "italic" },
    { token: "delimiter", foreground: "A2B0C4" },
    { token: "identifier.go", foreground: "D5E4F6" },
  ],
  colors: {
    "editor.background": "#13171E", "editor.foreground": "#D3DFEC",
    "editorGutter.background": "#13171E", "editorLineNumber.foreground": "#65768C",
    "editorLineNumber.activeForeground": "#B9D2E4", "editorCursor.foreground": "#86E9CB",
    "editor.lineHighlightBackground": "#1B242F", "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#315A62", "editor.inactiveSelectionBackground": "#263B4C",
    "editorIndentGuide.background1": "#2A3442", "editorIndentGuide.activeBackground1": "#425C67",
    "editorWidget.background": "#202834", "editorWidget.border": "#48586E",
    "editorSuggestWidget.selectedBackground": "#2D454C", "editorSuggestWidget.highlightForeground": "#86E9CB",
    "editorWhitespace.foreground": "#314052", "editorBracketMatch.background": "#254044",
    "editorBracketMatch.border": "#438876", "minimap.background": "#13171E",
    "scrollbarSlider.background": "#60748D3A", "scrollbarSlider.hoverBackground": "#60748D60",
    "scrollbarSlider.activeBackground": "#60748D84",
  },
});

export interface DocumentTab {
  path: string;
  model: monaco.editor.ITextModel;
  disk: string;
  clean: string;
  dirty: boolean;
  saving: boolean;
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
  private opening = new Map<string, Promise<DocumentTab | undefined>>();

  constructor(element: HTMLElement, private readonly events: DocumentEvents) {
    this.editor = monaco.editor.create(element, {
      model: null, theme: "iron-night", automaticLayout: true, editContext: false,
      accessibilitySupport: "off", ariaLabel: "Code editor content", fontSize: 13,
      fontFamily: '"SF Mono", Menlo, Monaco, Consolas, monospace', fontLigatures: false,
      lineHeight: 22, lineNumbersMinChars: 4, padding: { top: 10, bottom: 8 },
      renderLineHighlight: "all", scrollBeyondLastLine: false, roundedSelection: false,
      minimap: { enabled: true, renderCharacters: false, showSlider: "mouseover", maxColumn: 75 },
      guides: { bracketPairs: false, indentation: true, highlightActiveIndentation: true },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      overviewRulerBorder: false, bracketPairColorization: { enabled: true },
      wordBasedSuggestions: "off", suggest: { showWords: false },
      stickyScroll: { enabled: false },
    });
    monaco.editor.registerEditorOpener({
      openCodeEditor: async (_source, uri, selection) => {
        const path = this.relative(uri);
        if (path === undefined) return false;
        return !!await this.open(path, { focus: true, target: selection });
      },
    });
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

  async open(path: string, options: { focus?: boolean; activate?: boolean; target?: Target } = {}) {
    const folder = this.folder;
    if (!folder) return;
    const { focus = false, activate = true, target } = options;
    const location = activate ? ++this.location : this.location;
    let tab = this.tabs.get(path);
    if (!tab) {
      let pending = this.opening.get(path);
      if (!pending) {
        const load = folder.read(path).then(disk => {
          if (folder !== this.folder) return;
          const root = folder.native?.path;
          const uri = root ? monaco.Uri.file(`${root.replace(/\/$/, "")}/${path}`) : monaco.Uri.from({ scheme: "irongo-preview", path: `/${path}` });
          const language = path.endsWith(".go") ? "go" : path.endsWith(".md") ? "markdown" : "plaintext";
          const model = monaco.editor.createModel(disk, language, uri);
          model.updateOptions({ insertSpaces: language !== "go", tabSize: 4, indentSize: 4, trimAutoWhitespace: true });
          const created: DocumentTab = {
            path, model, disk, clean: bufferText(model), dirty: false, saving: false, viewState: null,
            subscription: model.onDidChangeContent(() => {
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
          return created;
        }).finally(() => { if (this.opening.get(path) === load) this.opening.delete(path); });
        this.opening.set(path, load);
        pending = load;
      }
      try { tab = await pending; }
      catch (error) { if (folder === this.folder) throw error; }
    }
    if (!tab || folder !== this.folder) return;
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

  async save(tab: DocumentTab) {
    const folder = this.folder;
    if (!folder || !tab.dirty || tab.saving) return false;
    const text = bufferText(tab.model);
    tab.saving = true;
    this.events.changed();
    try {
      await folder.save(tab.path, tab.disk, text);
      if (this.folder !== folder || tab.model.isDisposed()) return false;
      tab.disk = text;
      tab.clean = text;
      tab.dirty = bufferText(tab.model) !== text;
      this.events.saved(tab);
      return true;
    } finally {
      tab.saving = false;
      this.events.changed();
    }
  }

  async reload(tab: DocumentTab) {
    const version = tab.model.getVersionId();
    const disk = await this.folder?.read(tab.path);
    if (disk === undefined || tab.model.isDisposed() || version !== tab.model.getVersionId()) return false;
    tab.model.setValue(disk);
    tab.disk = disk;
    tab.clean = bufferText(tab.model);
    tab.dirty = false;
    this.events.changed();
    this.events.saved(tab);
    return true;
  }

  get dirty() { return [...this.tabs.values()].some(tab => tab.dirty); }
  get saving() { return [...this.tabs.values()].some(tab => tab.saving); }
}

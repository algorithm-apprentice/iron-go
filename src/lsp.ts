import { AbstractMessageReader, AbstractMessageWriter, CancellationToken, CancellationTokenSource, createMessageConnection, type DataCallback, type Message, type MessageConnection } from "vscode-jsonrpc/lib/browser/main.js";
import { SymbolKind, type CodeAction, type Command, type CompletionItem, type CompletionList, type Diagnostic, type DocumentSymbol, type Hover, type Location, type LocationLink, type MarkedString, type MarkupContent, type Range, type SymbolInformation } from "vscode-languageserver-types";
import { message } from "./dialogs";
import { exactModelRange, monaco, type DocumentTab, type Documents } from "./editor";
import { host, type NativeFolder } from "./workspace";
import { goTestAt, isGoTestFunction } from "./go-test-target";
import { validateRelative } from "./project-model";
import { decodeLocalFileUri, organizeImportEdits } from "./go-import-edits";

export type LanguageState = "idle" | "missing" | "starting" | "ready" | "failed";
const markerOwner = "gopls";
export const runTestCommand = "irongo.runGoTest";
export const debugTestCommand = "irongo.debugGoTest";

export interface NavigationProbe {
  sent(message: Message): void;
  holdReply(message: unknown, deliver: () => void): boolean;
}

declare global { interface Window { __ironNavigationProbe?: NavigationProbe } }

// Tauri carries decoded messages; vscode-jsonrpc owns request IDs, responses,
// cancellation, and dispatch. Only this transport adapter knows about IPC.
class IpcReader extends AbstractMessageReader {
  private callback?: DataCallback;
  listen(callback: DataCallback) {
    this.callback = callback;
    return { dispose: () => { this.callback = undefined; } };
  }
  receive(value: unknown) {
    const deliver = () => this.callback?.(value as Message);
    if (import.meta.env.VITE_IRON_E2E === "1" && window.__ironNavigationProbe?.holdReply(value, deliver)) return;
    deliver();
  }
}

class IpcWriter extends AbstractMessageWriter {
  private previous: Promise<void> = Promise.resolve();
  constructor(private readonly server: number) { super(); }
  write(value: Message) {
    if (import.meta.env.VITE_IRON_E2E === "1") window.__ironNavigationProbe?.sent(value);
    const sent = this.previous.then(() => host.send(this.server, value));
    this.previous = sent.catch(error => { this.fireError(error, value, undefined); });
    return sent;
  }
  end() { /* The owning workspace stops the native process. */ }
}

const k = monaco.languages.CompletionItemKind;
const completionKinds = [k.Text, k.Method, k.Function, k.Constructor, k.Field, k.Variable, k.Class, k.Interface,
  k.Module, k.Property, k.Unit, k.Value, k.Enum, k.Keyword, k.Snippet, k.Color, k.File, k.Reference,
  k.Folder, k.EnumMember, k.Constant, k.Struct, k.Event, k.Operator, k.TypeParameter];

function fromRange(range: Range) {
  return new monaco.Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1);
}

export interface GoLocation { path: string; range: monaco.IRange }
export interface GoSymbol extends GoLocation { name: string; detail: string }

function validRange(range: Range) {
  return range && [range.start?.line, range.start?.character, range.end?.line, range.end?.character]
    .every(value => Number.isInteger(value) && value >= 0) &&
    (range.start.line < range.end.line || (range.start.line === range.end.line && range.start.character <= range.end.character));
}

function symbolKind(kind: number) {
  switch (kind) {
    case SymbolKind.Function: return "Function";
    case SymbolKind.Method: return "Method";
    case SymbolKind.Struct: return "Struct";
    case SymbolKind.Interface: return "Interface";
    case SymbolKind.Constant: return "Constant";
    case SymbolKind.Variable: return "Variable";
    case SymbolKind.Field: return "Field";
    default: return "Symbol";
  }
}

function markdown(content: MarkupContent | MarkedString): monaco.IMarkdownString {
  const plain = (value: string) => value.replace(/[\\`*_{}\[\]<>#+.!|]/g, "\\$&");
  const value = typeof content === "string" ? content : "language" in content
    ? `\`\`\`${content.language.replace(/[^\w-]/g, "")}\n${content.value}\n\`\`\``
    : content.kind === "markdown" ? content.value : plain(content.value);
  return { value, isTrusted: false, supportHtml: false };
}

function asSuggestion(item: CompletionItem, fallback: monaco.IRange): monaco.languages.CompletionItem {
  const edit = item.textEdit;
  const range = edit ? "range" in edit ? fromRange(edit.range) : { insert: fromRange(edit.insert), replace: fromRange(edit.replace) } : fallback;
  return {
    label: item.label,
    range,
    kind: completionKinds[(item.kind ?? 1) - 1] ?? k.Text,
    insertText: edit?.newText ?? item.insertText ?? item.label,
    insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    detail: item.detail,
    filterText: item.filterText,
    sortText: item.sortText,
    documentation: item.documentation === undefined ? undefined : typeof item.documentation === "string" ? item.documentation : markdown(item.documentation),
    additionalTextEdits: item.additionalTextEdits?.map(edit => ({ range: fromRange(edit.range), text: edit.newText })),
  };
}

interface Synced { version: number; timer?: number }

export class GoLanguage {
  private server?: number;
  private connection?: MessageConnection;
  private readonly models = new Map<monaco.editor.ITextModel, Synced>();
  private readonly providers: monaco.IDisposable[] = [];
  private ready = false;
  private disposed = false;

  constructor(
    private readonly folder: NativeFolder,
    private readonly docs: Documents,
    private readonly status: (state: LanguageState, reason?: string) => void,
  ) {}

  async start() {
    const reader = new IpcReader();
    let initializeTimer: number | undefined;
    try {
      const server = await host.lsp(this.folder.id, event => {
        if (this.disposed) return;
        if (event.type === "closed") this.fail(event.reason);
        else reader.receive(event.message);
      });
      if (this.disposed) { void host.stopLsp(server).catch(() => {}); return; }
      this.server = server;
      const rpc = createMessageConnection(reader, new IpcWriter(server));
      this.connection = rpc;
      const root = monaco.Uri.file(this.folder.path).toString();
      const folders = [{ uri: root, name: this.folder.name }];
      rpc.onRequest("workspace/configuration", (params: { items?: unknown[] }) => (params?.items ?? []).map(() => ({})));
      rpc.onRequest("workspace/workspaceFolders", () => folders);
      rpc.onRequest("window/workDoneProgress/create", () => null);
      rpc.onRequest("client/registerCapability", () => null);
      rpc.onRequest("client/unregisterCapability", () => null);
      rpc.onNotification("textDocument/publishDiagnostics", (params: { uri: string; version?: number; diagnostics: Diagnostic[] }) => this.mark(params));
      rpc.listen();
      const info = await Promise.race([
        rpc.sendRequest<{ capabilities?: { positionEncoding?: string; completionProvider?: { triggerCharacters?: string[] } } }>("initialize", {
          processId: null, rootUri: root, workspaceFolders: folders, clientInfo: { name: "Iron Go" },
          capabilities: {
            general: { positionEncodings: ["utf-16"] },
            workspace: { configuration: true, workspaceFolders: true },
            textDocument: {
              synchronization: { didSave: true },
              publishDiagnostics: { versionSupport: true },
              completion: { completionItem: { snippetSupport: true, insertReplaceSupport: true, documentationFormat: ["markdown", "plaintext"] } },
              definition: { linkSupport: true },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["source.organizeImports"] } } },
              hover: { contentFormat: ["markdown", "plaintext"] },
            },
          },
        }),
        new Promise<never>((_, reject) => { initializeTimer = window.setTimeout(() => reject(new Error("Initialize timed out")), 12_000); }),
      ]);
      if (this.disposed) return;
      if (info.capabilities?.positionEncoding && info.capabilities.positionEncoding !== "utf-16") throw new Error("gopls does not support UTF-16 positions");
      await rpc.sendNotification("initialized", {});
      if (this.disposed) return;
      this.ready = true;
      this.registerProviders(info.capabilities?.completionProvider?.triggerCharacters ?? ["."]);
      for (const tab of this.docs.tabs.values()) this.opened(tab);
      this.status("ready");
    } catch (error) { this.fail(message(error)); }
    finally { window.clearTimeout(initializeTimer); }
  }

  opened(tab: DocumentTab) {
    const { model } = tab;
    if (!this.ready || model.getLanguageId() !== "go" || this.models.has(model)) return;
    const version = model.getVersionId();
    this.models.set(model, { version });
    this.notify("textDocument/didOpen", { textDocument: { uri: model.uri.toString(), languageId: "go", version, text: model.getValue() } });
  }

  edited(tab: DocumentTab) {
    const sync = this.models.get(tab.model);
    if (!sync) return;
    window.clearTimeout(sync.timer);
    sync.timer = window.setTimeout(() => this.flush(tab.model), 105);
  }

  saved(tab: DocumentTab) {
    if (!this.models.has(tab.model)) return;
    this.flush(tab.model);
    this.notify("textDocument/didSave", { textDocument: { uri: tab.model.uri.toString() } });
  }

  closed(tab: DocumentTab) {
    const sync = this.models.get(tab.model);
    if (!sync) return;
    window.clearTimeout(sync.timer);
    this.models.delete(tab.model);
    this.notify("textDocument/didClose", { textDocument: { uri: tab.model.uri.toString() } });
  }

  private flush(model: monaco.editor.ITextModel) {
    const sync = this.models.get(model);
    if (!sync) return;
    window.clearTimeout(sync.timer);
    const version = model.getVersionId();
    if (version === sync.version) return;
    sync.version = version;
    this.notify("textDocument/didChange", { textDocument: { uri: model.uri.toString(), version }, contentChanges: [{ text: model.getValue() }] });
  }

  private notify(method: string, params: object) {
    void this.connection?.sendNotification(method, params).catch(error => this.fail(message(error)));
  }

  private mark(params: { uri: string; version?: number; diagnostics: Diagnostic[] }) {
    const path = this.docs.relative(monaco.Uri.parse(params.uri));
    const tab = path && this.docs.tabs.get(path);
    if (!tab || !this.models.has(tab.model) || (params.version != null && params.version !== tab.model.getVersionId())) return;
    const severity = [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint];
    monaco.editor.setModelMarkers(tab.model, markerOwner, params.diagnostics.map(item => ({
      ...fromRange(item.range), message: item.message, severity: severity[(item.severity ?? 1) - 1] ?? severity[0],
      source: item.source ?? markerOwner, code: item.code === undefined ? undefined : String(item.code),
    })));
  }

  private async request<T>(method: string, model: monaco.editor.ITextModel, pos: monaco.Position | undefined, token: monaco.CancellationToken, extra = {}) {
    if (!this.ready || !this.models.has(model) || token.isCancellationRequested) return undefined;
    const version = model.getVersionId();
    this.flush(model);
    try {
      const result = await this.connection?.sendRequest<T>(method, {
        textDocument: { uri: model.uri.toString() },
        ...(pos ? { position: { line: pos.lineNumber - 1, character: pos.column - 1 } } : {}), ...extra,
      }, token);
      return this.ready && !model.isDisposed() && version === model.getVersionId() && !token.isCancellationRequested ? result : undefined;
    } catch { return undefined; }
  }

  private symbols(model: monaco.editor.ITextModel, token: monaco.CancellationToken) {
    return this.request<(DocumentSymbol | SymbolInformation)[] | null>("textDocument/documentSymbol", model, undefined, token);
  }

  private workspaceLocation(uri: string, range: Range): GoLocation | undefined {
    const decoded = decodeLocalFileUri(uri);
    if (!decoded || !validRange(range)) return;
    try {
      const parsed = monaco.Uri.file(decoded);
      const path = this.docs.relative(parsed);
      if (!path) return;
      validateRelative(path);
      const location = fromRange(range);
      const open = this.docs.tabs.get(path);
      if (open && !exactModelRange(open.model, location)) return;
      return { path, range: location };
    } catch { return; }
  }

  async documentSymbols(model: monaco.editor.ITextModel, token: monaco.CancellationToken) {
    const path = this.docs.relative(model.uri);
    if (!path) return [];
    const raw = await this.symbols(model, token) ?? [];
    const results: GoSymbol[] = [];
    const add = (items: (DocumentSymbol | SymbolInformation)[], parent = "") => {
      for (const item of items) {
        const detail = `${symbolKind(item.kind)}${parent ? ` · ${parent}` : ""}`;
        if ("selectionRange" in item) {
          if (validRange(item.selectionRange)) {
            const range = fromRange(item.selectionRange);
            if (exactModelRange(model, range)) results.push({ name: item.name, detail, path, range });
          }
          if (item.children) add(item.children, parent ? `${parent}.${item.name}` : item.name);
        } else {
          const location = this.workspaceLocation(item.location.uri, item.location.range);
          if (location?.path === path) results.push({ name: item.name, detail, ...location });
        }
      }
    };
    add(raw);
    return results;
  }

  async organizeImports(model: monaco.editor.ITextModel) {
    const version = model.getVersionId();
    const last = model.getLineCount();
    const source = new CancellationTokenSource();
    let timer: number | undefined;
    const request = this.request<(CodeAction | Command)[] | null>("textDocument/codeAction", model, undefined, source.token, {
      range: { start: { line: 0, character: 0 }, end: { line: last - 1, character: model.getLineMaxColumn(last) - 1 } },
      context: { diagnostics: [], only: ["source.organizeImports"], triggerKind: 1 },
    });
    try {
      const actions = await Promise.race([request, new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error("gopls did not finish organizing imports.")), 10_000);
      })]);
      if (!actions) return;
      return organizeImportEdits(actions, model.uri.toString(), version)?.map(edit => {
        if (!validRange(edit.range)) throw new Error("The import edit has an invalid UTF-16 range.");
        return { range: fromRange(edit.range), text: edit.newText };
      });
    } finally {
      window.clearTimeout(timer);
      source.cancel();
      source.dispose();
    }
  }

  async references(model: monaco.editor.ITextModel, position: monaco.Position, token: monaco.CancellationToken) {
    for (const open of this.models.keys()) this.flush(open);
    const raw = await this.request<Location[] | null>("textDocument/references", model, position, token,
      { context: { includeDeclaration: true } }) ?? [];
    const results = new Map<string, GoLocation>();
    for (const item of raw) {
      const location = this.workspaceLocation(item.uri, item.range);
      if (location) results.set(JSON.stringify([location.path, location.range]), location);
    }
    return [...results.values()].sort((first, second) => first.path.localeCompare(second.path) ||
      monaco.Range.compareRangesUsingStarts(first.range, second.range));
  }

  async namedTestAt(model: monaco.editor.ITextModel, position: monaco.Position) {
    const symbols = await this.symbols(model, CancellationToken.None);
    return goTestAt(symbols ?? [], { line: position.lineNumber - 1, character: position.column - 1 });
  }

  private registerProviders(triggers: string[]) {
    this.providers.push(monaco.languages.registerCompletionItemProvider("go", {
      triggerCharacters: triggers,
      provideCompletionItems: async (model, pos, context, token) => {
        const kind = monaco.languages.CompletionTriggerKind;
        const completion = await this.request<CompletionList | CompletionItem[] | null>("textDocument/completion", model, pos, token, {
          context: { triggerKind: context.triggerKind === kind.Invoke ? 1 : context.triggerKind === kind.TriggerCharacter ? 2 : 3, triggerCharacter: context.triggerCharacter },
        });
        if (!completion) return { suggestions: [] };
        const word = model.getWordUntilPosition(pos);
        const range = new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn);
        const entries = Array.isArray(completion) ? completion : completion.items;
        return { incomplete: !Array.isArray(completion) && completion.isIncomplete, suggestions: entries.map(item => asSuggestion(item, range)) };
      },
    }), monaco.languages.registerHoverProvider("go", {
      provideHover: async (model, pos, token) => {
        const hover = await this.request<Hover | null>("textDocument/hover", model, pos, token);
        if (!hover) return null;
        return { contents: (Array.isArray(hover.contents) ? hover.contents : [hover.contents]).map(markdown), range: hover.range && fromRange(hover.range) };
      },
    }), monaco.languages.registerDefinitionProvider("go", {
      provideDefinition: async (model, pos, token) => {
        const location = await this.request<Location | Location[] | LocationLink[] | null>("textDocument/definition", model, pos, token);
        if (!location) return [];
        return (Array.isArray(location) ? location : [location]).flatMap(item => {
          const uri = monaco.Uri.parse("targetUri" in item ? item.targetUri : item.uri);
          if (!this.docs.relative(uri)) return [];
          return [{ uri, range: fromRange("targetUri" in item ? item.targetSelectionRange : item.range) }];
        });
      },
    }), monaco.languages.registerCodeLensProvider("go", {
      provideCodeLenses: async (model, token) => {
        const path = this.docs.relative(model.uri);
        if (!path?.endsWith("_test.go")) return { lenses: [] };
        const symbols = await this.symbols(model, token);
        return { lenses: (symbols ?? []).flatMap(symbol => {
          if (symbol.kind !== SymbolKind.Function || !isGoTestFunction(symbol.name)) return [];
          const range = fromRange("selectionRange" in symbol ? symbol.selectionRange : symbol.location.range);
          const args = [this.folder.id, path, symbol.name];
          return [
            { range, command: { id: runTestCommand, title: "Run Test", tooltip: `Run ${symbol.name}`, arguments: args } },
            { range, command: { id: debugTestCommand, title: "Debug Test", tooltip: `Debug ${symbol.name}`, arguments: args } },
          ];
        }) };
      },
    }));
  }

  private fail(reason: string) {
    if (this.disposed) return;
    this.dispose();
    this.status("failed", reason);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.connection?.dispose();
    for (const provider of this.providers) provider.dispose();
    for (const [model, sync] of this.models) {
      window.clearTimeout(sync.timer);
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, markerOwner, []);
    }
    this.models.clear();
    if (this.server !== undefined) void host.stopLsp(this.server).catch(() => {});
  }
}

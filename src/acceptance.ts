import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { bufferText, monaco, replaceBuffer, type Documents } from "./editor";
import type { LanguageState } from "./lsp";
import type { TerminalPane } from "./terminal-pane";
import { host, type RunLaunch } from "./workspace";

declare global {
  interface Window { __ironTestRuntimeErrors?: () => { kind: string; detail: string }[] }
}

export function installAcceptance(docs: Documents, workbench: {
  root(): string | undefined;
  gopls(): LanguageState;
  quitRequests(): number;
  quitExpiry(): number;
  workspaceId(): number | undefined;
  holdEditorSession(hold: boolean): void;
  terminal: TerminalPane;
}) {
  let gutterHit: { line: number | null; type: string } | undefined;
  let selectionSource: string | undefined;
  let navigationRequest: unknown;
  let deferredNavigation: (() => void) | undefined;
  let navigationCancelled = false;
  let releaseSourceRead: (() => void) | undefined;
  let sourceReadHeld = false;
  let releaseDebugScopes: (() => void) | undefined;
  let debugScopesHeld = false;
  const releaseNavigation = () => {
    delete window.__ironNavigationProbe;
    const deferred = deferredNavigation;
    deferredNavigation = undefined;
    deferred?.();
  };
  docs.editor.onMouseDown(event => {
    gutterHit = { line: event.target.position?.lineNumber ?? null, type: monaco.editor.MouseTargetType[event.target.type] };
  });
  docs.editor.onDidChangeCursorSelection(event => { selectionSource = event.source; });
  Object.assign(window, { __ironTest: {
    snapshot: () => ({ root: workbench.root(), path: docs.active?.path, text: docs.active && bufferText(docs.active.model), dirty: docs.active?.dirty,
      markers: docs.active ? monaco.editor.getModelMarkers({ resource: docs.active.model.uri }) : [], gopls: workbench.gopls(),
      editor: { width: docs.editor.getLayoutInfo().width, height: docs.editor.getLayoutInfo().height, scrollTop: docs.editor.getScrollTop(), contentHeight: docs.editor.getContentHeight(), runtimeErrors: window.__ironTestRuntimeErrors?.() } }),
    toolProbe: host.tools,
    replace: (value: string) => { if (docs.active) replaceBuffer(docs.active.model, value); },
    goSourceView: () => {
      const editor = monaco.editor.getEditors().find(editor => editor.getContainerDomNode().id === "go-source-editor");
      const model = editor?.getModel();
      const range = editor?.getSelection();
      return model && range ? { text: bufferText(model), selected: model.getValueInRange(range) } : null;
    },
    holdGoSourceRead: () => {
      const read = host.readGoSource;
      sourceReadHeld = false;
      const released = new Promise<void>(resolve => { releaseSourceRead = resolve; });
      host.readGoSource = async (id, path) => {
        host.readGoSource = read;
        const source = await read(id, path);
        sourceReadHeld = true;
        await released;
        return source;
      };
    },
    goSourceReadHeld: () => sourceReadHeld,
    releaseGoSourceRead: () => releaseSourceRead?.(),
    holdDebugScopes: () => {
      const start = host.debug;
      const send = host.sendDebug;
      let sequence: number | undefined;
      let held: (() => void) | undefined;
      debugScopesHeld = false;
      host.debug = (id, pkg, handle) => start(id, pkg, event => {
        const reply = event.type === "message" ? event.message as { request_seq?: number; type?: string } : undefined;
        if (sequence !== undefined && reply?.type === "response" && reply.request_seq === sequence) {
          held = () => handle(event);
          debugScopesHeld = true;
        } else handle(event);
      });
      host.sendDebug = (server, request) => {
        const message = request as { command?: string; seq?: number };
        if (message.command === "scopes" && sequence === undefined) sequence = message.seq;
        return send(server, request);
      };
      releaseDebugScopes = () => {
        host.debug = start;
        host.sendDebug = send;
        releaseDebugScopes = undefined;
        held?.();
      };
    },
    debugScopesHeld: () => debugScopesHeld,
    releaseDebugScopes: () => releaseDebugScopes?.(),
    debugExecutionLines: () => docs.active?.model.getAllDecorations()
      .filter(decoration => decoration.options.className === "debug-execution-line")
      .map(decoration => decoration.range.startLineNumber) ?? [],
    holdDebugDisconnect: (hold: boolean) => invoke<void>("test_hold_debug_disconnect", { hold }),
    draftQuit: (hold?: boolean, refuse?: boolean) => invoke<boolean>("test_draft_quit", { hold, refuse }),
    workspaceId: workbench.workspaceId,
    holdEditorSession: workbench.holdEditorSession,
    editorSession: () => docs.captureSession(),
    codeLocation: () => docs.captureLocation(),
    editorInputOptions: () => {
      const { accessibilitySupport, editContext } = docs.editor.getRawOptions();
      return { accessibilitySupport, editContext };
    },
    terminalInput: (text: string) => workbench.terminal.acceptanceInput(text),
    terminalSnapshot: () => workbench.terminal.acceptanceSnapshot(),
    holdTerminalAck: (hold: boolean) => workbench.terminal.acceptanceHoldAck(hold),
    terminalObservation: () => invoke("test_terminal_observation"),
    attemptTerminalAck: host.terminalAck,
    draftRecords: () => host.listDrafts(workbench.workspaceId()),
    removeDraftRecord: (draft: Parameters<typeof host.removeDraft>[1]) => host.removeDraft(workbench.workspaceId(), draft),
    holdDraftProfile: (hold: boolean) => invoke<void>("test_hold_draft_profile", { hold }),
    gutterTrace: (inspect: number[] = []) => {
      const selection = docs.editor.getSelection();
      const rows = [...document.querySelectorAll<HTMLElement>("#editor .line-numbers")];
      const selected = rows.filter(row => row.classList.contains("gutter-selected-number"));
      const caret = rows.filter(row => row.classList.contains("active-line-number"));
      return {
        hit: gutterHit, selectionSource,
        caret: docs.editor.getPosition(),
        selection: selection && { start: selection.getStartPosition(), end: selection.getEndPosition(), empty: selection.isEmpty() },
        caretNumbers: caret.map(row => row.textContent?.trim()),
        highlightedNumbers: (selected.length ? selected : caret).map(row => row.textContent?.trim()).filter(Boolean),
        numberColors: Object.fromEntries(rows.flatMap(row => {
          const number = row.textContent?.trim();
          return number && inspect.includes(Number(number)) ? [[number, getComputedStyle(row).color]] : [];
        })),
      };
    },
    refreshView: () => docs.refreshView(),
    resize: (width: number, height: number) => getCurrentWindow().setSize(new LogicalSize(width, height)),
    focusWindow: () => getCurrentWindow().setFocus(),
    revealLine: (lineNumber: number) => {
      docs.layout();
      docs.editor.setPosition({ lineNumber, column: 1 });
      const top = docs.editor.getTopForLineNumber(lineNumber, true);
      const height = docs.editor.getLayoutInfo().height;
      docs.editor.setScrollTop(Math.max(0, top - height / 2), monaco.editor.ScrollType.Immediate);
      docs.editor.focus();
      docs.refreshView();
    },
    suggest: (lineNumber: number, column: number) => {
      docs.editor.setPosition({ lineNumber, column });
      docs.editor.focus();
      docs.editor.trigger("iron-test", "editor.action.triggerSuggest", {});
    },
    position: (lineNumber: number, column: number) => docs.editor.setPosition({ lineNumber, column }),
    holdGoRequest(method: "textDocument/references" | "textDocument/codeAction" | "textDocument/definition", prependDefinitionUri?: string) {
      releaseNavigation();
      navigationRequest = undefined;
      navigationCancelled = false;
      window.__ironNavigationProbe = {
        sent(value) {
          const message = value as { method?: string; id?: unknown; params?: { id?: unknown } };
          if (navigationRequest === undefined && message.method === method) navigationRequest = message.id;
          if (message.method === "$/cancelRequest" && navigationRequest !== undefined && message.params?.id === navigationRequest) navigationCancelled = true;
        },
        holdReply(value, deliver) {
          const message = value as { id?: unknown; method?: string; result?: unknown };
          if (navigationRequest === undefined || message?.id !== navigationRequest || message.method !== undefined) return false;
          if (method === "textDocument/definition" && prependDefinitionUri && message.result) {
            const first = { uri: prependDefinitionUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
            message.result = [first, ...[message.result].flat()];
          }
          deferredNavigation = deliver;
          return true;
        },
      };
    },
    goReferenceProbe: () => ({ deferred: !!deferredNavigation, cancelled: navigationCancelled }),
    releaseGoReferences: releaseNavigation,
    action: (id: string, lineNumber: number, column: number) => {
      docs.editor.setPosition({ lineNumber, column });
      docs.editor.focus();
      // Some built-ins (including Go to Definition) are registered with
      // Monaco's command service, not in editor.getAction().
      const action = docs.editor.getAction(id);
      if (id === "ironGo.goToDefinition" && action) return action.run();
      docs.editor.trigger("iron-test", id, {});
    },
    quit: () => { void getCurrentWindow().destroy(); },
    closeWindow: () => invoke<void>("test_perform_window_close"),
    quitWindowState: (minimize = false) => invoke<[boolean, boolean]>("test_quit_window_state", { minimize }),
    quitMenu: () => invoke<boolean>("test_quit_menu_action"),
    menuItem: (menu: string, title: string, activate = false) => invoke<boolean | null>("test_menu_item", { menu, title, activate }),
    quitRequests: workbench.quitRequests,
    quitExpiry: workbench.quitExpiry,
    quitDeadline: (hold?: boolean) => invoke<[number, boolean] | null>("test_quit_deadline", { hold }),
    cancelNextPicker: () => invoke<void>("test_cancel_next_picker"),
    holdSave: (hold?: boolean, path?: string) => invoke<boolean>("test_hold_save", { hold, path }),
    runHandoff: (hold?: boolean) => invoke<string | null>("test_run_handoff", { hold }),
    attemptConfiguredRun: (packageName: string, launch: RunLaunch) =>
      host.task(workbench.workspaceId()!, "run", [packageName], undefined, () => {}, launch),
    attemptQuitSave: (path: string, expected: string, text: string, quitTicket: number) =>
      invoke<void>("save_file", { id: workbench.workspaceId(), path, expected, text, quitTicket }),
    saving: () => docs.saving,
    tryType: (text: string) => docs.editor.trigger("keyboard", "type", { text }),
  } });
}

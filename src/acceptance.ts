import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { bufferText, monaco, replaceBuffer, type Documents } from "./editor";
import type { LanguageState } from "./lsp";
import { host } from "./workspace";

declare global {
  interface Window { __ironTestRuntimeErrors?: () => { kind: string; detail: string }[] }
}

export function installAcceptance(docs: Documents, workbench: {
  root(): string | undefined;
  gopls(): LanguageState;
  quitRequests(): number;
  quitExpiry(): number;
  workspaceId(): number | undefined;
}) {
  let gutterHit: { line: number | null; type: string } | undefined;
  let selectionSource: string | undefined;
  let navigationRequest: unknown;
  let deferredNavigation: (() => void) | undefined;
  let navigationCancelled = false;
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
    holdGoRequest(method: "textDocument/references" | "textDocument/codeAction") {
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
          const message = value as { id?: unknown; method?: string };
          if (navigationRequest === undefined || message?.id !== navigationRequest || message.method !== undefined) return false;
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
      docs.editor.trigger("iron-test", id, {});
    },
    quit: () => { void getCurrentWindow().destroy(); },
    closeWindow: () => invoke<void>("test_perform_window_close"),
    quitWindowState: (minimize = false) => invoke<[boolean, boolean]>("test_quit_window_state", { minimize }),
    quitMenu: () => invoke<boolean>("test_quit_menu_action"),
    quitRequests: workbench.quitRequests,
    quitExpiry: workbench.quitExpiry,
    quitDeadline: (hold?: boolean) => invoke<[number, boolean] | null>("test_quit_deadline", { hold }),
    cancelNextPicker: () => invoke<void>("test_cancel_next_picker"),
    holdSave: (hold?: boolean, path?: string) => invoke<boolean>("test_hold_save", { hold, path }),
    attemptQuitSave: (path: string, expected: string, text: string, quitTicket: number) =>
      invoke<void>("save_file", { id: workbench.workspaceId(), path, expected, text, quitTicket }),
    saving: () => docs.saving,
    tryType: (text: string) => docs.editor.trigger("keyboard", "type", { text }),
  } });
}

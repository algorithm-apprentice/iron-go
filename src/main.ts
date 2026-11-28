import "./styles.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CancellationTokenSource } from "vscode-jsonrpc/lib/browser/main.js";
import { byId, element, Forms, message, Palette } from "./dialogs";
import { showDiskComparison } from "./disk-compare";
import { prepareGoRename, reviewGoRename } from "./go-rename";
import { showGoSource } from "./go-source-view";
import { DebugInspectionView } from "./debug-inspection-view";
import type { DebugInspectionState } from "./debug-inspection";
import { DraftRecorder } from "./draft-recorder";
import { TerminalPane } from "./terminal-pane";
import { applyExactTextEdits, bufferText, defaultEditorFontSize, Documents, editorTypography, exactModelRange, monaco, type DocumentTab, type SaveOptions } from "./editor";
import { Feedback } from "./feedback";
import { fileIcon, icon, prepareIcons, type Icon } from "./icons";
import { GoLanguage, debugTestCommand, runTestCommand, type GoLocation, type GoSymbol, type LanguageState } from "./lsp";
import { Breakpoints, DebugSession } from "./debugger";
import { packageForFile, RunTargets } from "./run-targets";
import { bindColorTheme, chooseColorTheme } from "./theme";
import { basename, dirname, inPath, initialWorkspaceFile, makeTree, quickFiles, validateRelative, type FileMatch, type ProjectSnapshot, type TreeNode } from "./project-model";
import { decideExit } from "./quit-flow";
import { ExecutionLane } from "./execution";
import { ProjectSnapshots } from "./project-workflow";
import { saveDirtyTabs } from "./save-batch";
import { createCursorTestWorkflow } from "./cursor-test-workflow";
import { handleEditorCycle } from "./editor-shortcuts";
import { desktop, host, importedProject, nativeProject, welcomeProject, type DraftItem, type NativeFolder, type Project, type ReadableDisk, type RunLaunch, type TaskKind, type ToolStatus, type WorkspaceMutation } from "./workspace";

type View = "explorer" | "search" | "tasks";

prepareIcons();
document.body.classList.toggle("desktop", desktop);
const palette = new Palette();
const forms = new Forms();
const feedback = new Feedback(() => docs.layout(), location => {
  const target = project;
  const relative = docs.relative(monaco.Uri.file(location.absolute));
  if (!relative) return;
  try { validateRelative(relative); } catch { return; }
  return () => {
    if (project === target) void openFile(relative, new monaco.Range(location.line, location.column, location.line, location.column));
  };
});
const terminal = new TerminalPane(visible => {
  if (visible) feedback.show("terminal");
  else feedback.hide("terminal");
}, showError);
const workbench = byId("workbench");
const btn = (id: string) => byId<HTMLButtonElement>(id);
const input = (id: string) => byId<HTMLInputElement>(id);
const toolsMissing = { goVersion: null, gofmt: false, gopls: false, delve: false };
const runTargets = new RunTargets(focus => {
  chooseView("tasks");
  byId<HTMLDetailsElement>("advanced-targets").open = true;
  focus.focus();
}, syncControls);

let project = welcomeProject();
let snapshot: ProjectSnapshot = { entries: [], truncated: false, module: null, goWork: false };
let tree: TreeNode[] = [];
let opened = new Set<string>();
let view: View = "explorer";
let rootExpanded = true;
let explorerSelection: string | undefined;
let mutatingPaths = false;
const breakpoints = new Breakpoints();
const drafts = new DraftRecorder(byId("draft-state"));
const debugInspection = new DebugInspectionView(byId("debug-stack"), byId("debug-variables"));
let executionLine: { model: monaco.editor.ITextModel; ids: string[] } | undefined;
let formatting = false;
let fileMutations = 0;
let fileDecisionPending = false;
let testQuitRequests = 0;
let quitDialogTicket: number | undefined;
let lastExpiredQuitTicket = 0;
const sessionExpiry = new Map<number, () => void>();
let restoringSession = false;
let failedSessionRestore: Project | undefined;
let sessionInstall = 0;
let sessionTimer: number | undefined;
let sessionWrite: Promise<void> | undefined;
let sessionDirty = false;
let sessionRevision = 0;
let holdSessionDebounce = false;
let tools: ToolStatus | undefined;
let lsp: GoLanguage | undefined;
let gopls: LanguageState = "idle";
let searchGeneration = 0;
let searchTimer: number | undefined;
let toastTimer: number | undefined;
let renderedActive: string | undefined;
const snapshots = new ProjectSnapshots();
let refreshDisk: ((tree?: boolean) => Promise<void>) | undefined;
let navigation: { current(): boolean; cancel(): void } | undefined;

const diskMessage = {
  changed: "File changed on disk",
  missing: "File missing on disk",
  unavailable: "File unavailable on disk",
};

const docs = new Documents(byId("editor"), {
  changed: renderDocuments,
  opened: tab => {
    if (!restoringSession && failedSessionRestore === project) failedSessionRestore = undefined;
    breakpoints.open(tab); lsp?.opened(tab); invalidateNavigation(); void refreshDisk?.();
  },
  edited: tab => {
    lsp?.edited(tab);
    invalidateNavigation();
    drafts.schedule(project.native, tab);
    if (!tab.dirty && tab.diskChange === "changed") void refreshDisk?.();
  },
  closed: tab => { breakpoints.close(tab); lsp?.closed(tab); invalidateNavigation(); queueMicrotask(renderProblems); },
  saved: tab => { lsp?.saved(tab); invalidateNavigation(); drafts.schedule(project.native, tab, true); },
  fileSettled: () => { void refreshDisk?.(); },
});
const execution = new ExecutionLane<NativeFolder, DebugSession>(syncControls);
const { lookup: cursorTestLookup, projectWorkflow } = createCursorTestWorkflow(docs.editor, reserved => {
  docs.editor.updateOptions({ readOnly: reserved });
  syncControls();
});

function cycleEditor(direction: 1 | -1) {
  return !projectWorkflow.busy && docs.cycle(direction);
}

const filesBusy = () => docs.saving || formatting || fileMutations !== 0;
const fileActionsBlocked = () => projectWorkflow.busy || execution.preparing || fileDecisionPending;
const saveBarrier = {
  revision: () => docs.editRevision,
  dirty: () => docs.dirty,
  async save() {
    for (const tab of docs.tabs.values()) if (tab.dirty && await docs.save(tab)) await drafts.settled(tab);
  },
};

function reserveFileActivity() {
  if (fileActionsBlocked() || filesBusy() || document.querySelector("dialog[open]")) return;
  fileDecisionPending = true;
  fileMutations++;
  syncControls();
  return () => {
    fileMutations--;
    fileDecisionPending = false;
    syncControls();
    void refreshDisk?.();
  };
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    docs.refreshView();
    void refreshDisk?.(true);
  }
});
window.addEventListener("focus", () => { void refreshDisk?.(true); });

function status(text: string) { byId("status").textContent = text; }
function toast(text: string, error = false) {
  const alert = byId("toast");
  alert.textContent = text;
  alert.classList.toggle("error", error);
  alert.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { alert.hidden = true; }, 6500);
}
function showError(error: unknown) { toast(message(error), true); }

function renderExplorer() {
  const explorer = byId("explorer");
  byId("module-card").hidden = !!project.welcome;
  if (project.welcome) {
    explorer.replaceChildren(element("p", "view-note tree-note", "No project open."));
    return;
  }
  const root = element("button", "explorer-root");
  root.innerHTML = `<span class="tree-twist">${icon(rootExpanded ? "down" : "chevron")}</span>`;
  root.append(element("strong", "", project.name));
  root.title = project.native?.path ?? `${project.name} · browser import`;
  root.setAttribute("aria-expanded", String(rootExpanded));
  if (!project.native) root.append(element("span", "root-tag", "COPY"));
  root.addEventListener("click", () => {
    explorerSelection = undefined;
    rootExpanded = !rootExpanded;
    renderExplorer();
    explorer.querySelector("button")?.focus();
  });
  const list = element("div", "tree-list");
  const render = (items: TreeNode[], depth: number) => {
    for (const item of items) {
      const expanded = opened.has(item.path);
      const row = element("button", `tree-row${!item.directory && item.path === docs.active?.path ? " active" : ""}`);
      row.dataset.path = item.path;
      row.style.setProperty("--depth", String(depth));
      row.title = item.path;
      if (item.path === explorerSelection) row.setAttribute("aria-current", "true");
      row.innerHTML = `<span class="tree-twist">${item.directory ? icon(expanded ? "down" : "chevron") : ""}</span>` +
        (item.directory ? `<span class="tree-folder">${icon(expanded ? "folderOpen" : "folder")}</span>` : fileIcon(item.path));
      row.append(element("span", "tree-name", item.name));
      if (item.directory) row.setAttribute("aria-expanded", String(expanded));
      row.addEventListener("click", () => {
        explorerSelection = item.path;
        if (!item.directory) { void openFile(item.path); return; }
        if (expanded) opened.delete(item.path); else opened.add(item.path);
        renderExplorer();
        [...explorer.querySelectorAll<HTMLButtonElement>(".tree-row")].find(button => button.dataset.path === item.path)?.focus();
      });
      list.append(row);
      if (item.directory && expanded) render(item.children, depth + 1);
    }
  };
  if (rootExpanded) {
    render(tree, 0);
    if (!tree.length) list.append(element("p", "view-note tree-note", "No files here yet. Create a file to get started."));
    if (snapshot.truncated) list.append(element("p", "view-note tree-note", "Explorer limit reached. Open a smaller folder to see more files."));
  }
  const scroll = explorer.scrollTop;
  const focused = document.activeElement?.closest<HTMLButtonElement>("#explorer button");
  explorer.replaceChildren(root, list);
  explorer.scrollTop = scroll;
  if (focused) {
    const buttons = [...list.querySelectorAll<HTMLButtonElement>(".tree-row")];
    let path = focused.dataset.path;
    let restored: HTMLButtonElement | undefined;
    while (path && !restored) {
      restored = buttons.find(row => row.dataset.path === path);
      path = dirname(path);
    }
    (restored ?? root).focus({ preventScroll: true });
  }
  byId("module-kind").textContent = snapshot.goWork ? "Go workspace" : snapshot.module ? "Go module" : "Folder";
  const moduleName = snapshot.module ?? (snapshot.goWork ? "go.work" : project.name);
  byId("module-name").textContent = moduleName;
  byId("module-name").title = moduleName;
}

function revealParents(path: string) {
  let parent = dirname(path);
  while (parent) { opened.add(parent); parent = dirname(parent); }
}

async function openFile(path: string, target?: monaco.IRange) {
  if (projectWorkflow.busy) return;
  try {
    const tab = await docs.open(path, { focus: true, target });
    if (tab && tab.path === docs.active?.path) {
      revealParents(path);
      rootExpanded = true;
      renderExplorer();
    }
  } catch (error) { showError(error); }
}

function renderDocuments() {
  invalidateNavigation();
  queueEditorSession();
  const tabs = byId("tabs");
  const active = docs.active;
  const scroll = tabs.scrollLeft;
  const focusedTab = document.activeElement?.closest<HTMLElement>("#tabs .tab")?.dataset.tabPath;
  const focusedClose = document.activeElement?.classList.contains("tab-close");
  const children: HTMLElement[] = [];
  for (const tab of docs.tabs.values()) {
    const selected = tab === active;
    const row = element("div", `tab${selected ? " active" : ""}${tab.dirty ? " dirty" : ""}`);
    row.dataset.tabPath = tab.path;
    if (tab.diskChange) row.dataset.diskChange = tab.diskChange;
    row.setAttribute("role", "presentation");
    const name = element("button", "tab-main");
    name.type = "button";
    name.dataset.path = tab.path;
    name.title = tab.diskChange ? `${tab.path} — ${diskMessage[tab.diskChange]}` : tab.path;
    name.setAttribute("role", "tab");
    name.setAttribute("aria-selected", String(selected));
    name.innerHTML = fileIcon(tab.path);
    name.append(element("span", "", basename(tab.path)));
    name.addEventListener("click", () => { void openFile(tab.path); });
    const close = element("button", "icon-button tab-close");
    close.innerHTML = icon("close");
    close.title = tab.dirty ? "Close unsaved file" : "Close tab";
    close.setAttribute("aria-label", `Close ${basename(tab.path)}`);
    close.addEventListener("click", () => { void closeTab(tab); });
    row.append(name, close);
    children.push(row);
  }
  tabs.replaceChildren(...children);
  tabs.scrollLeft = scroll;
  if (focusedTab) tabControl(focusedTab, focusedClose ? "close" : "main")?.focus();
  if (renderedActive !== active?.path) {
    const crumbs = byId("breadcrumbs");
    crumbs.replaceChildren();
    if (active) {
      const path = active.path.split("/");
      for (const [index, segment] of path.entries()) {
        if (index) {
          const separator = element("span");
          separator.innerHTML = icon("chevron");
          crumbs.append(separator);
        }
        if (index === path.length - 1) {
          const file = element("span");
          file.innerHTML = fileIcon(active.path);
          crumbs.append(file);
        }
        crumbs.append(element("span", "crumb", segment));
      }
      tabs.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    renderedActive = active?.path;
    renderExplorer();
  }
  byId("project-welcome").hidden = !project.welcome;
  byId("editor-toolbar").hidden = !!project.welcome;
  byId("empty-editor").hidden = !!active || !!project.welcome;
  byId("breadcrumbs").hidden = !active;
  const disk = byId("disk-change");
  disk.textContent = active?.diskChange ? diskMessage[active.diskChange] : "";
  disk.hidden = !disk.textContent;
  byId("compare-disk").hidden = !project.native || active?.diskChange !== "changed";
  byId("save-new-path").hidden = !project.native || (!active?.requiresReviewedSave && active?.diskChange !== "missing" && active?.diskChange !== "unavailable");
  updateCursor();
  syncControls();
}

function updateCursor() {
  const position = docs.editor.getPosition();
  const active = docs.active;
  byId("cursor").textContent = position ? `Ln ${position.lineNumber}, Col ${position.column}` : "";
  byId("indent").textContent = active ? (active.model.getOptions().insertSpaces ? "Spaces: 4" : "Tab Size: 4") : "";
  byId("language").textContent = active ? active.path.endsWith(".go") ? "Go" : active.path.endsWith(".md") ? "Markdown" : /(^|\/)go\.(mod|work|sum)$/.test(active.path) ? "Go Module" : "Plain Text" : "";
}

function invalidateNavigation() {
  if (navigation && !navigation.current()) navigation.cancel();
}

async function goToDefinition() {
  const folder = project.native;
  const tab = docs.active;
  const service = lsp;
  const position = docs.editor.getPosition();
  if (!folder || !tab || !service || gopls !== "ready" || !position || tab.model.getLanguageId() !== "go") {
    toast("Open a Go file with gopls running to go to a definition.");
    return;
  }
  if (projectWorkflow.busy || document.querySelector("dialog[open]")) return;
  navigation?.cancel();
  const live = captureTab(tab);
  const version = tab.model.getVersionId();
  const token = new CancellationTokenSource();
  const job = {
    current: () => navigation === job && live() && docs.active === tab && lsp === service && gopls === "ready" &&
      !projectWorkflow.busy && tab.model.getVersionId() === version && monaco.Position.equals(position, docs.editor.getPosition()),
    cancel: () => { if (navigation === job) navigation = undefined; token.cancel(); token.dispose(); },
  };
  navigation = job;
  let shown = false;
  try {
    const targets = await service.definitions(tab.model, position, token.token);
    if (!job.current()) return;
    const local = targets.flatMap(target => {
      const path = docs.relative(target.uri);
      return path ? [{ path, range: target.range }] : [];
    });
    if (local.length > 1) {
      docs.editor.trigger("iron-go", "editor.action.revealDefinition", {});
      return;
    }
    if (local.length === 1) {
      const { path, range } = local[0];
      await docs.open(path, { focus: true, target: { lineNumber: range.startLineNumber, column: range.startColumn }, current: job.current });
      return;
    }
    let unavailable: Error | undefined;
    for (const { uri, range } of targets) {
      if (!uri.path.endsWith(".go")) continue;
      try {
        const source = await host.readGoSource(folder.id, uri.path);
        if (!job.current() || document.querySelector("dialog[open]")) return;
        await showGoSource(source, range);
        shown = true;
        return;
      } catch (error) {
        if (!job.current() || document.querySelector("dialog[open]")) return;
        unavailable ??= new Error(`${uri.path}: ${message(error)}`);
      }
    }
    if (unavailable) throw unavailable;
    toast("No definition found.");
  } catch (error) { if (job.current()) showError(error); }
  finally {
    if (shown && job.current() && !document.querySelector("dialog[open]")) docs.editor.focus();
    if (navigation === job) job.cancel();
  }
}

function goToLine() {
  const tab = docs.active;
  if (!tab || projectWorkflow.busy) return;
  const live = captureTab(tab);
  forms.show({
    title: "Go to Line", description: `Go to a line in ${tab.path}.`, submit: "Go to Line",
    fields: [{ name: "line", label: "Line number" }],
    async run({ line }) {
      if (!live() || docs.active !== tab) throw new Error("This editor has changed. Open Go to Line again.");
      const last = tab.model.getLineCount();
      const value = Number(line);
      if (!/^[0-9]+$/.test(line) || value < 1 || value > last) throw new Error(`Enter a whole line number from 1 through ${last}.`);
      docs.editor.setPosition({ lineNumber: value, column: 1 });
      docs.editor.revealLineInCenterIfOutsideViewport(value);
      byId("form-dialog").addEventListener("close", () => { if (live() && docs.active === tab) docs.editor.focus(); }, { once: true });
    },
  });
}

async function goNavigation(kind: "symbols" | "references") {
  const tab = docs.active;
  const service = lsp;
  const position = docs.editor.getPosition();
  if (!tab || !service || gopls !== "ready" || tab.model.getLanguageId() !== "go" || !position) {
    toast("Open a Go file with gopls running to use this command.");
    return;
  }
  if (projectWorkflow.busy) return;
  navigation?.cancel();
  const inFile = kind === "symbols";
  const editRevision = docs.editRevision;
  const live = captureTab(tab);
  const tracked = new Map([...docs.tabs].filter(([, entry]) => entry.model.getLanguageId() === "go"));
  const valid = (selected?: string) => {
    if (!live() || lsp !== service || gopls !== "ready" || docs.active !== tab || projectWorkflow.busy) return false;
    if (inFile) return true;
    const caret = docs.editor.getPosition();
    if (docs.editRevision !== editRevision || !caret || !position.equals(caret)) return false;
    if ([...tracked].some(([path, entry]) => docs.tabs.get(path) !== entry)) return false;
    return [...docs.tabs].every(([path, entry]) => entry.model.getLanguageId() !== "go" || tracked.has(path) || path === selected);
  };

  const cancel = new CancellationTokenSource();
  const dialog = byId<HTMLDialogElement>("go-symbol-dialog");
  const filter = input("go-symbol-search");
  const list = byId(inFile ? "go-symbol-results" : "references-results");
  const note = (text: string) => list.replaceChildren(element("p", "view-note tree-note", text));
  let symbols: GoSymbol[] = [];
  let selected: GoLocation | undefined;
  const finish = () => {
    if (navigation !== job) return;
    navigation = undefined;
    dialog.removeEventListener("close", dismissed);
    filter.removeEventListener("input", renderSymbols);
    cancel.cancel();
    cancel.dispose();
  };
  const dismissed = () => finish();
  const job = {
    current: () => valid(selected?.path),
    cancel() {
      finish();
      if (inFile && dialog.open) dialog.close();
      if (!inFile) note("References are out of date. Run Find References again.");
    },
  };
  const select = (location: GoLocation) => {
    if (navigation !== job || selected || !valid()) return;
    selected = location;
    if (inFile && dialog.open) {
      dialog.removeEventListener("close", dismissed);
      dialog.close();
    }
    if (!inFile) note("Opening reference…");
    void docs.open(location.path, {
      focus: true, target: location.range, userNavigation: true,
      current: () => navigation === job && valid(location.path),
      validate(result) {
        if (!exactModelRange(result.model, location.range)) throw new Error("This location no longer matches the file.");
      },
      beforeActivate() {
        finish();
        if (!inFile) note("Run Find References to refresh the results.");
      },
    })
      .then(result => {
        if (navigation === job) job.cancel();
        if (result && docs.active === result) { revealParents(result.path); renderExplorer(); }
      }).catch(error => { if (navigation === job) { job.cancel(); showError(error); } });
  };
  const row = (location: GoLocation, label: string, detail: string) => {
    const button = element("button", "problem-row");
    button.append(element("span", "", ""), element("span", "", label), element("span", "problem-location", detail));
    button.addEventListener("click", () => select(location));
    return button;
  };
  const renderSymbols = () => {
    const query = filter.value.trim().toLowerCase();
    const matches = symbols.filter(symbol => `${symbol.name} ${symbol.detail}`.toLowerCase().includes(query));
    if (!matches.length) { note("No matching Go symbols."); return; }
    list.replaceChildren(...matches.map(symbol => row(symbol, symbol.name, `${symbol.detail} · Line ${symbol.range.startLineNumber}`)));
  };
  navigation = job;
  if (inFile) {
    filter.value = "";
    dialog.addEventListener("close", dismissed, { once: true });
    dialog.showModal();
  } else {
    btn("references-tab").hidden = false;
    feedback.show("references");
    btn("close-references").focus();
  }
  note(inFile ? "Finding Go symbols…" : "Finding Go references…");
  try {
    const results = inFile ? await service.documentSymbols(tab.model, cancel.token) : await service.references(tab.model, position, cancel.token);
    if (navigation !== job) return;
    if (!valid()) { job.cancel(); return; }
    if (inFile) {
      symbols = results as GoSymbol[];
      filter.addEventListener("input", renderSymbols);
      renderSymbols();
    } else if (results.length) {
      const groups: HTMLElement[] = [];
      let previous: string | undefined;
      for (const reference of results) {
        if (reference.path !== previous) groups.push(element("h3", "go-reference-heading", reference.path));
        previous = reference.path;
        const { startLineNumber, startColumn } = reference.range;
        groups.push(row(reference, `${basename(reference.path)}:${startLineNumber}:${startColumn}`, "Reference"));
      }
      list.replaceChildren(...groups);
    } else note("No workspace references found.");
  } catch (error) {
    if (navigation === job) note(message(error));
  }
}

function syncControls() {
  const active = docs.active;
  const task = execution.task;
  const debug = execution.debug;
  const busy = projectWorkflow.busy;
  btn("format").disabled = !active?.path.endsWith(".go") || formatting || fileActionsBlocked();
  btn("save").disabled = !active || active.saving || fileActionsBlocked();
  btn("open-folder").disabled = busy || execution.preparing || filesBusy();
  btn("open-folder").hidden = !!project.welcome;
  btn("welcome-open").disabled = busy;
  btn("welcome-new").disabled = busy;
  btn("new-file").disabled = fileActionsBlocked() || !!project.welcome;
  const run = btn("run");
  run.disabled = busy || (execution.occupied ? !execution.canStopTask : filesBusy()) || !!project.welcome;
  run.dataset.running = String(!!task);
  const primary = runTargets.primaryAction();
  run.innerHTML = `${icon(task ? "stop" : primary === "test" ? "flask" : "play")}<span>${task ? "Stop" : primary === "test" ? "Test" : "Run"}</span>`;
  run.title = task ? "Stop Go Task" : primary === "test" ? "Test Go Packages (⌘↵)" : "Run Go Package (⌘↵)";
  btn("panel-stop").hidden = !task;
  btn("panel-stop").disabled = busy || !execution.canStopTask;
  btn("stop-task").disabled = busy || !execution.canStopTask;
  runTargets.setDisabled(busy, execution.occupied);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-task]")) button.disabled = execution.occupied || busy || filesBusy() || !!project.welcome;
  byId("debug-controls").hidden = !debug;
  btn("debug-continue").disabled = busy || !debug?.paused;
  btn("debug-next").disabled = busy || !debug?.paused;
  btn("debug-step-in").disabled = busy || !debug?.paused;
  btn("debug-step-out").disabled = busy || !debug?.paused;
  btn("debug-stop").disabled = busy || !debug?.canStop;
}

function renderProblems() {
  const items = [...docs.tabs.values()].flatMap(tab => monaco.editor.getModelMarkers({ owner: "gopls", resource: tab.model.uri }).map(marker => ({ tab, marker })));
  items.sort((a, b) => b.marker.severity - a.marker.severity || a.tab.path.localeCompare(b.tab.path) || a.marker.startLineNumber - b.marker.startLineNumber);
  byId("problem-count").textContent = String(items.length);
  byId("error-count").textContent = String(items.filter(entry => entry.marker.severity === monaco.MarkerSeverity.Error).length);
  byId("warning-count").textContent = String(items.filter(entry => entry.marker.severity === monaco.MarkerSeverity.Warning).length);
  const list = byId("problems-pane");
  if (!items.length) {
    list.replaceChildren(element("p", "view-note tree-note", gopls === "ready" ? "No problems in open Go files." : "No diagnostics. Open a local Go workspace with gopls installed."));
    return;
  }
  list.replaceChildren(...items.map(({ tab, marker }) => {
    const severity = marker.severity === monaco.MarkerSeverity.Error ? "error" : marker.severity === monaco.MarkerSeverity.Warning ? "warning" : "info";
    const row = element("button", "problem-row");
    const glyph = element("span", `problem-${severity}`);
    glyph.innerHTML = icon(severity);
    row.append(glyph, element("span", "", marker.message), element("span", "problem-location", `${tab.path}:${marker.startLineNumber}`));
    row.title = marker.message;
    row.addEventListener("click", () => { void openFile(tab.path, marker); });
    return row;
  }));
}

function tabControl(path: string, role: "close" | "main") {
  return byId("tabs").querySelector<HTMLButtonElement>(`.tab[data-tab-path="${CSS.escape(path)}"] .tab-${role}`);
}

function closeDocument(tab: DocumentTab, preserveNavigation = false) {
  const focused = document.activeElement;
  const restore = focused?.closest<HTMLElement>("#tabs .tab")?.dataset.tabPath === tab.path ||
    docs.active === tab && byId("editor").contains(focused);
  docs.close(tab, { focus: false, preserveNavigation });
  if (restore) {
    if (docs.active) docs.editor.focus();
    else btn("empty-quick-open").focus();
  }
}

async function askFileDecision(tab: DocumentTab, operation: "close" | "reload") {
  const dialog = byId<HTMLDialogElement>("file-decision-dialog");
  const focus = document.activeElement;
  const focusedTab = focus?.closest<HTMLElement>("#tabs .tab")?.dataset.tabPath;
  const focusRole = focus?.classList.contains("tab-close") ? "close" : "main";
  const closing = operation === "close";
  byId("file-decision-title").textContent = closing ? "Close unsaved file?" : "Reload unsaved file?";
  byId("file-decision-description").textContent = `You have unsaved changes to ${tab.path}.`;
  btn("file-decision-discard").textContent = closing ? "Discard" : "Reload and Discard";
  btn("file-decision-save").hidden = !closing;
  dialog.returnValue = "cancel";
  const choice = new Promise<string>(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true }));
  dialog.showModal();
  const result = await choice;
  if (focusedTab && !focus?.isConnected && (result === "cancel" || document.activeElement === document.body)) {
    tabControl(focusedTab, focusRole)?.focus();
  }
  return result;
}

function captureTab(tab: DocumentTab) {
  const projectAtStart = project;
  const version = tab.model.getVersionId();
  const revision = tab.reloadRevision;
  return (writes = 0) => project === projectAtStart && docs.tabs.get(tab.path) === tab &&
    version === tab.model.getVersionId() && revision + writes === tab.reloadRevision;
}

async function closeTab(tab: DocumentTab) {
  if (fileActionsBlocked() || tab.saving || tab.reloading !== undefined) return;
  if (!tab.dirty) { closeDocument(tab); return; }
  const release = reserveFileActivity();
  if (!release) return;
  const live = captureTab(tab);
  try {
    const choice = await askFileDecision(tab, "close");
    if (!live()) return;
    if (choice === "discard") {
      const thaw = projectWorkflow.reserve();
      if (!thaw) return;
      try { await drafts.discard(project.native, tab); if (live()) closeDocument(tab, true); }
      finally { thaw(); }
    } else if (choice === "save" && await saveDocument(tab) && live(1) && !tab.dirty) closeDocument(tab, true);
  } catch (error) { showError(new Error(`${tab.path}: ${message(error)}`)); }
  finally { release(); }
}

function saveFormatter(tab: DocumentTab, enabled: boolean) {
  if (!enabled || !project.native || !tab.path.endsWith(".go")) return undefined;
  return async (text: string) => {
    try { return await host.format(text); }
    catch (error) { throw new Error(`Could not format the buffer: ${message(error)}. Use Save Without Formatting to keep the original text.`); }
  };
}

async function saveActive(useFormatting = true) {
  if (fileActionsBlocked() || !docs.active) return;
  const tab = docs.active;
  const target = project;
  try {
    if (!tab.dirty) { status(`${basename(tab.path)} is saved`); return; }
    await saveDocument(tab, { format: saveFormatter(tab, useFormatting && input("format-save-setting").checked) });
  } catch (error) {
    if (project === target && docs.tabs.get(tab.path) === tab) showError(new Error(`${tab.path}: ${message(error)}`));
  }
}

async function saveDocument(tab: DocumentTab, options: SaveOptions = {}) {
  const target = project;
  if (!await docs.save(tab, options)) return false;
  await drafts.settled(tab);
  if (project !== target) return true;
  if (docs.active === tab) status(`Saved ${basename(tab.path)}`);
  if (/(^|\/)go\.(mod|work)$/.test(tab.path)) {
    await refresh();
    if (project === target) void runTargets.refresh();
  }
  if (project === target && view === "search") scheduleSearch();
  return true;
}

async function saveAllDocuments(ticket?: number, format = false) {
  const result = await saveDirtyTabs(() => [...docs.tabs.values()], tab => saveDocument(tab, { quitTicket: ticket, format: saveFormatter(tab, format) }),
    () => ticket === undefined || ticket > lastExpiredQuitTicket);
  if (result.committed.length) {
    feedback.row(`Saved: ${result.committed.join(", ")}`, "success", "check");
    status(`Saved ${result.committed.length} ${result.committed.length === 1 ? "file" : "files"}`);
  }
  if (result.issue) showError(new Error(result.issue));
  return !result.issue && !docs.dirty;
}

async function saveAll() {
  const release = reserveFileActivity();
  if (!release) return;
  try {
    if (!docs.dirty) status("No unsaved files");
    else await saveAllDocuments(undefined, input("format-save-setting").checked);
  } finally { release(); }
}

async function compareWithDisk() {
  const tab = docs.active;
  const target = project;
  const inspect = target.inspect;
  if (!tab || !inspect || tab.reloading !== undefined) return;
  const release = reserveFileActivity();
  if (!release) return;
  const unhold = docs.holdDiskReview(tab);
  const current = captureTab(tab);
  const staleEditor = () => new Error("This editor has changed. Compare again to review the current buffer.");
  try {
    const decision = await showDiskComparison({
      path: tab.path, language: tab.model.getLanguageId(), buffer: bufferText(tab.model),
      dirty: tab.dirty, current, load: () => inspect(tab.path),
    });
    if (!decision) return;
    if (!current()) throw staleEditor();
    if (decision.action === "save") await saveDocument(tab, { reviewed: decision.observed });
    else {
      if (!await reloadDocument(tab, decision.observed)) throw staleEditor();
      if (docs.active === tab) status(`Reloaded ${basename(tab.path)}`);
    }
  } catch (error) { if (project === target) showError(error); }
  finally {
    unhold();
    release();
    if (document.activeElement === document.body && docs.active === tab) docs.editor.focus();
  }
}

function saveToNewPath() {
  const tab = docs.active;
  const target = project;
  if (!tab || !target.createFromBuffer) return;
  const release = reserveFileActivity();
  if (!release) return;
  byId("form-dialog").addEventListener("close", release, { once: true });
  forms.show({
    title: "Save to a New Path", description: `Save the buffer for ${tab.path} to a new file without changing the existing path.`,
    submit: "Save New File", fields: [{ name: "path", label: "Workspace-relative destination", placeholder: "recovered.txt" }],
    async run({ path }) {
      if (project !== target) return false;
      validateRelative(path);
      const rebound = await docs.saveToNew(tab, path);
      if (rebound && target === project) {
        drafts.schedule(project.native, rebound, true);
        await drafts.settled(rebound);
        if (!rebound.dirty || drafts.recorded(rebound)) await drafts.discard(project.native, tab).catch(showError);
      }
      if (!rebound) return false;
      revealParents(rebound.path);
      rootExpanded = true;
      await refresh();
      if (view === "search") scheduleSearch();
      status(`Saved ${rebound.path}`);
    },
  });
}

async function recoverDrafts(manage = false) {
  const target = project;
  const folder = manage ? undefined : target.native;
  const dialog = byId<HTMLDialogElement>("draft-dialog");
  if ((!folder && !manage) || fileActionsBlocked() || document.querySelector("dialog[open]")) return;
  const list = byId("draft-list");
  const note = byId("draft-dialog-note");
  const current = () => project === target && dialog.open;

  async function load() {
    note.textContent = "Reading local recovery drafts…";
    list.replaceChildren();
    const records = await host.listDrafts(folder?.id);
    if (!current()) return;
    note.textContent = manage ? (records.length ? "Remove detached drafts for any project, including projects that no longer exist." : "No detached drafts are stored.") :
      (records.length ? "Choose a draft to recover as an unsaved buffer. Detached drafts can also be removed." : "No drafts were recorded for this project.");
    for (const draft of records) {
      const row = element("div", "draft-row");
      if (folder) {
        const recover = element("button", "button quiet", draft.path);
        recover.type = "button";
        recover.addEventListener("click", () => { void restore(folder, draft).catch(report); });
        row.append(recover);
      } else row.append(element("span", "view-note", `${draft.projectPath}/${draft.path}`));
      row.append(element("span", "view-note", `${new Date(draft.modified).toLocaleString()} · ${draft.detached ? "Detached writer" : "Open writer"}`));
      if (draft.detached) {
        const remove = element("button", "button quiet", "Remove Draft");
        remove.type = "button";
        remove.addEventListener("click", () => {
          if (remove.dataset.confirm !== "true") {
            remove.dataset.confirm = "true";
            remove.textContent = "Confirm Removal";
            return;
          }
          remove.disabled = true;
          void host.removeDraft(folder?.id, draft).then(load).catch(error => { remove.disabled = false; report(error); });
        });
        row.append(remove);
      }
      list.append(row);
    }
  }

  function report(error: unknown) { if (current()) note.textContent = message(error); else if (project === target) showError(error); }

  async function restore(folder: NativeFolder, draft: DraftItem) {
    const { payload, observed } = await host.recoverDraft(folder.id, draft);
    if (!current()) return;
    if (observed.kind === "retry") throw new Error("This file changed while reading. Try recovering again.");
    const tab = docs.tabs.get(draft.path);
    if (tab?.dirty) {
      const live = captureTab(tab);
      dialog.close();
      await showDiskComparison({ path: draft.path, language: tab.model.getLanguageId(), buffer: bufferText(tab.model), dirty: false,
        readOnly: { original: "Recovery draft", modified: "Open editor" }, current: live,
        load: async () => ({ kind: "text", text: payload.text, version: payload.version }) });
      if (live()) docs.editor.focus();
      return;
    }
    docs.recover(draft.path, payload.text, { kind: "text", text: payload.baseline, version: payload.version }, observed);
    dialog.close();
    docs.editor.focus();
    status(`Recovered ${draft.path} as an unsaved buffer`);
  }

  byId("draft-title").textContent = manage ? "Manage Recovery Drafts" : "Recover Drafts";
  dialog.showModal();
  await load().catch(report);
}

async function reloadActive() {
  const tab = docs.active;
  if (!tab || tab.saving || fileActionsBlocked()) return;
  const target = project;
  const release = reserveFileActivity();
  if (!release) return;
  const live = captureTab(tab);
  try {
    if (tab.dirty && await askFileDecision(tab, "reload") !== "discard") return;
    if (live() && await reloadDocument(tab) && project === target && docs.active === tab) status(`Reloaded ${basename(tab.path)}`);
  }
  catch (error) { if (project === target && docs.active === tab) showError(error); }
  finally { release(); }
}

async function reloadDocument(tab: DocumentTab, reviewed?: ReadableDisk) {
  if (!project.native || !tab.dirty) return docs.reload(tab, reviewed);
  const folder = project.native;
  const thaw = projectWorkflow.reserve();
  if (!thaw) return false;
  try { return await docs.reload(tab, reviewed, () => drafts.discard(folder, tab, reviewed)); }
  finally { thaw(); }
}

async function formatActive() {
  const tab = docs.active;
  if (!tab?.path.endsWith(".go") || formatting || fileActionsBlocked()) return;
  if (!desktop) { toast("Go formatting uses gofmt in the macOS desktop app."); return; }
  const target = project;
  formatting = true;
  syncControls();
  try {
    if (await docs.format(tab, host.format) && project === target && docs.active === tab) status(`Formatted ${basename(tab.path)} with gofmt`);
  } catch (error) { if (project === target && docs.active === tab) showError(error); }
  finally { formatting = false; syncControls(); }
}

async function organizeImports() {
  const tab = docs.active;
  const service = lsp;
  if (!tab || tab.model.getLanguageId() !== "go" || !service || gopls !== "ready") {
    toast("Open a Go file with gopls running to organize imports.");
    return;
  }
  if (fileActionsBlocked() || filesBusy()) return;
  const live = captureTab(tab);
  let release: (() => void) | undefined;
  try {
    const edits = await service.organizeImports(tab.model);
    if (docs.active !== tab || lsp !== service) return;
    if (!live()) { status("Imports were not changed because the buffer changed"); return; }
    if (!edits) { status("No applicable Go import edits"); return; }
    release = reserveFileActivity();
    if (!release) return;
    status(applyExactTextEdits(tab.model, edits) ? `Organized imports in ${basename(tab.path)}` : "Go imports are already organized");
  } catch (error) { if (docs.active === tab && lsp === service) showError(error); }
  finally { release?.(); }
}

function renameGoSymbol() {
  const origin = docs.active;
  const position = docs.editor.getPosition();
  const target = project;
  const folder = target.native;
  if (!origin || !position || !folder || !lsp || gopls !== "ready" || origin.model.getLanguageId() !== "go") {
    toast("Open a Go file with gopls running to rename a symbol.");
    return;
  }
  if (fileActionsBlocked() || filesBusy()) return;
  const sameOrigin = captureTab(origin);
  forms.show({
    title: "Rename Go Symbol", description: "Enter a new name to review workspace changes.", submit: "Preview Rename",
    fields: [{ name: "name", label: "New name" }],
    async run({ name }) {
      if (!/^[\p{L}_][\p{L}\p{Nd}_]*$/u.test(name)) throw new Error("Enter a Go identifier.");
      byId("form-dialog").addEventListener("close", () => { void previewRename(name); }, { once: true });
    },
  });

  async function previewRename(name: string) {
    if (!sameOrigin() || docs.active !== origin) return;
    const release = reserveFileActivity();
    if (!release) return;
    const cancellation = new CancellationTokenSource();
    let active = true;
    let service: GoLanguage | undefined;
    let deadline: number | undefined;
    const current = () => active && project === target && (!service || lsp === service);
    try {
      const preparing = prepareGoRename({
        project: target, docs, origin: origin!, position: position!, name, current, token: cancellation.token,
        async start() {
          navigation?.cancel();
          lsp?.dispose();
          service = createGoLanguage(folder!);
          await service.start();
          if (lsp !== service || gopls !== "ready") throw new Error("gopls could not initialize for the rename.");
          return service;
        },
      });
      const load = Promise.race([preparing, new Promise<never>((_, reject) => {
        deadline = window.setTimeout(() => reject(new Error("gopls did not prepare the rename in time.")), 30_000);
      })]).finally(() => window.clearTimeout(deadline));
      const plan = await reviewGoRename(load);
      if (plan) {
        const files = await plan.apply();
        status(`Renamed symbol in ${files} ${files === 1 ? "buffer" : "buffers"}`);
      }
    } catch (error) { if (project === target) showError(error); }
    finally {
      active = false;
      window.clearTimeout(deadline);
      cancellation.cancel();
      cancellation.dispose();
      release();
      if (docs.active === origin && document.activeElement === document.body) docs.editor.focus();
    }
  }
}

function refresh() {
  if (mutatingPaths) return Promise.resolve(false);
  return snapshots.refresh(project, {
    current: () => project,
    read: target => target.snapshot(),
    apply(result) {
      const packagesChanged = snapshot.packageRevision !== undefined && result.packageRevision !== snapshot.packageRevision;
      const treeChanged = result.truncated !== snapshot.truncated || result.module !== snapshot.module || result.goWork !== snapshot.goWork ||
        result.entries.length !== snapshot.entries.length || result.entries.some((entry, index) => {
          const previous = snapshot.entries[index];
          return entry.path !== previous.path || entry.directory !== previous.directory;
        });
      snapshot = result;
      if (treeChanged) {
        tree = makeTree(result.entries);
        renderExplorer();
        palette.refreshFiles();
      }
      if (packagesChanged) void runTargets.refresh();
    },
    fail: showError,
  });
}

function watchProject(target: Project) {
  const folder = target.native;
  if (!folder) return;
  let pending = false;
  let treePending = false;
  let running: Promise<void> | undefined;

  function request(tree = false) {
    if (project !== target || mutatingPaths) return Promise.resolve();
    pending = true;
    treePending ||= tree;
    return running ??= reconcile();
  }

  async function reconcile() {
    try {
      await new Promise(resolve => window.setTimeout(resolve, 120));
      if (project !== target) return;
      pending = false;
      const updateTree = treePending;
      treePending = false;
      if (updateTree) await refresh();
      for (const tab of [...docs.tabs.values()]) {
        if (project !== target) return;
        if (!await docs.reconcile(tab)) pending = true;
      }
    } catch (error) {
      if (project === target) showError(error);
    } finally {
      running = undefined;
      if (pending && project === target) void request();
    }
  }

  refreshDisk = request;
  void (async () => {
    await host.startWatch(folder.id);
    let revision = 0;
    while (project === target) {
      await request(true);
      if (project !== target) return;
      const observed = await host.waitWatch(folder.id, revision);
      if (observed === null) return;
      revision = observed;
    }
  })().catch(error => {
    if (project !== target) return;
    feedback.row(message(error), "quiet", "info");
    toast("File watching is unavailable. Use Refresh Project to check for changes.", true);
    return request(true);
  });
}

function queueEditorSession() {
  if (!project.native || restoringSession || failedSessionRestore === project) return;
  sessionDirty = true;
  clearTimeout(sessionTimer);
  if (import.meta.env.VITE_IRON_E2E === "1" && holdSessionDebounce) return;
  if (!sessionWrite) sessionTimer = window.setTimeout(() => { void flushEditorSession(); }, 280);
}

async function flushEditorSession(quitTicket?: number) {
  clearTimeout(sessionTimer);
  sessionDirty = false;
  const folder = project.native;
  if (!folder || restoringSession || failedSessionRestore === project) return;
  const snapshot = docs.captureSession();
  const revision = ++sessionRevision;
  await sessionWrite;
  if (project.native !== folder || revision !== sessionRevision || (quitTicket !== undefined && quitTicket <= lastExpiredQuitTicket)) return;
  const write = host.writeEditorSession(folder.id, revision, snapshot, quitTicket).catch(error => {
    if (project.native === folder && (quitTicket === undefined || quitTicket > lastExpiredQuitTicket)) showError(error);
  });
  sessionWrite = write;
  try { await write; }
  finally {
    if (sessionWrite === write) sessionWrite = undefined;
    if (sessionDirty) queueEditorSession();
  }
}

async function install(target: Project) {
  const generation = ++sessionInstall;
  clearTimeout(sessionTimer);
  sessionDirty = false;
  restoringSession = true;
  try { await installProject(target); }
  finally {
    if (sessionInstall === generation) { restoringSession = false; queueEditorSession(); }
  }
}

async function installProject(target: Project) {
  navigation?.cancel();
  feedback.hide("references");
  execution.retire()?.retire();
  terminal.reset();
  renderDebugInspection();
  clearExecutionLine();
  breakpoints.reset();
  const previousLsp = lsp;
  refreshDisk = undefined;
  lsp = undefined;
  project = target;
  explorerSelection = undefined;
  failedSessionRestore = undefined;
  drafts.reset();
  previousLsp?.dispose();
  runTargets.reset(target);
  gopls = "idle";
  searchGeneration++;
  window.clearTimeout(searchTimer);
  input("search-text").value = "";
  btn("search-case").setAttribute("aria-pressed", "false");
  byId("search-results").replaceChildren();
  byId("search-status").textContent = "Enter a term to search the workspace.";
  snapshot = { entries: [], truncated: false, module: null, goWork: false };
  tree = [];
  opened = new Set();
  rootExpanded = true;
  docs.reset(target);
  byId("status-project").textContent = target.name;
  byId("quick-label").textContent = target.welcome ? "Search commands" : `Search files in ${target.name}`;
  const commandName = target.welcome ? "Search commands" : "Go to File";
  btn("quick-open").title = `${commandName} (⌘P)`;
  btn("quick-open").setAttribute("aria-label", commandName);
  feedback.clear();
  feedback.clearTests();
  if (target.welcome) feedback.toggle(false); else feedback.show("output");
  chooseView("explorer", false);
  status("Opening workspace…");
  const indexed = await refresh();
  if (target !== project) return;
  if (target.native) void runTargets.refresh();
  const saved = target.native?.editorSession;
  if (!indexed) failedSessionRestore = target;
  const restored = saved && indexed ? await docs.restoreSession(saved,
    new Set(snapshot.entries.filter(entry => !entry.directory).map(entry => entry.path)), () => project === target) : undefined;
  if (target !== project) return;
  if (restored?.opened && docs.active) revealParents(docs.active.path);
  const initial = restored?.opened ? undefined : initialWorkspaceFile(snapshot.entries);
  if (initial) {
    try { await docs.open(initial); revealParents(initial); }
    catch (error) { if (target === project) showError(error); }
  }
  if (target !== project) return;
  renderExplorer();
  if (!target.welcome) {
    feedback.row(`Project opened: ${target.name}`, "success", "check");
    feedback.row(target.native ? target.native.path : "Imported as a copy. Edits stay in memory and do not write to disk.", "quiet", "info");
  }
  status(target.welcome ? "Open or create a project" : target.native ? "Ready" : "Browser copy");
  updateTools();
  maybeStartLsp();
  watchProject(target);
  if (target.native?.recentError) showError(target.native.recentError);
  else if (restored?.skipped) toast(`Skipped ${restored.skipped} missing or unavailable ${restored.skipped === 1 ? "editor tab" : "editor tabs"}.`);
}

const transitionReady = () => !filesBusy() && !execution.preparing;

async function confirmTransition() {
  const warnings = [
    docs.dirty && "This project has unsaved edits.",
    execution.task && "The current Go task will be stopped.",
    execution.debug && "The debug session will be stopped.",
    terminal.active && "The active terminal and its foreground job will be stopped.",
  ].filter(Boolean);
  if (!warnings.length) return true;
  const dialog = byId<HTMLDialogElement>("project-transition-dialog");
  byId("project-transition-description").textContent = warnings.join(" ");
  btn("project-transition-save").hidden = !docs.dirty;
  btn("project-transition-continue").textContent = docs.dirty ? "Discard and Continue" : "Continue";
  dialog.returnValue = "cancel";
  dialog.showModal();
  const choice = await new Promise<string>(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true }));
  return choice === "continue" || (choice === "save" && await saveAllDocuments());
}

function changeProject(choose: () => Promise<Project | undefined>) {
  return projectWorkflow.transition({ ready: transitionReady, confirm: confirmTransition,
    choose: async () => { await flushEditorSession(); return choose(); }, install });
}

function openFolder() {
  if (!desktop) {
    if (transitionReady() && !projectWorkflow.busy) input("import-folder").click();
    return;
  }
  void changeProject(async () => {
    const folder = await host.open(drafts.plan(project.native));
    return folder ? nativeProject(folder) : undefined;
  }).catch(showError);
}

function closeProject() {
  const target = project;
  if (target.welcome) return;
  void changeProject(async () => {
    if (target.native) await host.close(target.native.id, drafts.plan(target.native));
    return welcomeProject();
  }).catch(showError);
}

async function showRecentProjects() {
  if (!desktop || projectWorkflow.busy || document.querySelector("dialog[open]")) return;
  const dialog = byId<HTMLDialogElement>("recent-dialog");
  const list = byId("recent-list");
  const note = byId("recent-note");
  const clear = btn("clear-recent");
  let reading = 0;
  const report = (error: unknown) => { if (dialog.open) note.textContent = message(error); };
  const forget = async (control: HTMLButtonElement, entry?: string) => {
    if (control.dataset.confirm !== "true") {
      control.dataset.confirm = "true";
      control.textContent = entry ? "Confirm Removal" : "Confirm Clear History";
      return;
    }
    control.disabled = true;
    try { await host.forgetRecent(entry); await load(); }
    catch (error) { report(error); }
    finally { control.disabled = false; }
  };
  async function load() {
    const revision = ++reading;
    list.replaceChildren();
    note.textContent = "Reading recent projects…";
    delete clear.dataset.confirm;
    clear.textContent = "Clear History";
    const projects = await host.listRecent();
    if (!dialog.open || reading !== revision) return;
    note.textContent = projects.length ? "Choose a project to reopen its last saved editor session." : "No recent projects.";
    for (const entry of projects) {
      const row = element("div", "draft-row");
      const open = element("button", "button quiet recent-open", entry.name);
      open.title = entry.path;
      open.addEventListener("click", () => {
        dialog.close();
        void changeProject(async () => nativeProject(await host.openRecent(entry.id, drafts.plan(project.native)))).catch(showError);
      });
      const remove = element("button", "button quiet recent-remove", "Remove from Recent");
      remove.addEventListener("click", () => { void forget(remove, entry.id); });
      row.append(open, element("span", "view-note", entry.path), remove);
      list.append(row);
    }
  }
  const clearHistory = () => { void forget(clear); };
  clear.addEventListener("click", clearHistory);
  dialog.addEventListener("close", () => clear.removeEventListener("click", clearHistory), { once: true });
  dialog.showModal();
  await load().catch(report);
}

function newModule() {
  if (!desktop) { toast("Creating a Go project on disk requires the macOS desktop app."); return; }
  forms.show({
    title: "New Project", description: "Create a Go module with a starter main.go. Choose your project name and module path.", submit: "Choose Location…",
    fields: [
      { name: "name", label: "Project name", value: "hello-go", maxLength: 80 },
      { name: "module", label: "Go module path", value: "example.com/hello-go", maxLength: 240 },
    ],
    async run({ name, module }) {
      return changeProject(async () => {
        const folder = await host.create(name, module, drafts.plan(project.native));
        return folder ? nativeProject(folder) : undefined;
      });
    },
  });
}

function newFile() {
  if (fileActionsBlocked() || project.welcome) return;
  const target = project;
  forms.show({
    title: "New File", description: `Create a file inside ${project.name}. Include a folder prefix to create missing folders.`,
    fields: [{ name: "path", label: "Relative file path", placeholder: "pkg/example.go" }],
    async run({ path }) {
      if (fileActionsBlocked()) return false;
      if (target !== project) throw new Error("This workspace has changed.");
      validateRelative(path);
      fileMutations++;
      syncControls();
      try {
        await target.createFile(path);
        await refresh();
        await openFile(path);
        status(`Created ${path}`);
      } finally { fileMutations--; syncControls(); }
    },
  });
}

async function fileOperation(kind: "folder" | "rename" | "move" | "trash") {
  const folder = project.native;
  if (!folder || projectWorkflow.busy || fileActionsBlocked() || filesBusy() || execution.occupied) return;
  const selected = snapshot.entries.find(entry => entry.path === explorerSelection);
  const source = selected?.path ?? docs.active?.path;
  if (kind !== "folder" && !source) { toast("Select an Explorer item or open a file first."); return; }
  const confirmed = kind === "folder" ? undefined : await host.inspectFileOperation(folder.id, source!);
  if (project.native !== folder) return;
  const release = reserveFileActivity();
  if (!release) return;
  const parent = selected?.directory ? selected.path : source ? dirname(source) : "";
  const dirty = source ? [...docs.tabs.values()].filter(tab => tab.dirty && inPath(tab.path, source)).length : 0;
  byId("form-dialog").addEventListener("close", release, { once: true });
  const verb = kind === "folder" ? "New Folder" : kind === "rename" ? "Rename" : kind === "move" ? "Move" : "Move to Trash";
  forms.show({
    title: verb,
    description: kind === "folder" ? "Create a folder at a workspace-relative path." :
      `${verb} ${source}.${kind === "trash" && dirty ? ` This discards unsaved edits in ${dirty} ${dirty === 1 ? "buffer" : "buffers"}.` : ""}`,
    submit: kind === "trash" && dirty ? "Discard and Move to Trash" : verb,
    fields: kind === "trash" ? [] : [{ name: "destination", label: kind === "rename" ? "New name" : "Workspace-relative path",
      value: kind === "rename" ? basename(source!) : kind === "folder" && parent ? `${parent}/` : undefined }],
    async run({ destination }) {
      if (project.native !== folder || execution.occupied) return false;
      if (kind === "trash") return mutateFiles(folder, { kind: "trash", source: source!, version: confirmed!.version, revision: drafts.plan(folder)!.revision });
      if (kind === "rename" && destination.includes("/")) throw new Error("Enter a name without a folder path.");
      const path = kind === "rename" && dirname(source!) ? `${dirname(source!)}/${destination}` : destination;
      validateRelative(path);
      if (kind === "folder") return mutateFiles(folder, { kind: "new_folder", path });
      return mutateFiles(folder, { kind: "move", source: source!, destination: path, version: confirmed!.version,
        revision: drafts.plan(folder)!.revision, baselines: [] });
    },
  });
}

async function mutateFiles(folder: NativeFolder, operation: WorkspaceMutation) {
  const release = projectWorkflow.reserve();
  if (!release) return false;
  const resumeDrafts = drafts.freeze();
  let releasePaths: (() => void) | undefined;
  let affected: DocumentTab[] = [];
  mutatingPaths = true;
  snapshots.invalidate();
  navigation?.cancel();
  cursorTestLookup.invalidate();
  try {
    if (operation.kind !== "new_folder") {
      const reservation = docs.reservePaths(operation.source, operation.kind === "move" ? operation.destination : undefined);
      affected = reservation.affected;
      releasePaths = reservation.release;
      if (operation.kind === "move") {
        operation.baselines = affected.flatMap(tab => tab.diskVersion ? [{ path: tab.path, version: tab.diskVersion }] : []);
      }
    }
    const { outcome, warning } = await host.mutateWorkspace(folder.id, operation);
    if (folder !== project.native) return false;
    if (operation.kind !== "new_folder") drafts.forget(affected);
    if (outcome.kind === "moved" && operation.kind === "move") {
      breakpoints.rebind(operation.source, outcome.path);
      const rebound = docs.rebindPaths(operation.source, outcome.path, outcome.versions, affected);
      for (const tab of rebound) drafts.schedule(folder, tab, true);
      const mapped = [...opened].filter(path => inPath(path, operation.source));
      for (const path of mapped) { opened.delete(path); opened.add(`${outcome.path}${path.slice(operation.source.length)}`); }
      explorerSelection = outcome.path;
      revealParents(outcome.path);
      status(`Moved ${operation.source} to ${outcome.path}`);
    } else if (outcome.kind === "trashed" && operation.kind === "trash") {
      for (const tab of affected) docs.close(tab, { focus: false });
      breakpoints.rebind(operation.source);
      for (const path of [...opened]) if (inPath(path, operation.source)) opened.delete(path);
      explorerSelection = undefined;
      status(`Moved ${operation.source} to Trash`);
    } else if (outcome.kind === "stranded" || outcome.kind === "unverified_move") {
      docs.requirePathReview(affected);
      for (const tab of affected) drafts.schedule(folder, tab, true);
      showError(outcome.kind === "stranded" ? `Trash did not complete. The original item is at ${outcome.path}. ${outcome.error}` :
        `The rename ran but its destination could not be verified at ${outcome.path}. Open buffers and drafts were retained. ${outcome.error}`);
    } else if (outcome.kind === "folder") {
      explorerSelection = outcome.path;
      revealParents(outcome.path);
      status(`Created ${outcome.path}`);
    }
    if (warning) showError(warning);
    return true;
  } finally {
    mutatingPaths = false;
    releasePaths?.();
    resumeDrafts();
    release();
    if (folder === project.native) { await refresh(); void refreshDisk?.(); void runTargets.refresh(); }
  }
}

function chooseView(next: View, focus = true) {
  const reopen = workbench.classList.contains("sidebar-closed");
  showSidebar(true);
  view = next;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    const active = button.dataset.view === next;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    byId(`${button.dataset.view}-view`).hidden = !active;
  }
  if (next === "search") { scheduleSearch(); if (focus || reopen) input("search-text").focus(); }
  else if (next === "explorer" && (focus || reopen)) {
    const rows = explorerButtons();
    (rows.find(row => row.dataset.path === (explorerSelection ?? docs.active?.path)) ?? rows[0])?.focus();
  }
}

function explorerButtons() { return [...byId("explorer").querySelectorAll<HTMLButtonElement>("button")]; }

byId("explorer").addEventListener("keydown", event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || projectWorkflow.busy) return;
  const rows = explorerButtons();
  const at = rows.findIndex(row => row === event.target);
  if (at < 0) return;
  const row = rows[at];
  let next: HTMLButtonElement | undefined;
  switch (event.key) {
    case "ArrowUp": next = rows[Math.max(at - 1, 0)]; break;
    case "ArrowDown": next = rows[Math.min(at + 1, rows.length - 1)]; break;
    case "Home": next = rows[0]; break;
    case "End": next = rows.at(-1); break;
    case "ArrowRight":
      if (row.getAttribute("aria-expanded") === "false") row.click();
      else if (row.getAttribute("aria-expanded") === "true") {
        const child = rows[at + 1];
        if (child && (!row.dataset.path || child.dataset.path?.startsWith(`${row.dataset.path}/`))) next = child;
      }
      break;
    case "ArrowLeft":
      if (row.getAttribute("aria-expanded") === "true") row.click();
      else if (row.dataset.path) next = rows.find(parent => parent.dataset.path === dirname(row.dataset.path!)) ?? rows[0];
      break;
    default: return;
  }
  event.preventDefault();
  next?.focus();
});

function showSidebar(visible: boolean) {
  workbench.classList.toggle("sidebar-closed", !visible);
  btn("toggle-sidebar").setAttribute("aria-pressed", String(visible));
  docs.layout();
}

function toggleSidebar() { showSidebar(workbench.classList.contains("sidebar-closed")); }

function scheduleSearch() {
  const generation = ++searchGeneration;
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => { void search(generation); }, 160);
}

async function search(generation: number) {
  const target = project;
  const query = input("search-text").value;
  const count = byId("search-status");
  const list = byId("search-results");
  list.replaceChildren();
  if (!query) { count.textContent = "Enter a term to search the workspace."; return; }
  count.textContent = "Searching saved files…";
  try {
    const result = await target.search(query, btn("search-case").getAttribute("aria-pressed") === "true");
    if (generation !== searchGeneration || target !== project) return;
    const found = result.matches.length;
    count.textContent = `${found ? `${found} ${found === 1 ? "match" : "matches"}` : "No matches"}${result.truncated ? " · limited results" : ""}`;
    list.replaceChildren(...result.matches.map(searchRow));
  } catch (error) {
    if (generation === searchGeneration && target === project) count.textContent = message(error);
  }
}

function searchRow(result: FileMatch) {
  const row = element("button", "search-result");
  row.dataset.path = result.path;
  row.title = `${result.path}:${result.line}:${result.column}`;
  row.innerHTML = fileIcon(result.path);
  const label = element("span");
  label.append(element("span", "search-filename", `${basename(result.path)}:${result.line}`), element("span", "search-preview", result.preview));
  row.append(label);
  row.addEventListener("click", () => {
    void openFile(result.path, new monaco.Range(result.line, result.column, result.line, result.column + result.length));
  });
  return row;
}

async function runTask(kind: TaskKind, singleTest?: { path: string; name: string }, rerun?: { package: string; importPath: string; name: string }) {
  if (execution.occupied || projectWorkflow.busy || filesBusy()) return;
  const target = project.native;
  if (!target) {
    toast(desktop ? "Open or create a Go project first." : "Run, build and test are available in the macOS desktop app.");
    return;
  }
  if (!tools?.goVersion) { toast("Install Go, then check the toolchain in Settings.", true); return; }
  let packages: string[];
  let configured: ReturnType<RunTargets["configuredLaunch"]>;
  try {
    configured = kind === "run" ? runTargets.configuredLaunch() : undefined;
    packages = rerun ? [rerun.package] : singleTest ? [packageForFile(singleTest.path)]
      : configured ? [configured.package] : kind === "run" ? runTargets.runArguments() : runTargets.buildTestArguments(docs.active?.path);
  } catch (error) { showError(error); return; }
  feedback.show("output");
  status(`Preparing Go ${kind}…`);
  const packagePaths = runTargets.testPackagePaths();
  const testContext = kind === "test" ? {
    expected: rerun && { package: rerun.importPath, name: rerun.name },
    rerun(importPath: string, name: string) {
      const directory = packagePaths.get(importPath);
      const parts = name.split("/");
      const root = parts[0];
      const suffix = root.startsWith("Test") ? root.slice(4) : undefined;
      const encoder = new TextEncoder();
      if (!directory || directory.includes("...") || suffix === undefined || /^\p{Ll}/u.test(suffix) ||
          !/^[\p{Alphabetic}\p{Number}_]*$/u.test(suffix) || /\p{Cc}/u.test(name) || parts.length > 32 ||
          encoder.encode(name).length > 1024 || encoder.encode(root).length > 200) return;
      return () => {
        if (project.native === target) void runTask("test", undefined, { package: directory, importPath, name });
      };
    },
  } : undefined;
  try {
    await execution.start(target, kind, saveBarrier, token => host.task(target.id, kind, packages, rerun?.name ?? singleTest?.name, event => {
      if (project.native !== target || !execution.taskEvent(token, event.type)) return;
      const result = feedback.task(event, testContext);
      if (event.type === "started") {
        status(`Go ${kind} running…`);
      } else if (event.type === "finished") {
        status(result ?? "Ready");
      }
    }, configured?.launch, rerun?.importPath));
  } catch (error) {
    if (project.native !== target) return;
    status(`Go ${kind} not started`);
    feedback.row(message(error), "error", "error");
    showError(error);
  }
}

function clearExecutionLine() {
  if (executionLine && !executionLine.model.isDisposed()) executionLine.model.deltaDecorations(executionLine.ids, []);
  executionLine = undefined;
}

function renderDebugInspection(state?: DebugInspectionState) {
  const tab = byId("debug-tab");
  const focused = document.activeElement;
  debugInspection.render(state);
  if (state && tab.hidden) {
    tab.hidden = false;
    feedback.show("debug");
  } else if (!state && !tab.hidden) feedback.hide("debug", focused && !focused.isConnected ? tab : focused);
}

function toggleBreakpoint(line = docs.editor.getPosition()?.lineNumber) {
  const tab = docs.active;
  if (projectWorkflow.busy || !project.native || !tab?.path.endsWith(".go") || !line) return;
  breakpoints.toggle(tab, line);
  docs.refreshView();
  const debug = execution.debug;
  if (debug?.ready) void debug.setBreakpoints(tab.path).catch(error => { if (execution.debug === debug) showError(error); });
}

function debugTest(path: string, name: string) { return startDebug({ path, name }); }

async function debugProgram() {
  if (!project.native || execution.occupied || projectWorkflow.busy || filesBusy()) return;
  if (!tools?.goVersion) { toast("Install Go, then check the toolchain in Settings.", true); return; }
  try {
    const configured = runTargets.configuredLaunch();
    const packageName = configured?.package ?? runTargets.runArguments()[0];
    await startDebug({ package: packageName, launch: configured?.launch ?? { directory: ".", args: [], environment: {} } });
  } catch (error) { showError(error); }
}

async function startDebug(target: { path: string; name: string } | { package: string; launch: RunLaunch }) {
  const folder = project.native;
  if (!folder || execution.occupied || projectWorkflow.busy || filesBusy()) return;
  if (!tools?.delve) {
    toast("Install Delve with `brew install delve`, then select Check tools in Settings.", true);
    return;
  }
  const name = "package" in target ? target.package : target.name;
  try {
    await execution.start(folder, "debug", saveBarrier, async token => {
      const isCurrent = () => execution.owns(token) && project.native === folder;
      const session = new DebugSession(folder, breakpoints, {
        isCurrent,
        admitted() { if (isCurrent()) syncControls(); },
        pauseReady() {
          if (!isCurrent()) return;
          clearExecutionLine();
          status("Paused — loading call stack…");
          syncControls();
        },
        inspection(state) {
          if (isCurrent()) renderDebugInspection(state);
        },
        paused(file, line, reason, currentSelection, focus) {
          const current = () => isCurrent() && currentSelection();
          if (!current()) return;
          void (async () => {
            clearExecutionLine();
            const indexed = file && snapshot.entries.some(entry => entry.path === file && !entry.directory);
            const tab = indexed && line >= 1 ? await docs.open(file, { focus, target: { lineNumber: line, column: 1 }, current }).catch(() => undefined) : undefined;
            if (!current()) return;
            const prefix = reason === "breakpoint" ? "Breakpoint hit" : "Paused";
            if (tab && line <= tab.model.getLineCount()) {
              const ids = tab.model.deltaDecorations([], [{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: "debug-execution-line" } }]);
              executionLine = { model: tab.model, ids };
              status(`${prefix} — ${basename(tab.path)}:${line}`);
            } else {
              status(`${prefix} — source unavailable`);
            }
          })();
        },
        running() {
          if (!isCurrent()) return;
          clearExecutionLine();
          status(`Debugging ${name}…`);
          syncControls();
        },
        closing() {
          if (!isCurrent()) return;
          clearExecutionLine();
          syncControls();
        },
        finished(reason) {
          if (!isCurrent() || !execution.release(token)) return;
          clearExecutionLine();
          breakpoints.clearVerification();
          status(reason);
          feedback.row(reason, reason.startsWith("Debug failed") ? "error" : "quiet");
        },
        output(value) { if (isCurrent() && value.trim()) feedback.row(value.trimEnd()); },
        build(event) { if (isCurrent()) feedback.task(event); },
        stopError(error) { if (isCurrent()) { showError(error); syncControls(); } },
      });
      if (!execution.attachDebug(token, session)) return;
      feedback.clear();
      feedback.show("output");
      feedback.row(`Launching ${name} with Delve…`, "command", "command");
      status(`Launching ${name}…`);
      if ("package" in target) await session.startProgram(target.package, target.launch);
      else await session.start(target.path, target.name);
    });
  } catch (error) { if (project.native === folder) showError(error); }
}

async function stopTask() {
  if (projectWorkflow.busy) return;
  try { await execution.stopTask(target => terminal.isGo(target) ? terminal.stop() : host.stop(target.id)); }
  catch (error) { showError(error); }
}

async function startShell() {
  const folder = project.native;
  if (!folder || projectWorkflow.busy) return;
  await terminal.start(folder, { kind: "shell" });
}

async function runInTerminal() {
  const folder = project.native;
  if (!folder || execution.occupied || projectWorkflow.busy || filesBusy()) return;
  if (terminal.active) { toast("Close the active terminal before starting a Go program there."); return; }
  if (!tools?.goVersion) { toast("Install Go, then check the toolchain in Settings.", true); return; }
  const configured = runTargets.configuredLaunch();
  const packageName = configured?.package ?? runTargets.runArguments()[0];
  const launch = configured?.launch ?? { directory: ".", args: [], environment: {} };
  await execution.start(folder, "run", saveBarrier, token => terminal.start(folder, { kind: "go", package: packageName, launch }, {
    started() { if (execution.taskEvent(token, "started")) status("Go program owns the terminal…"); },
    build(event) { if (execution.owns(token)) feedback.task(event); },
    closed(reason) { if (execution.taskEvent(token, "finished")) status(reason); },
  }));
}

async function closeTerminal() {
  if (projectWorkflow.busy || document.querySelector("dialog[open]")) return;
  if (!terminal.active) { await terminal.stop(true); return; }
  const dialog = byId<HTMLDialogElement>("terminal-close-dialog");
  dialog.returnValue = "cancel";
  const chosen = new Promise<string>(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true }));
  dialog.showModal();
  if (await chosen === "close") await terminal.stop(true);
}

async function testAtCursor(kind: "run" | "debug") {
  cursorTestLookup.invalidate();
  const target = project;
  const tab = docs.active;
  const caret = docs.editor.getPosition();
  const language = lsp;
  if (!target.native) { toast("Running or debugging Go tests requires an open native project."); return; }
  if (!tab?.path.endsWith("_test.go") || !caret) { toast("Place the cursor inside a Go test function."); return; }
  if (!language || gopls !== "ready") { toast("Go test lookup needs gopls to be ready."); return; }
  const available = () => !execution.occupied && !projectWorkflow.busy && !filesBusy();
  const blocked = () => toast("Wait for the current operation before launching a test.");
  if (!available()) { blocked(); return; }
  const version = tab.model.getVersionId();
  await cursorTestLookup.resolve(() => language.namedTestAt(tab.model, caret),
    () => project === target && docs.active === tab && lsp === language && !tab.model.isDisposed() && version === tab.model.getVersionId(),
    name => {
      if (!name) { toast("No Go test function at the cursor."); return; }
      if (kind === "run") void runTask("test", { path: tab.path, name });
      else void debugTest(tab.path, name);
    }, { available, blocked });
}

function updateTools() {
  const toolStatus = byId("tool-status");
  const version = tools?.goVersion?.replace(/^go/, "Go ");
  const state = !desktop ? "Preview" : !tools ? "Checking Go…" : version ?? "Go not found";
  const lspLabel = gopls === "ready" ? "gopls ready" : gopls === "starting" ? "gopls starting…" : gopls === "failed" ? "gopls stopped" : tools?.gopls ? "gopls available" : "gopls not installed";
  const detail = !desktop ? "Browser preview does not run local Go tools." : !tools ? "Detecting Go, gofmt, and gopls…" : `${state} · ${tools.gofmt ? "gofmt available" : "gofmt not found"} · ${lspLabel}`;
  byId("tool-version").textContent = state;
  toolStatus.title = detail;
  toolStatus.classList.toggle("good", !!version);
  toolStatus.classList.toggle("warn", desktop && !!tools && !version);
  byId("tools-info").textContent = project.native ? detail : desktop ? "Open or create a Go project to run code." : detail;
  byId("settings-tools-info").textContent = detail + (desktop && tools && !tools.gopls ? " Install with: go install golang.org/x/tools/gopls@latest" : "");
  if (desktop && tools) byId("settings-tools-info").append(tools.delve ? " · Delve available" : " · Delve not installed (brew install delve)");
  btn("probe-tools").hidden = !desktop;
}

async function probeTools() {
  if (!desktop) return;
  const hadGo = !!tools?.goVersion;
  btn("probe-tools").disabled = true;
  try { tools = await host.tools(); }
  catch (error) { tools = toolsMissing; showError(error); }
  finally { btn("probe-tools").disabled = false; }
  updateTools();
  if (!hadGo && tools?.goVersion) void runTargets.refresh();
  maybeStartLsp();
}

function maybeStartLsp() {
  const folder = project.native;
  if (!folder || !tools || lsp) return;
  if (!tools.gopls) { gopls = "missing"; updateTools(); renderProblems(); return; }
  void createGoLanguage(folder).start();
}

function createGoLanguage(folder: NativeFolder) {
  gopls = "starting";
  updateTools();
  const service = new GoLanguage(folder, docs, (state, reason) => {
    if (lsp !== service || project.native !== folder) return;
    gopls = state;
    if (state === "failed") {
      lsp = undefined;
      feedback.row(`gopls: ${reason ?? "connection closed"}`, "quiet", "info");
    }
    updateTools();
    renderProblems();
  });
  lsp = service;
  return service;
}

function showSettings(trigger?: HTMLElement) {
  const dialog = byId<HTMLDialogElement>("settings-dialog");
  if (dialog.open) return;
  const previous = document.activeElement;
  const initiator = trigger ?? previous;
  const fromEditor = byId("editor").contains(initiator);
  dialog.addEventListener("close", () => {
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused !== previous && focused !== initiator && !dialog.contains(focused)) return;
    if (fromEditor && docs.active) docs.editor.focus();
    else if (initiator instanceof HTMLElement && initiator !== document.body && initiator.isConnected && !initiator.closest("[hidden]")) initiator.focus();
    else if (docs.active) docs.editor.focus();
    else btn("settings").focus();
  }, { once: true });
  dialog.showModal();
}

function refreshProject() {
  if (projectWorkflow.busy || project.welcome) return;
  if (refreshDisk) void refreshDisk(true);
  else void refresh();
  void runTargets.refresh();
}

function showPalette(command = false, workspaceOnly = false) {
  const actions: { label: string; detail?: string; icon: Icon; run(): void; workspace?: boolean }[] = [
    { label: "Open Project…", detail: "⌘O", icon: "folderOpen", run: openFolder, workspace: true },
    ...(desktop ? [{ label: "Open Recent…", icon: "folder" as const, run: showRecentProjects, workspace: true }] : []),
    { label: "New Project…", icon: "package", run: newModule, workspace: true },
    { label: "Close Project", icon: "close", run: closeProject, workspace: true },
    { label: "Next Editor", detail: "⇧⌘]", icon: "files", run: () => cycleEditor(1) },
    { label: "Previous Editor", detail: "⇧⌘[", icon: "files", run: () => cycleEditor(-1) },
    { label: "New File…", icon: "filePlus", run: newFile, workspace: true },
    ...(project.native ? [
      { label: "New Folder…", icon: "folder" as const, run: () => { void fileOperation("folder").catch(showError); }, workspace: true },
      { label: "Rename File or Folder…", icon: "file" as const, run: () => { void fileOperation("rename").catch(showError); }, workspace: true },
      { label: "Move File or Folder…", icon: "files" as const, run: () => { void fileOperation("move").catch(showError); }, workspace: true },
      { label: "Move to Trash…", icon: "trash" as const, run: () => { void fileOperation("trash").catch(showError); }, workspace: true },
    ] : []),
    { label: "Refresh Project", icon: "refresh", run: refreshProject, workspace: true },
    { label: "Collapse Folders", icon: "folder", run: () => { opened.clear(); renderExplorer(); }, workspace: true },
    { label: "Search Saved Files", detail: "⇧⌘F", icon: "search", run: () => chooseView("search") },
    { label: "Go to Line…", icon: "search", run: goToLine },
    { label: "Go to Symbol in File…", icon: "search", run: () => { void goNavigation("symbols"); } },
    { label: "Go to Definition", detail: "F12", icon: "search", run: goToDefinition },
    { label: "Debug Go Program", icon: "play", run: debugProgram },
    ...(project.native ? [{ label: "Recover Drafts…", icon: "file" as const, run: () => { void recoverDrafts(); } }] : []),
    ...(desktop ? [{ label: "Manage Recovery Drafts…", icon: "file" as const, run: () => { void recoverDrafts(true); } }] : []),
    { label: "Find References", icon: "search", run: () => { void goNavigation("references"); } },
    { label: "Save File", detail: "⌘S", icon: "save", run: saveActive },
    { label: "Save Without Formatting", icon: "save", run: () => { void saveActive(false); } },
    { label: "Save All", icon: "save", run: saveAll },
    { label: "Reload File from Disk", icon: "refresh", run: reloadActive },
    ...(project.native && docs.active ? [{ label: "Compare with Disk", icon: "files" as const, run: compareWithDisk }] : []),
    ...(project.native && docs.active ? [{ label: "Save to a New Path…", icon: "save" as const, run: saveToNewPath }] : []),
    { label: "Format Go File", detail: "⇧⌥F", icon: "format", run: formatActive },
    { label: "Go: Organize Imports", icon: "format", run: organizeImports },
    { label: "Go: Rename Symbol…", icon: "files", run: renameGoSymbol },
    { label: "Go: Run Selected Target", detail: "⌘↵", icon: "play", run: () => { void runTask("run"); } },
    ...(project.native ? [
      { label: "Start Shell", icon: "terminal" as const, run: () => { void startShell().catch(showError); } },
      { label: "Run Go Program in Terminal", icon: "terminal" as const, run: () => { void runInTerminal().catch(showError); } },
      { label: "Close Terminal", icon: "close" as const, run: () => { void closeTerminal().catch(showError); } },
    ] : []),
    { label: "Go: Choose Run Target", icon: "package", run: () => runTargets.picker.focus() },
    { label: "Go: Build Packages", icon: "hammer", run: () => { void runTask("build"); } },
    { label: "Go: Run Tests", icon: "flask", run: () => { void runTask("test"); } },
    { label: "Go: Run Test at Cursor", icon: "flask", run: () => { void testAtCursor("run"); } },
    { label: "Go: Debug Test at Cursor", icon: "play", run: () => { void testAtCursor("debug"); } },
    { label: "Go: Stop Task", icon: "stop", run: stopTask },
    { label: "Toggle Sidebar", detail: "⌘B", icon: "files", run: toggleSidebar },
    { label: "Toggle Bottom Panel", detail: "⌘J", icon: "layout", run: () => feedback.toggle() },
    { label: "Workbench Settings", detail: "⌘,", icon: "settings", run: showSettings },
    { label: "Color Theme: Dark", icon: "settings", run: () => chooseColorTheme("dark") },
    { label: "Color Theme: Light", icon: "settings", run: () => chooseColorTheme("light") },
  ];
  palette.show(workspaceOnly ? "Project actions" : command ? "Type a command" : "Type a path to go to a file", query => {
    if (workspaceOnly || query.startsWith(">")) {
      const words = query.replace(/^>/, "").toLowerCase().trim().split(/\s+/);
      return actions.filter(action => (!workspaceOnly || action.workspace) && words.every(word => action.label.toLowerCase().includes(word)));
    }
    const paths = snapshot.entries.filter(entry => !entry.directory).map(entry => entry.path);
    return quickFiles(paths, query).map(path => ({ label: basename(path), detail: dirname(path), icon: "file", path, run: () => { void openFile(path); } }));
  }, command && !workspaceOnly ? ">" : "");
}

function bindLayout() {
  for (const id of ["sidebar-resize", "panel-resize"]) {
    const divider = byId(id);
    const vertical = id === "sidebar-resize";
    const layout = () => byId(vertical ? "sidebar" : "panel").getBoundingClientRect();
    const resize = (size: number) => {
      const min = vertical ? 160 : 96;
      const max = vertical ? Math.min(420, workbench.clientWidth * .42) : workbench.clientHeight * .55;
      workbench.style.setProperty(vertical ? "--side-width" : "--panel-height", `${Math.max(min, Math.min(max, size))}px`);
      docs.layout();
    };
    divider.tabIndex = 0;
    divider.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      divider.setPointerCapture(event.pointerId);
      divider.classList.add("dragging");
    });
    divider.addEventListener("pointermove", event => {
      if (divider.hasPointerCapture(event.pointerId)) {
        const box = layout();
        resize(vertical ? event.clientX - box.left : box.bottom - event.clientY);
      }
    });
    divider.addEventListener("lostpointercapture", () => divider.classList.remove("dragging"));
    divider.addEventListener("keydown", event => {
      const direction = vertical ? ["ArrowLeft", "ArrowRight"] : ["ArrowDown", "ArrowUp"];
      const index = direction.indexOf(event.key);
      if (index < 0) return;
      event.preventDefault();
      const box = layout();
      resize((vertical ? box.width : box.height) + (index ? 14 : -14));
    });
  }
}

function bindEditorTypography() {
  const font = byId<HTMLSelectElement>("editor-font");
  const size = input("editor-font-size");
  const fontKey = "irongo.editor-font";
  const sizeKey = "irongo.editor-font-size";
  let fontSize = defaultEditorFontSize;
  try {
    font.value = localStorage.getItem(fontKey) ?? font.value;
    size.value = localStorage.getItem(sizeKey) ?? size.value;
  } catch { /* Use the defaults. */ }

  function apply() {
    if (!font.value) font.value = "jetbrains";
    if (size.validity.valid && Number.isInteger(size.valueAsNumber)) fontSize = size.valueAsNumber;
    size.value = String(fontSize);
    docs.editor.updateOptions(editorTypography(font.value, fontSize));
    if (docs.active) docs.refreshView();
  }
  function save() {
    apply();
    try {
      localStorage.setItem(fontKey, font.value);
      localStorage.setItem(sizeKey, size.value);
    } catch { /* Still apply for this session. */ }
  }
  font.addEventListener("change", save);
  size.addEventListener("change", save);
  size.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      size.blur();
    }
  });
  apply();
}

function bindSettings() {
  bindColorTheme();
  bindEditorTypography();
  byId("settings-dialog").addEventListener("close", () => {
    if (docs.active) docs.refreshView();
  });
  const options = [
    { field: "minimap-setting", enabled: true },
    { field: "wrap-setting", enabled: false },
    { field: "format-save-setting", enabled: false },
  ];
  input("format-save-setting").disabled = !desktop;
  for (const option of options) {
    try { input(option.field).checked = (localStorage.getItem(`irongo.${option.field}`) ?? String(option.enabled)) === "true"; }
    catch { input(option.field).checked = option.enabled; }
    input(option.field).addEventListener("change", () => {
      try { localStorage.setItem(`irongo.${option.field}`, String(input(option.field).checked)); } catch { /* Optional preference storage. */ }
      apply();
    });
  }
  function apply() {
    docs.editor.updateOptions({ minimap: { enabled: input("minimap-setting").checked }, wordWrap: input("wrap-setting").checked ? "on" : "off" });
  }
  apply();
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) button.addEventListener("click", () => chooseView(button.dataset.view as View));
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-task]")) button.addEventListener("click", () => { void runTask(button.dataset.task as TaskKind); });
byId("quick-open").addEventListener("click", () => showPalette(!!project.welcome));
byId("empty-quick-open").addEventListener("click", () => showPalette());
byId("workspace-actions").addEventListener("click", () => showPalette(false, true));
byId("open-folder").addEventListener("click", openFolder);
byId("welcome-open").addEventListener("click", openFolder);
byId("welcome-new").addEventListener("click", newModule);
byId("toggle-sidebar").addEventListener("click", toggleSidebar);
byId("new-file").addEventListener("click", newFile);
byId("format").addEventListener("click", formatActive);
byId("save").addEventListener("click", () => { void saveActive(); });
byId("compare-disk").addEventListener("click", compareWithDisk);
byId("save-new-path").addEventListener("click", saveToNewPath);
byId("close-references").addEventListener("click", () => {
  navigation?.cancel();
  feedback.hide("references");
});
const runOrStop = () => execution.task ? stopTask() : runTask(runTargets.primaryAction());
byId("run").addEventListener("click", runOrStop);
byId("panel-stop").addEventListener("click", stopTask);
byId("stop-task").addEventListener("click", stopTask);
byId("settings").addEventListener("click", () => showSettings(btn("settings")));
byId("probe-tools").addEventListener("click", probeTools);
monaco.editor.addCommand({ id: runTestCommand, run: (_accessor, id: number, path: string, name: string) => {
  if (project.native?.id === id && docs.active?.path === path && path.endsWith("_test.go")) {
    void runTask("test", { path, name });
  }
} });
monaco.editor.addCommand({ id: debugTestCommand, run: (_accessor, id: number, path: string, name: string) => {
  if (project.native?.id === id && docs.active?.path === path && path.endsWith("_test.go")) void debugTest(path, name);
} });
docs.editor.onMouseDown(event => {
  if (event.event.leftButton && event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
    toggleBreakpoint(event.target.position?.lineNumber);
  }
});
byId("debug-continue").addEventListener("click", () => { void execution.debug?.resume("continue"); });
byId("debug-next").addEventListener("click", () => { void execution.debug?.resume("next"); });
byId("debug-step-in").addEventListener("click", () => { void execution.debug?.resume("stepIn"); });
byId("debug-step-out").addEventListener("click", () => { void execution.debug?.resume("stepOut"); });
byId("debug-stop").addEventListener("click", () => { void execution.debug?.stop(); syncControls(); });
input("search-text").addEventListener("input", scheduleSearch);
byId("search-case").addEventListener("click", event => {
  const button = event.currentTarget as HTMLButtonElement;
  button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
  scheduleSearch();
});
byId("search-form").addEventListener("submit", event => { event.preventDefault(); scheduleSearch(); });
input("import-folder").addEventListener("change", () => {
  const picker = input("import-folder");
  if (picker.files?.length) {
    const selected = importedProject(picker.files);
    void changeProject(async () => selected).catch(showError);
  }
  picker.value = "";
});

function nativeBrowserShortcut(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey) return false;
  if (!event.metaKey) return event.key === "F5";
  const key = event.key.toLowerCase();
  // WKWebView can report Command-Shift-Plus as the unshifted Equal key.
  if (key === "r" || key === "+" || (key === "=" && event.code === "Equal" && event.shiftKey)) return true;
  return !event.shiftKey && ["l", "=", "-", "0"].includes(key);
}

document.addEventListener("keydown", event => {
  if (event.isComposing) return;
  if (desktop && nativeBrowserShortcut(event)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const modal = !!document.querySelector("dialog[open]");
  if (handleEditorCycle(event, modal || projectWorkflow.busy, direction => docs.cycle(direction))) return;
  if (modal && event.key !== "Escape") return;
  const key = event.key.toLowerCase();
  const cmd = event.metaKey || (!desktop && event.ctrlKey);
  let apply: (() => unknown) | undefined;
  if (project.native && event.key === "F9" && !cmd && !event.altKey && !event.shiftKey && !event.ctrlKey) apply = () => toggleBreakpoint();
  if (cmd && !event.altKey) {
    if (key === "p") apply = () => showPalette(event.shiftKey || !!project.welcome);
    if (key === "o") apply = openFolder;
    if (key === "s") apply = saveActive;
    if (key === "f" && event.shiftKey) apply = () => chooseView("search");
    if (key === "e" && event.shiftKey) apply = () => chooseView("explorer");
    if (key === "j") apply = () => feedback.toggle();
    if (key === "b") apply = toggleSidebar;
    if (key === ",") apply = showSettings;
    if (key === "enter") apply = runOrStop;
  }
  if (event.altKey && event.shiftKey && (key === "f" || event.code === "KeyF")) apply = formatActive;
  if (apply) { event.preventDefault(); event.stopPropagation(); void apply(); }
}, true);

docs.editor.onDidChangeCursorPosition(() => { updateCursor(); invalidateNavigation(); queueEditorSession(); });
docs.editor.onDidScrollChange(event => { if (event.scrollTopChanged) queueEditorSession(); });
byId("welcome-recent").hidden = !desktop;
byId("welcome-recent").addEventListener("click", () => { void showRecentProjects(); });
byId("terminal-close").addEventListener("click", () => { void closeTerminal().catch(showError); });
monaco.editor.onDidChangeMarkers(renderProblems);
bindLayout();
bindSettings();
docs.editor.addAction({
  id: "ironGo.goToDefinition", label: "Go to Definition (Including Dependencies)",
  keybindings: [monaco.KeyCode.F12], keybindingContext: "editorTextFocus && editorLangId == go",
  contextMenuGroupId: "navigation", contextMenuOrder: 1.05, precondition: "editorLangId == go",
  run: goToDefinition,
});
if (desktop) {
  const quitDialog = byId<HTMLDialogElement>("quit-dialog");
  const discardQuit = byId<HTMLButtonElement>("quit-discard");
  const saveQuit = btn("quit-save");
  const cancelQuitDialog = (ticket: number) => {
    if (quitDialogTicket === ticket && quitDialog.open) quitDialog.close("cancel");
  };
  const confirmQuit = async (ticket: number) => {
    const choice = await new Promise<string>(resolve => {
      quitDialogTicket = ticket;
      quitDialog.returnValue = "cancel";
      discardQuit.disabled = true;
      saveQuit.disabled = true;
      quitDialog.addEventListener("close", () => {
        quitDialogTicket = undefined;
        resolve(discardQuit.disabled ? "cancel" : quitDialog.returnValue);
      }, { once: true });
      quitDialog.showModal();
      void host.presentExit(ticket).then(presented => {
        if (!presented) cancelQuitDialog(ticket);
        else if (quitDialogTicket === ticket && quitDialog.open) {
          discardQuit.disabled = false;
          saveQuit.disabled = false;
        }
      }).catch(error => {
        cancelQuitDialog(ticket);
        showError(error);
      });
    });
    if (ticket <= lastExpiredQuitTicket) return false;
    return choice === "discard" || (choice === "save" && await saveAllDocuments(ticket));
  };
  void getCurrentWindow().listen<number>("iron-go-exit-expired", event => {
    lastExpiredQuitTicket = Math.max(lastExpiredQuitTicket, event.payload);
    sessionExpiry.get(event.payload)?.();
    cancelQuitDialog(event.payload);
  }).catch(showError);
  void getCurrentWindow().listen<number>("iron-go-exit-requested", event => {
    if (event.payload <= lastExpiredQuitTicket) return;
    if (import.meta.env.VITE_IRON_E2E === "1") testQuitRequests++;
    let release: (() => void) | undefined;
    let thawDrafts: (() => void) | undefined;
    void decideExit({
      canDecide: () => !projectWorkflow.busy && transitionReady(),
      hasUnsavedChanges: () => docs.dirty,
      confirmDiscard: () => confirmQuit(event.payload),
      freeze: frozen => {
        if (frozen) release = projectWorkflow.reserve();
        else { thawDrafts?.(); release?.(); }
      },
      reply: async approve => {
        if (!approve) return host.resolveExit(event.payload, false);
        thawDrafts = drafts.freeze();
        const expired = new Promise<void>(resolve => { sessionExpiry.set(event.payload, resolve); });
        try {
          await Promise.race([flushEditorSession(event.payload), expired]);
          if (event.payload <= lastExpiredQuitTicket) return false;
          return await Promise.race([host.resolveExit(event.payload, true, drafts.plan(project.native)), expired.then(() => false)]);
        } finally { sessionExpiry.delete(event.payload); }
      },
    }).catch(showError);
  }).catch(showError);
} else {
  window.addEventListener("beforeunload", event => {
    if (docs.dirty) { event.preventDefault(); event.returnValue = ""; }
  });
}

if (import.meta.env.VITE_IRON_E2E === "1") {
  void import("./acceptance").then(({ installAcceptance }) => installAcceptance(docs, {
    root: () => project.native?.path,
    gopls: () => gopls,
    quitRequests: () => testQuitRequests,
    quitExpiry: () => lastExpiredQuitTicket,
    workspaceId: () => project.native?.id,
    holdEditorSession: hold => {
      holdSessionDebounce = hold;
      clearTimeout(sessionTimer);
      if (!hold) queueEditorSession();
    },
    terminal,
  }));
}

void install(project).catch(showError);
void probeTools();

import "./styles.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { byId, element, Forms, message, Palette } from "./dialogs";
import { bufferText, Documents, monaco, type DocumentTab } from "./editor";
import { Feedback } from "./feedback";
import { fileIcon, icon, prepareIcons, type Icon } from "./icons";
import { GoLanguage, debugTestCommand, runTestCommand, type LanguageState } from "./lsp";
import { Breakpoints, DebugSession } from "./debugger";
import { packageForFile, RunTargets } from "./run-targets";
import { bindColorTheme, chooseColorTheme } from "./theme";
import { basename, dirname, initialWorkspaceFile, makeTree, quickFiles, validateRelative, type FileMatch, type ProjectSnapshot, type TreeNode } from "./project-model";
import { decideExit } from "./quit-flow";
import { ExecutionLane } from "./execution";
import { publishProjectSnapshot } from "./project-workflow";
import { createCursorTestWorkflow } from "./cursor-test-workflow";
import { handleEditorCycle } from "./editor-shortcuts";
import { desktop, host, importedProject, nativeProject, welcomeProject, type NativeFolder, type Project, type TaskKind, type ToolStatus } from "./workspace";

type View = "explorer" | "search" | "tasks";

prepareIcons();
document.body.classList.toggle("desktop", desktop);
const palette = new Palette();
const forms = new Forms();
const feedback = new Feedback(() => docs.layout());
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
const breakpoints = new Breakpoints();
let executionLine: { model: monaco.editor.ITextModel; ids: string[] } | undefined;
let formatting = false;
let fileMutations = 0;
let testQuitRequests = 0;
let quitDialogTicket: number | undefined;
let lastExpiredQuitTicket = 0;
let tools: ToolStatus | undefined;
let lsp: GoLanguage | undefined;
let gopls: LanguageState = "idle";
let searchGeneration = 0;
let searchTimer: number | undefined;
let toastTimer: number | undefined;
let renderedActive: string | undefined;

const docs = new Documents(byId("editor"), {
  changed: renderDocuments,
  opened: tab => { breakpoints.open(tab); lsp?.opened(tab); },
  edited: tab => lsp?.edited(tab),
  closed: tab => { breakpoints.close(tab); lsp?.closed(tab); queueMicrotask(renderProblems); },
  saved: tab => lsp?.saved(tab),
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
const fileActionsBlocked = () => projectWorkflow.busy || execution.preparing;
const saveBarrier = {
  revision: () => docs.editRevision,
  dirty: () => docs.dirty,
  async save() { for (const tab of docs.tabs.values()) if (tab.dirty) await docs.save(tab); },
};
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") docs.refreshView();
});

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
      row.innerHTML = `<span class="tree-twist">${item.directory ? icon(expanded ? "down" : "chevron") : ""}</span>` +
        (item.directory ? `<span class="tree-folder">${icon(expanded ? "folderOpen" : "folder")}</span>` : fileIcon(item.path));
      row.append(element("span", "tree-name", item.name));
      if (item.directory) row.setAttribute("aria-expanded", String(expanded));
      row.addEventListener("click", () => {
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
  explorer.replaceChildren(root, list);
  explorer.scrollTop = scroll;
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
  const tabs = byId("tabs");
  const active = docs.active;
  const scroll = tabs.scrollLeft;
  const focusedTab = tabs.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.path : undefined;
  const children: HTMLElement[] = [];
  for (const tab of docs.tabs.values()) {
    const selected = tab === active;
    const row = element("div", `tab${selected ? " active" : ""}${tab.dirty ? " dirty" : ""}`);
    row.setAttribute("role", "presentation");
    const name = element("button", "tab-main");
    name.type = "button";
    name.dataset.path = tab.path;
    name.title = tab.path;
    name.setAttribute("role", "tab");
    name.setAttribute("aria-selected", String(selected));
    name.innerHTML = fileIcon(tab.path);
    name.append(element("span", "", basename(tab.path)));
    name.addEventListener("click", () => { void openFile(tab.path); });
    const close = element("button", "icon-button tab-close");
    close.innerHTML = icon("close");
    close.title = tab.dirty ? "Close unsaved file" : "Close tab";
    close.setAttribute("aria-label", `Close ${basename(tab.path)}`);
    close.addEventListener("click", () => closeTab(tab));
    row.append(name, close);
    children.push(row);
  }
  tabs.replaceChildren(...children);
  tabs.scrollLeft = scroll;
  if (focusedTab) [...tabs.querySelectorAll<HTMLButtonElement>(".tab-main")].find(node => node.dataset.path === focusedTab)?.focus();
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

function closeTab(tab: DocumentTab) {
  if (!fileActionsBlocked() && !tab.saving && (!tab.dirty || window.confirm(`Discard unsaved changes to ${basename(tab.path)}?`))) docs.close(tab);
}

async function saveActive() {
  if (fileActionsBlocked() || !docs.active) return;
  const tab = docs.active;
  const target = project;
  try {
    if (!tab.dirty) { status(`${basename(tab.path)} is saved`); return; }
    if (await docs.save(tab) && project === target) {
      if (docs.active === tab) status(`Saved ${basename(tab.path)}`);
      if (/(^|\/)go\.(mod|work)$/.test(tab.path)) {
        await refresh();
        if (project === target) void runTargets.refresh();
      }
      if (project === target && view === "search") scheduleSearch();
    }
  } catch (error) { if (project === target && docs.active === tab) showError(error); }
}

async function reloadActive() {
  const tab = docs.active;
  if (!tab || tab.saving || fileActionsBlocked() || (tab.dirty && !window.confirm(`Discard unsaved changes and reload ${basename(tab.path)}?`))) return;
  const target = project;
  fileMutations++;
  syncControls();
  try { if (await docs.reload(tab) && project === target && docs.active === tab) status(`Reloaded ${basename(tab.path)}`); }
  catch (error) { if (project === target && docs.active === tab) showError(error); }
  finally { fileMutations--; syncControls(); }
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

function refresh() {
  return publishProjectSnapshot(project, {
    current: () => project,
    read: target => target.snapshot(),
    apply(result) {
      snapshot = result;
      tree = makeTree(result.entries);
      renderExplorer();
    },
    fail: showError,
  });
}

async function install(target: Project) {
  execution.retire()?.retire();
  clearExecutionLine();
  breakpoints.reset();
  const previousLsp = lsp;
  lsp = undefined;
  project = target;
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
  if (target.welcome) feedback.toggle(false); else feedback.show("output");
  chooseView("explorer", false);
  status("Opening workspace…");
  await refresh();
  if (target !== project) return;
  const initial = initialWorkspaceFile(snapshot.entries);
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
}

const transitionReady = () => !filesBusy() && !execution.preparing;

async function confirmTransition() {
  const warnings = [
    docs.dirty && "Unsaved edits will be discarded.",
    execution.task && "The current Go task will be stopped.",
    execution.debug && "The debug session will be stopped.",
  ].filter(Boolean);
  if (!warnings.length) return true;
  const dialog = byId<HTMLDialogElement>("project-transition-dialog");
  byId("project-transition-description").textContent = warnings.join(" ");
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise<boolean>(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "continue"), { once: true }));
}

function changeProject(choose: () => Promise<Project | undefined>) {
  return projectWorkflow.transition({ ready: transitionReady, confirm: confirmTransition, choose, install });
}

function openFolder() {
  if (!desktop) {
    if (transitionReady() && !projectWorkflow.busy) input("import-folder").click();
    return;
  }
  void changeProject(async () => {
    const folder = await host.open();
    return folder ? nativeProject(folder) : undefined;
  }).catch(showError);
}

function closeProject() {
  const target = project;
  if (target.welcome) return;
  void changeProject(async () => {
    if (target.native) await host.close(target.native.id);
    return welcomeProject();
  }).catch(showError);
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
        const folder = await host.create(name, module);
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
}

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

async function runTask(kind: TaskKind, singleTest?: { path: string; name: string }) {
  if (execution.occupied || projectWorkflow.busy || filesBusy()) return;
  const target = project.native;
  if (!target) {
    toast(desktop ? "Open or create a Go project first." : "Run, build and test are available in the macOS desktop app.");
    return;
  }
  if (!tools?.goVersion) { toast("Install Go, then check the toolchain in Settings.", true); return; }
  let packages: string[];
  try {
    packages = singleTest ? [packageForFile(singleTest.path)]
      : kind === "run" ? runTargets.runArguments() : runTargets.buildTestArguments(docs.active?.path);
  } catch (error) { showError(error); return; }
  feedback.show("output");
  status(`Preparing Go ${kind}…`);
  try {
    await execution.start(target, kind, saveBarrier, token => host.task(target.id, kind, packages, singleTest?.name, event => {
      if (project.native !== target || !execution.taskEvent(token, event.type)) return;
      const result = feedback.task(event);
      if (event.type === "started") {
        status(`Go ${kind} running…`);
      } else if (event.type === "finished") {
        status(result ?? "Ready");
      }
    }));
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

function toggleBreakpoint(line = docs.editor.getPosition()?.lineNumber) {
  const tab = docs.active;
  if (projectWorkflow.busy || !project.native || !tab?.path.endsWith(".go") || !line) return;
  breakpoints.toggle(tab, line);
  docs.refreshView();
  const debug = execution.debug;
  if (debug?.ready) void debug.setBreakpoints(tab.path).catch(error => { if (execution.debug === debug) showError(error); });
}

async function debugTest(path: string, name: string) {
  const folder = project.native;
  if (!folder || execution.occupied || projectWorkflow.busy || filesBusy()) return;
  if (!tools?.delve) {
    toast("Install Delve with `brew install delve`, then select Check tools in Settings.", true);
    return;
  }
  try {
    await execution.start(folder, "debug", saveBarrier, async token => {
      const isCurrent = () => execution.owns(token) && project.native === folder;
      const session = new DebugSession(folder, breakpoints, {
        isCurrent,
        admitted() { if (isCurrent()) syncControls(); },
        paused(file, line, reason, currentPause) {
          const current = () => isCurrent() && currentPause();
          if (!current()) return;
          void (async () => {
            clearExecutionLine();
            const tab = file ? await docs.open(file, { focus: true, target: { lineNumber: line, column: 1 }, current }).catch(() => undefined) : undefined;
            if (!current()) return;
            if (tab) {
              const ids = tab.model.deltaDecorations([], [{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: "debug-execution-line" } }]);
              executionLine = { model: tab.model, ids };
            }
            const prefix = reason === "breakpoint" ? "Breakpoint hit" : "Paused";
            status(`${prefix}${file ? ` — ${basename(file)}:${line}` : " outside project source"}`);
            syncControls();
          })();
        },
        running() {
          if (!isCurrent()) return;
          clearExecutionLine();
          status(`Debugging ${name}…`);
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
      });
      if (!execution.attachDebug(token, session)) return;
      feedback.clear();
      feedback.show("output");
      feedback.row(`Launching ${name} with Delve…`, "command", "command");
      status(`Launching ${name}…`);
      await session.start(path, name);
    });
  } catch (error) { if (project.native === folder) showError(error); }
}

async function stopTask() {
  if (projectWorkflow.busy) return;
  try { await execution.stopTask(target => host.stop(target.id)); }
  catch (error) { showError(error); }
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
  void service.start();
}

function showSettings() { byId<HTMLDialogElement>("settings-dialog").showModal(); }

function refreshProject() {
  if (projectWorkflow.busy || project.welcome) return;
  void refresh();
  void runTargets.refresh();
}

function showPalette(command = false, workspaceOnly = false) {
  const actions: { label: string; detail?: string; icon: Icon; run(): void; workspace?: boolean }[] = [
    { label: "Open Project…", detail: "⌘O", icon: "folderOpen", run: openFolder, workspace: true },
    { label: "New Project…", icon: "package", run: newModule, workspace: true },
    { label: "Close Project", icon: "close", run: closeProject, workspace: true },
    { label: "Next Editor", detail: "⇧⌘]", icon: "files", run: () => cycleEditor(1) },
    { label: "Previous Editor", detail: "⇧⌘[", icon: "files", run: () => cycleEditor(-1) },
    { label: "New File…", icon: "filePlus", run: newFile, workspace: true },
    { label: "Refresh Project", icon: "refresh", run: refreshProject, workspace: true },
    { label: "Collapse Folders", icon: "folder", run: () => { opened.clear(); renderExplorer(); }, workspace: true },
    { label: "Search Saved Files", detail: "⇧⌘F", icon: "search", run: () => chooseView("search") },
    { label: "Save File", detail: "⌘S", icon: "save", run: saveActive },
    { label: "Reload File from Disk", icon: "refresh", run: reloadActive },
    { label: "Format Go File", detail: "⇧⌥F", icon: "format", run: formatActive },
    { label: "Go: Run Selected Target", detail: "⌘↵", icon: "play", run: () => { void runTask("run"); } },
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
  const paths = snapshot.entries.filter(entry => !entry.directory).map(entry => entry.path);
  palette.show(workspaceOnly ? "Project actions" : command ? "Type a command" : "Type a path to go to a file", query => {
    if (workspaceOnly || query.startsWith(">")) {
      const words = query.replace(/^>/, "").toLowerCase().trim().split(/\s+/);
      return actions.filter(action => (!workspaceOnly || action.workspace) && words.every(word => action.label.toLowerCase().includes(word)));
    }
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

function bindSettings() {
  bindColorTheme();
  const options = [
    { field: "minimap-setting", enabled: true },
    { field: "wrap-setting", enabled: false },
  ];
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
byId("save").addEventListener("click", saveActive);
const runOrStop = () => execution.task ? stopTask() : runTask(runTargets.primaryAction());
byId("run").addEventListener("click", runOrStop);
byId("panel-stop").addEventListener("click", stopTask);
byId("stop-task").addEventListener("click", stopTask);
byId("settings").addEventListener("click", showSettings);
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

docs.editor.onDidChangeCursorPosition(updateCursor);
monaco.editor.onDidChangeMarkers(renderProblems);
bindLayout();
bindSettings();
if (desktop) {
  const quitDialog = byId<HTMLDialogElement>("quit-dialog");
  const discardQuit = byId<HTMLButtonElement>("quit-discard");
  const cancelQuitDialog = (ticket: number) => {
    if (quitDialogTicket === ticket && quitDialog.open) quitDialog.close("cancel");
  };
  const confirmQuit = (ticket: number) => new Promise<boolean>(resolve => {
    quitDialogTicket = ticket;
    quitDialog.returnValue = "cancel";
    discardQuit.disabled = true;
    quitDialog.addEventListener("close", () => {
      quitDialogTicket = undefined;
      resolve(!discardQuit.disabled && quitDialog.returnValue === "discard");
    }, { once: true });
    quitDialog.showModal();
    void host.presentExit(ticket).then(presented => {
      if (!presented) cancelQuitDialog(ticket);
      else if (quitDialogTicket === ticket && quitDialog.open) discardQuit.disabled = false;
    }).catch(error => {
      cancelQuitDialog(ticket);
      showError(error);
    });
  });
  void getCurrentWindow().listen<number>("iron-go-exit-expired", event => {
    lastExpiredQuitTicket = Math.max(lastExpiredQuitTicket, event.payload);
    cancelQuitDialog(event.payload);
  }).catch(showError);
  void getCurrentWindow().listen<number>("iron-go-exit-requested", event => {
    if (event.payload <= lastExpiredQuitTicket) return;
    if (import.meta.env.VITE_IRON_E2E === "1") testQuitRequests++;
    let release: (() => void) | undefined;
    void decideExit({
      canDecide: () => !projectWorkflow.busy && transitionReady(),
      hasUnsavedChanges: () => docs.dirty,
      confirmDiscard: () => confirmQuit(event.payload),
      freeze: frozen => {
        if (frozen) release = projectWorkflow.reserve();
        else release?.();
      },
      reply: approve => host.resolveExit(event.payload, approve),
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
  }));
}

void install(project).catch(showError);
void probeTools();

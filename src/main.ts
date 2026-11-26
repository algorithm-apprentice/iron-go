import "./styles.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { byId, element, Forms, message, Palette } from "./dialogs";
import { bufferText, Documents, monaco, replaceBuffer, type DocumentTab } from "./editor";
import { Feedback } from "./feedback";
import { fileIcon, icon, prepareIcons, type Icon } from "./icons";
import { GoLanguage, type LanguageState } from "./lsp";
import { bindColorTheme, chooseColorTheme } from "./theme";
import { basename, defaultRunPackage, dirname, makeTree, quickFiles, validateRelative, type FileMatch, type ProjectSnapshot, type TreeNode } from "./project-model";
import { desktop, host, importedProject, nativeProject, sampleProject, type Project, type TaskKind, type ToolStatus } from "./workspace";

type View = "explorer" | "search" | "tasks";

prepareIcons();
document.body.classList.toggle("desktop", desktop);
const palette = new Palette();
const forms = new Forms();
const feedback = new Feedback();
const workbench = byId("workbench");
const btn = (id: string) => byId<HTMLButtonElement>(id);
const input = (id: string) => byId<HTMLInputElement>(id);
const toolsMissing = { goVersion: null, gofmt: false, gopls: false };

let project = sampleProject();
let snapshot: ProjectSnapshot = { entries: [], truncated: false, module: null, goWork: false };
let tree: TreeNode[] = [];
let opened = new Set<string>();
let view: View = "explorer";
let rootExpanded = true;
let busy = false;
let task: TaskKind | undefined;
let stopPending = false;
let formatting = false;
let tools: ToolStatus | undefined;
let lsp: GoLanguage | undefined;
let gopls: LanguageState = "idle";
let searchGeneration = 0;
let searchTimer: number | undefined;
let toastTimer: number | undefined;
let renderedActive: string | undefined;

const docs = new Documents(byId("editor"), {
  changed: renderDocuments,
  opened: tab => lsp?.opened(tab),
  edited: tab => lsp?.edited(tab),
  closed: tab => { lsp?.closed(tab); queueMicrotask(renderProblems); },
  saved: tab => lsp?.saved(tab),
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
  const root = element("button", "explorer-root");
  root.innerHTML = `<span class="tree-twist">${icon(rootExpanded ? "down" : "chevron")}</span>`;
  root.append(element("strong", "", project.name));
  root.title = project.native?.path ?? `${project.name} · ${project.sample ? "sample workspace" : "browser import"}`;
  root.setAttribute("aria-expanded", String(rootExpanded));
  if (!project.native) root.append(element("span", "root-tag", project.sample ? "SAMPLE" : "COPY"));
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
  if (busy) return;
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
  byId("empty-editor").hidden = !!active;
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
  btn("format").disabled = !active?.path.endsWith(".go") || formatting || busy;
  btn("save").disabled = !active || active.saving || busy;
  btn("open-folder").disabled = busy || docs.saving;
  btn("new-file").disabled = busy;
  btn("refresh-files").disabled = busy;
  const run = btn("run");
  run.disabled = busy || stopPending;
  run.dataset.running = String(!!task);
  run.innerHTML = `${icon(task ? "stop" : "play")}<span>${task ? "Stop" : "Run"}</span>`;
  run.title = task ? "Stop Go Task" : "Run Go Package (⌘↵)";
  btn("panel-stop").hidden = !task;
  btn("panel-stop").disabled = stopPending;
  btn("stop-task").disabled = !task || stopPending;
  input("run-package").disabled = !!task;
  input("task-scope").disabled = !!task;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-task]")) button.disabled = !!task || busy;
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
  if (!tab.saving && (!tab.dirty || window.confirm(`Discard unsaved changes to ${basename(tab.path)}?`))) docs.close(tab);
}

async function saveActive() {
  if (busy || !docs.active) return;
  const tab = docs.active;
  try {
    if (!tab.dirty) { status(`${basename(tab.path)} is saved`); return; }
    if (await docs.save(tab)) {
      status(`Saved ${basename(tab.path)}`);
      if (tab.path === "go.mod" || tab.path === "go.work") await refresh();
      if (view === "search") scheduleSearch();
    }
  } catch (error) { showError(error); }
}

async function reloadActive() {
  const tab = docs.active;
  if (!tab || tab.saving || busy || (tab.dirty && !window.confirm(`Discard unsaved changes and reload ${basename(tab.path)}?`))) return;
  try { if (await docs.reload(tab)) status(`Reloaded ${basename(tab.path)}`); }
  catch (error) { showError(error); }
}

async function formatActive() {
  const tab = docs.active;
  if (!tab?.path.endsWith(".go") || formatting || busy) return;
  if (!desktop) { toast("Go formatting uses gofmt in the macOS desktop app."); return; }
  const version = tab.model.getVersionId();
  formatting = true;
  syncControls();
  try {
    const formatted = await host.format(tab.model.getValue());
    if (tab.model.isDisposed() || version !== tab.model.getVersionId()) { status("Skipped outdated gofmt result"); return; }
    replaceBuffer(tab.model, formatted);
    status(`Formatted ${basename(tab.path)} with gofmt`);
  } catch (error) { showError(error); }
  finally { formatting = false; syncControls(); }
}

async function refresh() {
  const target = project;
  const result = await target.snapshot();
  if (target !== project) return;
  snapshot = result;
  tree = makeTree(result.entries);
  renderExplorer();
}

async function install(target: Project) {
  lsp?.dispose();
  lsp = undefined;
  project = target;
  task = undefined;
  stopPending = false;
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
  byId("quick-label").textContent = `Search files in ${target.name}`;
  feedback.clear();
  feedback.show("output");
  chooseView("explorer", false);
  status("Opening workspace…");
  try { await refresh(); }
  catch (error) { showError(error); }
  if (target !== project) return;
  const files = snapshot.entries.filter(entry => !entry.directory).map(entry => entry.path);
  const runPackage = defaultRunPackage(snapshot.entries);
  input("run-package").value = runPackage;
  input("task-scope").value = "./...";
  const initial = files.includes("main.go") ? "main.go" : files.find(path => path === `${runPackage.slice(2)}/main.go`) ?? files.find(path => path.endsWith(".go")) ?? files[0];
  if (target.sample) {
    if (files.includes("go.mod")) await docs.open("go.mod", { activate: false });
    if (files.includes("README.md")) await docs.open("README.md", { activate: false });
    for (const folder of ["cmd", "cmd/orbit", "internal", "internal/status"]) opened.add(folder);
  }
  if (initial) {
    try { await docs.open(initial); revealParents(initial); }
    catch (error) { showError(error); }
  }
  if (target !== project) return;
  renderExplorer();
  if (target.sample) {
    feedback.row("Iron Go · Orbit sample ready", "success", "check");
    feedback.row("Explore the editor and search, or open a Go module to work on your own code.");
    feedback.row(desktop ? "Open examples/orbit from the repository to build and run this sample." : "Browser preview · Local Go tasks are available in the macOS app.", "quiet", "info");
  } else {
    feedback.row(`Workspace opened: ${target.name}`, "success", "check");
    feedback.row(target.native ? target.native.path : "Imported as a copy. Edits stay in memory and do not write to disk.", "quiet", "info");
  }
  status(target.sample ? "Sample workspace" : target.native ? "Ready" : "Browser copy");
  updateTools();
  maybeStartLsp();
}

function canSwitch() {
  if (busy || docs.saving) return false;
  return (!docs.dirty || window.confirm("Discard unsaved edits and switch workspaces?")) &&
    (!task || window.confirm("Stop the current Go task and switch workspaces?"));
}

async function openFolder() {
  if (!canSwitch()) return;
  if (!desktop) { input("import-folder").click(); return; }
  busy = true;
  syncControls();
  try {
    const folder = await host.open();
    if (folder) await install(nativeProject(folder));
  } catch (error) { showError(error); }
  finally { busy = false; syncControls(); }
}

async function openSample() {
  if (!canSwitch()) return;
  busy = true;
  syncControls();
  try {
    if (project.native) await host.close(project.native.id);
    await install(sampleProject());
  } catch (error) { showError(error); }
  finally { busy = false; syncControls(); }
}

function newModule() {
  if (!desktop) { toast("Creating a Go module on disk requires the macOS desktop app."); return; }
  forms.show({
    title: "New Go Module", description: "Choose a name and a module path. Iron Go will create a folder, go.mod, and main.go.", submit: "Choose Parent Folder…",
    fields: [
      { name: "name", label: "Folder name", value: "hello-go", maxLength: 80 },
      { name: "module", label: "Go module path", value: "example.com/hello-go", maxLength: 240 },
    ],
    async run({ name, module }) {
      if (!canSwitch()) return false;
      busy = true;
      syncControls();
      try {
        const folder = await host.create(name, module);
        if (!folder) return false;
        await install(nativeProject(folder));
      } finally { busy = false; syncControls(); }
    },
  });
}

function newFile() {
  if (busy) return;
  const target = project;
  forms.show({
    title: "New File", description: `Create a file inside ${project.name}. Include a folder prefix to create missing folders.`,
    fields: [{ name: "path", label: "Relative file path", placeholder: "pkg/example.go" }],
    async run({ path }) {
      if (target !== project) throw new Error("This workspace has changed.");
      validateRelative(path);
      await target.createFile(path);
      await refresh();
      await openFile(path);
      status(`Created ${path}`);
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

async function runTask(kind: TaskKind) {
  if (task || busy || docs.saving) return;
  const target = project.native;
  if (!target) {
    toast(desktop ? "Open a local Go folder before running a task." : "Run, build and test are available in the macOS desktop app.");
    return;
  }
  if (!tools?.goVersion) { toast("Install Go, then check the toolchain in Settings.", true); return; }
  task = kind;
  stopPending = true;
  syncControls();
  feedback.show("output");
  status(`Preparing Go ${kind}…`);
  try {
    for (const tab of docs.tabs.values()) if (tab.dirty) await docs.save(tab);
    if (docs.dirty || project.native !== target) throw new Error("Files changed while saving. Run the task again.");
    const pkg = input(kind === "run" ? "run-package" : "task-scope").value.trim();
    await host.task(target.id, kind, pkg, event => {
      if (project.native !== target) return;
      const result = feedback.task(event);
      if (event.type === "started") {
        stopPending = false;
        status(`Go ${kind} running…`);
        syncControls();
      } else if (event.type === "finished") {
        task = undefined;
        stopPending = false;
        status(result ?? "Ready");
        syncControls();
      }
    });
  } catch (error) {
    if (project.native !== target) return;
    task = undefined;
    stopPending = false;
    status(`Go ${kind} not started`);
    feedback.row(message(error), "error", "error");
    showError(error);
    syncControls();
  }
}

async function stopTask() {
  const target = project.native;
  if (!target || !task || stopPending) return;
  stopPending = true;
  syncControls();
  try { await host.stop(target.id); }
  catch (error) { stopPending = false; syncControls(); showError(error); }
}

function updateTools() {
  const toolStatus = btn("tool-status");
  const version = tools?.goVersion?.replace(/^go/, "Go ");
  const state = !desktop ? "Preview" : !tools ? "Checking Go…" : version ?? "Go not found";
  const lspLabel = gopls === "ready" ? "gopls ready" : gopls === "starting" ? "gopls starting…" : gopls === "failed" ? "gopls stopped" : tools?.gopls ? "gopls available" : "gopls not installed";
  const detail = !desktop ? "Browser preview does not run local Go tools." : !tools ? "Detecting Go, gofmt, and gopls…" : `${state} · ${tools.gofmt ? "gofmt available" : "gofmt not found"} · ${lspLabel}`;
  byId("tool-version").textContent = state;
  toolStatus.title = detail;
  toolStatus.classList.toggle("good", !!version);
  toolStatus.classList.toggle("warn", desktop && !!tools && !version);
  byId("tools-info").textContent = project.native ? detail : desktop ? "Open a local Go folder to run tasks." : detail;
  byId("settings-tools-info").textContent = detail + (desktop && tools && !tools.gopls ? " Install with: go install golang.org/x/tools/gopls@latest" : "");
  btn("probe-tools").hidden = !desktop;
}

async function probeTools() {
  if (!desktop) return;
  btn("probe-tools").disabled = true;
  try { tools = await host.tools(); }
  catch (error) { tools = toolsMissing; showError(error); }
  finally { btn("probe-tools").disabled = false; }
  updateTools();
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

function showPalette(command = false, workspaceOnly = false) {
  const actions: { label: string; detail?: string; icon: Icon; run(): void; workspace?: boolean }[] = [
    { label: "Open Folder…", detail: "⌘O", icon: "folderOpen", run: openFolder, workspace: true },
    { label: "New Go Module…", icon: "package", run: newModule, workspace: true },
    { label: "New File…", icon: "filePlus", run: newFile, workspace: true },
    { label: "Open Orbit Sample", icon: "package", run: openSample, workspace: true },
    { label: "Refresh Explorer", icon: "refresh", run: () => { void refresh().catch(showError); }, workspace: true },
    { label: "Collapse Folders", icon: "folder", run: () => { opened.clear(); renderExplorer(); }, workspace: true },
    { label: "Search Saved Files", detail: "⇧⌘F", icon: "search", run: () => chooseView("search") },
    { label: "Save File", detail: "⌘S", icon: "save", run: saveActive },
    { label: "Reload File from Disk", icon: "refresh", run: reloadActive },
    { label: "Format Go File", detail: "⇧⌥F", icon: "format", run: formatActive },
    { label: "Go: Run Package", detail: "⌘↵", icon: "play", run: () => { void runTask("run"); } },
    { label: "Go: Build Packages", icon: "hammer", run: () => { void runTask("build"); } },
    { label: "Go: Run Tests", icon: "flask", run: () => { void runTask("test"); } },
    { label: "Go: Stop Task", icon: "stop", run: stopTask },
    { label: "Toggle Sidebar", detail: "⌘B", icon: "files", run: toggleSidebar },
    { label: "Toggle Bottom Panel", detail: "⌘J", icon: "layout", run: () => feedback.toggle() },
    { label: "Workbench Settings", detail: "⌘,", icon: "settings", run: showSettings },
    { label: "Color Theme: Dark", icon: "settings", run: () => chooseColorTheme("dark") },
    { label: "Color Theme: Light", icon: "settings", run: () => chooseColorTheme("light") },
  ];
  const paths = snapshot.entries.filter(entry => !entry.directory).map(entry => entry.path);
  palette.show(workspaceOnly ? "Workspace actions" : command ? "Type a command" : "Type a path to go to a file", query => {
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
byId("quick-open").addEventListener("click", () => showPalette());
byId("empty-quick-open").addEventListener("click", () => showPalette());
byId("workspace-actions").addEventListener("click", () => showPalette(false, true));
byId("open-folder").addEventListener("click", openFolder);
byId("toggle-sidebar").addEventListener("click", toggleSidebar);
byId("new-file").addEventListener("click", newFile);
byId("refresh-files").addEventListener("click", () => { void refresh().catch(showError); });
byId("format").addEventListener("click", formatActive);
byId("save").addEventListener("click", saveActive);
byId("run").addEventListener("click", () => { if (task) void stopTask(); else void runTask("run"); });
byId("panel-stop").addEventListener("click", stopTask);
byId("stop-task").addEventListener("click", stopTask);
byId("settings").addEventListener("click", showSettings);
byId("tool-status").addEventListener("click", showSettings);
byId("probe-tools").addEventListener("click", probeTools);
input("search-text").addEventListener("input", scheduleSearch);
byId("search-case").addEventListener("click", event => {
  const button = event.currentTarget as HTMLButtonElement;
  button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
  scheduleSearch();
});
byId("search-form").addEventListener("submit", event => { event.preventDefault(); scheduleSearch(); });
input("import-folder").addEventListener("change", () => {
  const picker = input("import-folder");
  if (picker.files?.length) void install(importedProject(picker.files)).catch(showError);
  picker.value = "";
});

document.addEventListener("keydown", event => {
  if (event.isComposing || (document.querySelector("dialog[open]") && event.key !== "Escape")) return;
  const key = event.key.toLowerCase();
  const cmd = event.metaKey || (!desktop && event.ctrlKey);
  let apply: (() => unknown) | undefined;
  if (cmd && !event.altKey) {
    if (key === "p") apply = () => showPalette(event.shiftKey);
    if (key === "o") apply = openFolder;
    if (key === "s") apply = saveActive;
    if (key === "f" && event.shiftKey) apply = () => chooseView("search");
    if (key === "e" && event.shiftKey) apply = () => chooseView("explorer");
    if (key === "j") apply = () => feedback.toggle();
    if (key === "b") apply = toggleSidebar;
    if (key === ",") apply = showSettings;
    if (key === "enter") apply = () => task ? stopTask() : runTask("run");
  }
  if (event.altKey && event.shiftKey && (key === "f" || event.code === "KeyF")) apply = formatActive;
  if (apply) { event.preventDefault(); event.stopPropagation(); void apply(); }
}, true);

docs.editor.onDidChangeCursorPosition(updateCursor);
monaco.editor.onDidChangeMarkers(renderProblems);
bindLayout();
bindSettings();
if (desktop) {
  void getCurrentWindow().onCloseRequested(event => {
    event.preventDefault();
    if (!docs.saving && !busy && (!docs.dirty || window.confirm("Quit and discard unsaved changes?"))) {
      void getCurrentWindow().destroy().catch(showError);
    }
  }).catch(showError);
} else {
  window.addEventListener("beforeunload", event => {
    if (docs.dirty) { event.preventDefault(); event.returnValue = ""; }
  });
}

if (import.meta.env.VITE_IRON_E2E === "1") {
  Object.assign(window, { __ironTest: {
    snapshot: () => ({ root: project.native?.path, path: docs.active?.path, text: docs.active && bufferText(docs.active.model), dirty: docs.active?.dirty,
      markers: docs.active ? monaco.editor.getModelMarkers({ resource: docs.active.model.uri }) : [], gopls }),
    replace: (value: string) => { if (docs.active) replaceBuffer(docs.active.model, value); },
    suggest: (lineNumber: number, column: number) => {
      docs.editor.setPosition({ lineNumber, column });
      docs.editor.focus();
      docs.editor.trigger("iron-test", "editor.action.triggerSuggest", {});
    },
    action: (id: string, lineNumber: number, column: number) => {
      docs.editor.setPosition({ lineNumber, column });
      docs.editor.focus();
      // Some built-ins (including Go to Definition) are registered with
      // Monaco's command service, not in editor.getAction().
      docs.editor.trigger("iron-test", id, {});
    },
    quit: () => { void getCurrentWindow().destroy(); },
  } });
}

void install(project).catch(showError);
void probeTools();

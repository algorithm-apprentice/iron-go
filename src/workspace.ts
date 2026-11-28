import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { MAX_FILES, MAX_TEXT_BYTES, scanText, validateRelative, type ProjectSnapshot, type SearchResult } from "./project-model";

export const desktop = isTauri();

export type TaskKind = "run" | "build" | "test";
export interface RunLaunch { directory: string; args: string[]; environment: Record<string, string> }
export type TaskEvent =
  | { type: "started"; command: string; structuredTests?: boolean }
  | { type: "output"; stream: "stdout" | "stderr"; bytes: number[] }
  | { type: "notice"; message: string }
  | { type: "output_limit" }
  | { type: "finished"; success: boolean; code: number | null; cancelled: boolean };
export interface ToolStatus { goVersion: string | null; gofmt: boolean; gopls: boolean; delve: boolean }
export interface NativeFolder { id: number; name: string; path: string; editorSession?: SavedEditorSession; recentError?: string }
export type NewModuleOutcome = { kind: "cancelled" } | { kind: "opened"; workspace: NativeFolder }
  | { kind: "created_not_opened"; path: string; error: string } | { kind: "incomplete"; path: string; file: string; error: string };
export interface RunTarget { package: string; importPath: string }
export interface GoPackages { targets: RunTarget[]; allScopes: string[]; packagePaths: Record<string, string> }
export type ServerEvent = { type: "message"; message: unknown } | { type: "closed"; reason: string };
export type ProgramDebugEvent = ServerEvent | { type: "build"; event: TaskEvent } | { type: "ready"; output: string; path: string | null };
export type ReadableDisk = { kind: "text"; text: string; version: string };
export type VersionedText = { text: string; version?: string };
export type SavedFile = { path: string; version: string | null };
export type DraftRetirement = { id: number; revision: number };
export type DraftPayload = { text: string; baseline: string; version: string };
export type DraftItem = { writer: string; payload: string; path: string; projectPath: string; revision: number; modified: number; detached: boolean };
export type SavedEditorTab = { path: string; line: number; column: number; firstLine: number };
export type SavedEditorSession = { tabs: SavedEditorTab[]; active?: string };
export type RecentProject = { id: string; name: string; path: string };
export type WorkspaceMutation =
  | { kind: "new_folder"; path: string }
  | { kind: "move"; source: string; destination: string; version: string; revision: number; baselines: { path: string; version: string }[] }
  | { kind: "trash"; source: string; version: string; revision: number };
export type WorkspaceMutationResult = {
  outcome: { kind: "folder" | "trashed"; path: string }
    | { kind: "moved"; path: string; versions: Record<string, string> }
    | { kind: "stranded" | "unverified_move"; path: string; error: string };
  warning?: string;
};
export type TerminalSize = { cols: number; rows: number };
export type TerminalLaunch = { kind: "shell" } | { kind: "go"; package: string; launch: RunLaunch };
export type TerminalEvent = { type: "ready"; id: number } | { type: "output"; id: number; sequence: number; bytes: number[] }
  | { type: "build"; id: number; event: TaskEvent } | { type: "cleanup" | "closed"; id: number; reason: string };
export type DiskObservation = ReadableDisk | { kind: "missing" } | { kind: "unavailable" } | { kind: "retry" };

function channel<T>(handler: (event: T) => void) {
  const stream = new Channel<T>();
  stream.onmessage = handler;
  return stream;
}

export const host = {
  open: (retirement?: DraftRetirement) => invoke<NativeFolder | null>("open_workspace", { retirement }),
  create: (name: string, module: string, retirement?: DraftRetirement) => invoke<NewModuleOutcome>("new_module", { name, module, retirement }),
  close: (id: number, retirement?: DraftRetirement) => invoke<void>("close_workspace", { id, retirement }),
  resolveExit: (ticket: number, approve: boolean, retirement?: DraftRetirement) => invoke<boolean>("resolve_app_exit", { ticket, approve, retirement }),
  presentExit: (ticket: number) => invoke<boolean>("present_app_exit", { ticket }),
  tools: () => invoke<ToolStatus>("go_tools"),
  format: (text: string) => invoke<string>("format_go", { text }),
  discoverPackages: (id: number) => invoke<GoPackages>("discover_packages", { id }),
  goSourceRevision: (id: number) => invoke<string>("go_source_revision", { id }),
  readGoSource: (id: number, path: string) => invoke<{ path: string; text: string }>("read_go_source", { id, path }),
  startWatch: (id: number) => invoke<void>("start_workspace_watch", { id }),
  waitWatch: (id: number, revision: number) => invoke<number | null>("wait_workspace_watch", { id, revision }),
  task: (id: number, kind: TaskKind, packages: string[], testName: string | undefined, handle: (event: TaskEvent) => void, launch?: RunLaunch, rerunImportPath?: string) =>
    invoke<void>("start_task", { id, kind, packages, testName, launch, rerunImportPath, events: channel(handle) }),
  stop: (id: number) => invoke<void>("stop_task", { id }),
  lsp: (id: number, handle: (event: ServerEvent) => void) => invoke<number>("start_gopls", { id, events: channel(handle) }),
  send: (server: number, message: object) => invoke<void>("send_gopls", { server, message: JSON.stringify(message) }),
  stopLsp: (server: number) => invoke<void>("stop_gopls", { server }),
  debug: (id: number, pkg: string, handle: (event: ServerEvent) => void) =>
    invoke<{ server: number; output: string }>("start_debug", { id, package: pkg, events: channel(handle) }),
  debugProgram: (id: number, pkg: string, launch: RunLaunch, handle: (event: ProgramDebugEvent) => void) =>
    invoke<number>("start_program_debug", { id, package: pkg, launch, events: channel(handle) }),
  sendDebug: (server: number, message: object) => invoke<void>("send_debug", { server, message: JSON.stringify(message) }),
  stopDebug: (server: number) => invoke<void>("stop_debug", { server }),
  stopDebugProgram: (server: number) => invoke<void>("stop_program_debug", { server }),
  writeDraft: (id: number, path: string, revision: number, payload: DraftPayload) => invoke<void>("write_draft", { id, path, revision, payload }),
  retireDraft: (id: number, path: string, revision: number, reviewed?: ReadableDisk) => invoke<void>("retire_draft", { id, path, revision, reviewed }),
  listDrafts: (id?: number) => invoke<DraftItem[]>("list_drafts", { id }),
  recoverDraft: (id: number, { writer, payload, revision }: DraftItem) => invoke<{ payload: DraftPayload; observed: DiskObservation }>("recover_draft", { id, writer, payload, revision }),
  removeDraft: (id: number | undefined, { writer, payload, revision }: DraftItem) => invoke<void>("remove_draft", { id, writer, payload, revision }),
  listRecent: () => invoke<RecentProject[]>("list_recent"),
  openRecent: (entry: string, retirement?: DraftRetirement) => invoke<NativeFolder>("open_recent", { entry, retirement }),
  forgetRecent: (entry?: string) => invoke<void>("forget_recent", { entry }),
  writeEditorSession: (id: number, revision: number, editor: SavedEditorSession, quitTicket?: number) =>
    invoke<void>("write_editor_session", { id, revision, editor, quitTicket }),
  inspectFileOperation: (id: number, path: string) => invoke<{ version: string; directory: boolean }>("inspect_file_operation", { id, path }),
  mutateWorkspace: (id: number, operation: WorkspaceMutation) => invoke<WorkspaceMutationResult>("mutate_workspace_files", { id, operation }),
  startTerminal: (id: number, launch: TerminalLaunch, size: TerminalSize, handle: (event: TerminalEvent) => void) =>
    invoke<number>("start_terminal", { id, launch, size, events: channel(handle) }),
  stopTerminal: (terminal: number) => invoke<void>("stop_terminal", { terminal }),
  terminalInput: (terminal: number, text: string) => invoke<void>("terminal_input", { terminal, text }),
  terminalAck: (terminal: number, sequence: number) => invoke<void>("terminal_ack", { terminal, sequence }),
  terminalResize: (terminal: number, size: TerminalSize) => invoke<void>("terminal_resize", { terminal, size }),
};

export interface Project {
  readonly name: string;
  readonly native?: NativeFolder;
  readonly welcome?: boolean;
  snapshot(): Promise<ProjectSnapshot>;
  read(path: string): Promise<string>;
  readVersioned?(path: string): Promise<VersionedText>;
  inspect?(path: string): Promise<DiskObservation>;
  save(path: string, expected: string, text: string, reviewedVersion?: string, quitTicket?: number): Promise<void | string | null>;
  createFile(path: string): Promise<void>;
  createFromBuffer?(path: string, text: string): Promise<string | SavedFile>;
  search(query: string, caseSensitive: boolean): Promise<SearchResult>;
}

export function nativeProject(native: NativeFolder): Project {
  const { id } = native;
  const readVersioned = (path: string) => invoke<VersionedText>("read_file", { id, path });
  return {
    name: native.name, native,
    snapshot: () => invoke<ProjectSnapshot>("snapshot", { id }),
    read: async path => (await readVersioned(path)).text,
    readVersioned,
    inspect: (path) => invoke<DiskObservation>("inspect_file", { id, path }),
    save: (path, expected, text, reviewedVersion, quitTicket) => invoke<string | null>("save_file", { id, path, expected, text, reviewedVersion, quitTicket }),
    createFile: (path) => invoke<void>("create_file", { id, path }),
    createFromBuffer: (path, text) => invoke<SavedFile>("save_new_file", { id, path, text }),
    search: (query, caseSensitive) => invoke<SearchResult>("search_files", { id, query, caseSensitive }),
  };
}

export function welcomeProject(): Project {
  const unavailable = async () => { throw new Error("Open a project first."); };
  return {
    name: "No Project", welcome: true,
    snapshot: async () => ({ entries: [], truncated: false, module: null, goWork: false }),
    read: unavailable, save: unavailable, createFile: unavailable,
    search: async () => ({ matches: [], truncated: false }),
  };
}

const encoder = new TextEncoder();
function checkSize(text: string) {
  if (text.includes("\0") || encoder.encode(text).length > MAX_TEXT_BYTES) {
    throw new Error("The editor supports UTF-8 text files up to 2 MB.");
  }
}

function previewProject(name: string, input: Map<string, File>, importTruncated: boolean): Project {
  const edits = new Map<string, string>();
  const paths = () => [...new Set([...input.keys(), ...edits.keys()])].sort();
  const read = async (path: string) => {
    const value = edits.get(path) ?? input.get(path);
    if (value === undefined) throw new Error("This file no longer exists.");
    if (typeof value !== "string" && value.size > MAX_TEXT_BYTES) throw new Error("This file is larger than 2 MB.");
    const text = typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await value.arrayBuffer());
    checkSize(text);
    return text;
  };
  return {
    name, read,
    async snapshot() {
      const all = paths();
      const mod = await read("go.mod").catch(() => "");
      return {
        entries: all.slice(0, MAX_FILES).map(path => ({ path, directory: false })),
        module: mod.match(/^\s*module\s+"?([^"\s]+)/m)?.[1] ?? null,
        truncated: importTruncated || all.length > MAX_FILES,
        goWork: all.includes("go.work"),
      };
    },
    async save(path, expected, text) {
      checkSize(text);
      if (await read(path) !== expected) throw new Error("The saved content changed. Reload the tab before saving.");
      edits.set(path, text);
    },
    async createFile(path) {
      validateRelative(path);
      const all = paths();
      if (all.some(existing => existing === path || existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`))) {
        throw new Error("That path already exists or contains a file where a directory is needed.");
      }
      edits.set(path, "");
    },
    async search(query, caseSensitive) {
      const matches: SearchResult["matches"] = [];
      let bytes = 0;
      const all = paths();
      let truncated = importTruncated || all.length > MAX_FILES;
      for (const path of all.slice(0, MAX_FILES)) {
        const text = await read(path).catch(() => "");
        const size = encoder.encode(text).length;
        if (size > 512 * 1024) continue;
        bytes += size;
        if (bytes > 32 * 1024 * 1024) { truncated = true; break; }
        matches.push(...scanText(path, text, query, caseSensitive, 201 - matches.length));
        if (matches.length > 200) { truncated = true; break; }
      }
      return { matches: matches.slice(0, 200), truncated };
    },
  };
}

export function importedProject(files: FileList) {
  const name = files[0]?.webkitRelativePath.split("/")[0] ?? "Folder";
  const input = new Map<string, File>();
  for (const file of files) {
    if (input.size >= MAX_FILES) break;
    const path = file.webkitRelativePath.slice(name.length + 1);
    try { input.set(validateRelative(path), file); } catch { /* Excluded entry. */ }
  }
  return previewProject(name, input, input.size >= MAX_FILES && files.length > input.size);
}

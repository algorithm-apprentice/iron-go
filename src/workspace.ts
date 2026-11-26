import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import mainGo from "../examples/orbit/cmd/orbit/main.go?raw";
import reportGo from "../examples/orbit/internal/status/report.go?raw";
import reportTest from "../examples/orbit/internal/status/report_test.go?raw";
import goMod from "../examples/orbit/go.mod?raw";
import readme from "../examples/orbit/README.md?raw";
import { MAX_FILES, MAX_TEXT_BYTES, scanText, validateRelative, type ProjectSnapshot, type SearchResult } from "./project-model";

export const desktop = isTauri();

export type TaskKind = "run" | "build" | "test";
export type TaskEvent =
  | { type: "started"; command: string }
  | { type: "output"; stream: "stdout" | "stderr"; bytes: number[] }
  | { type: "notice"; message: string }
  | { type: "finished"; success: boolean; code: number | null; cancelled: boolean };
export interface ToolStatus { goVersion: string | null; gofmt: boolean; gopls: boolean }
export interface NativeFolder { id: number; name: string; path: string }
export interface RunTarget { package: string; importPath: string }
export interface GoPackages { targets: RunTarget[]; allScopes: string[] }
export type ServerEvent = { type: "message"; message: unknown } | { type: "closed"; reason: string };

function channel<T>(handler: (event: T) => void) {
  const stream = new Channel<T>();
  stream.onmessage = handler;
  return stream;
}

export const host = {
  open: () => invoke<NativeFolder | null>("open_workspace"),
  create: (name: string, module: string) => invoke<NativeFolder | null>("new_module", { name, module }),
  close: (id: number) => invoke<void>("close_workspace", { id }),
  tools: () => invoke<ToolStatus>("go_tools"),
  format: (text: string) => invoke<string>("format_go", { text }),
  discoverPackages: (id: number) => invoke<GoPackages>("discover_packages", { id }),
  task: (id: number, kind: TaskKind, packages: string[], testName: string | undefined, handle: (event: TaskEvent) => void) =>
    invoke<void>("start_task", { id, kind, packages, testName, events: channel(handle) }),
  stop: (id: number) => invoke<void>("stop_task", { id }),
  lsp: (id: number, handle: (event: ServerEvent) => void) => invoke<number>("start_gopls", { id, events: channel(handle) }),
  send: (server: number, message: object) => invoke<void>("send_gopls", { server, message: JSON.stringify(message) }),
  stopLsp: (server: number) => invoke<void>("stop_gopls", { server }),
};

export interface Project {
  readonly name: string;
  readonly native?: NativeFolder;
  readonly sample?: boolean;
  snapshot(): Promise<ProjectSnapshot>;
  read(path: string): Promise<string>;
  save(path: string, expected: string, text: string): Promise<void>;
  createFile(path: string): Promise<void>;
  search(query: string, caseSensitive: boolean): Promise<SearchResult>;
}

export function nativeProject(native: NativeFolder): Project {
  const { id } = native;
  return {
    name: native.name, native,
    snapshot: () => invoke<ProjectSnapshot>("snapshot", { id }),
    read: (path) => invoke<string>("read_file", { id, path }),
    save: (path, expected, text) => invoke<void>("save_file", { id, path, expected, text }),
    createFile: (path) => invoke<void>("create_file", { id, path }),
    search: (query, caseSensitive) => invoke<SearchResult>("search_files", { id, query, caseSensitive }),
  };
}

const encoder = new TextEncoder();
function checkSize(text: string) {
  if (text.includes("\0") || encoder.encode(text).length > MAX_TEXT_BYTES) {
    throw new Error("The editor supports UTF-8 text files up to 2 MB.");
  }
}

function previewProject(
  name: string, input: Map<string, string | File>, sample = false, importTruncated = false,
): Project {
  const edits = new Map<string, string>();
  const key = "irongo.sample.v1";
  if (sample) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
      for (const [path, content] of Object.entries(saved)) {
        if (typeof content !== "string") continue;
        validateRelative(path);
        checkSize(content);
        edits.set(path, content);
      }
    } catch { /* An unavailable or corrupt browser store should not block the sample. */ }
  }
  const paths = () => [...new Set([...input.keys(), ...edits.keys()])].sort();
  const read = async (path: string) => {
    const value = edits.get(path) ?? input.get(path);
    if (value === undefined) throw new Error("This file no longer exists.");
    if (typeof value !== "string" && value.size > MAX_TEXT_BYTES) throw new Error("This file is larger than 2 MB.");
    const text = typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await value.arrayBuffer());
    checkSize(text);
    return text;
  };
  const persist = (path: string, text: string) => {
    if (sample) localStorage.setItem(key, JSON.stringify(Object.fromEntries(new Map([...edits, [path, text]]))));
    edits.set(path, text);
  };
  return {
    name, sample, read,
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
      persist(path, text);
    },
    async createFile(path) {
      validateRelative(path);
      const all = paths();
      if (all.some(existing => existing === path || existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`))) {
        throw new Error("That path already exists or contains a file where a directory is needed.");
      }
      persist(path, "");
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

export function sampleProject() {
  return previewProject("orbit", new Map([
    ["cmd/orbit/main.go", mainGo], ["internal/status/report.go", reportGo],
    ["internal/status/report_test.go", reportTest], ["go.mod", goMod], ["README.md", readme],
  ]), true);
}

export function importedProject(files: FileList) {
  const name = files[0]?.webkitRelativePath.split("/")[0] ?? "Folder";
  const input = new Map<string, File>();
  for (const file of files) {
    if (input.size >= MAX_FILES) break;
    const path = file.webkitRelativePath.slice(name.length + 1);
    try { input.set(validateRelative(path), file); } catch { /* Excluded entry. */ }
  }
  return previewProject(name, input, false, input.size >= MAX_FILES && files.length > input.size);
}

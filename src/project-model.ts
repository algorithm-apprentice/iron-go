export interface Entry { path: string; directory: boolean }
export interface FileMatch { path: string; line: number; column: number; length: number; preview: string }
export interface SearchResult { matches: FileMatch[]; truncated: boolean }
export interface ProjectSnapshot { entries: Entry[]; truncated: boolean; module: string | null; goWork: boolean; packageRevision?: string }
export interface TreeNode extends Entry { name: string; children: TreeNode[] }

const excluded = new Set([".git", ".DS_Store", "node_modules"]);
export const MAX_FILES = 6_000;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export const basename = (path: string) => path.split("/").at(-1) ?? path;
export const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

export function validateRelative(path: string) {
  const parts = path.split("/");
  if (parts.length > 40 || parts.some(part => !part || part === "." || part === ".." || /[\\\0\n\r]/.test(part) || excluded.has(part))) {
    throw new Error("Use a relative workspace path such as pkg/file.go.");
  }
  return path;
}

export function makeTree(entries: Entry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", directory: true, children: [] };
  const nodes = new Map<string, TreeNode>([["", root]]);
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let parent = root;
    for (const [index, name] of parts.entries()) {
      const path = parent.path ? `${parent.path}/${name}` : name;
      let node = nodes.get(path);
      if (!node) {
        node = { name, path, directory: entry.directory || index < parts.length - 1, children: [] };
        nodes.set(path, node);
        parent.children.push(node);
      }
      parent = node;
    }
  }
  for (const node of nodes.values()) {
    node.children.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  }
  return root.children;
}

export function initialWorkspaceFile(entries: Entry[]): string | undefined {
  const files = entries.filter(entry => !entry.directory).map(entry => entry.path);
  return files.find(path => path === "main.go") ?? files.find(path => /^cmd\/[^/]+\/main\.go$/.test(path))
    ?? files.find(path => path.endsWith("/main.go")) ?? files.find(path => path.endsWith(".go")) ?? files[0];
}

export function quickFiles(paths: string[], input: string, limit = 60) {
  const terms = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return paths.flatMap(path => {
    const key = path.toLowerCase();
    if (!terms.every(term => key.includes(term))) return [];
    const name = basename(key);
    const score = terms.reduce((sum, term) => sum + (name === term ? 0 : name.startsWith(term) ? 1 : name.includes(term) ? 2 : 3), 0);
    return [{ path, score }];
  }).sort((a, b) => a.score - b.score || a.path.localeCompare(b.path)).slice(0, limit).map(entry => entry.path);
}

export function scanText(path: string, text: string, query: string, caseSensitive: boolean, limit: number): FileMatch[] {
  if (!query || limit <= 0) return [];
  const found: FileMatch[] = [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, caseSensitive ? "gu" : "giu");
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(pattern)) {
      found.push({ path, line: index + 1, column: match.index + 1, length: match[0].length, preview: line.trim().slice(0, 240) });
      if (found.length === limit) return found;
    }
  }
  return found;
}

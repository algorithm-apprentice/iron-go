import type { CodeAction, Command, TextEdit, WorkspaceEdit } from "vscode-languageserver-types";

export function decodeLocalFileUri(uri: string) {
  const rawPath = /^file:\/\/\/(?!\/)[^?#\\\s\u0000-\u001f\u007f-\u009f]+$/u;
  if (!rawPath.test(uri) || /%2f|%5c|%(?![a-f0-9]{2})/i.test(uri)) return;
  try { return decodeURIComponent(uri.slice("file://".length)); }
  catch { return; }
}

export function organizeImportEdits(actions: (CodeAction | Command)[], uri: string, version: number): TextEdit[] | undefined {
  if (!Array.isArray(actions)) throw new Error("gopls returned malformed import actions.");
  const action = actions.find((candidate): candidate is CodeAction => !!candidate && typeof candidate === "object" && "kind" in candidate &&
    candidate.kind === "source.organizeImports" && !candidate.disabled && !candidate.command && !!candidate.edit);
  const edit = action?.edit;
  if (!edit) return;
  const path = decodeLocalFileUri(uri);
  if (!path) throw new Error("This editor has no valid local file URI.");
  const targets = workspaceTextEdits(edit);
  if ([...targets.keys()].some(target => target !== path)) throw new Error("An import edit cannot touch another file.");
  const target = targets.get(path);
  if (target?.version != null && target.version !== version) throw new Error("The import edit names a different editor version.");
  return target?.edits ?? [];
}

export function workspaceTextEdits(edit: WorkspaceEdit) {
  const hasChanges = Object.hasOwn(edit, "changes");
  const hasDocumentChanges = Object.hasOwn(edit, "documentChanges");
  if (Object.hasOwn(edit, "changeAnnotations") || (hasChanges && hasDocumentChanges)) throw new Error("gopls returned an ambiguous edit.");
  const targets = new Map<string, { version: number | null; edits: TextEdit[] }>();
  const add = (uri: string, version: number | null, edits: TextEdit[]) => {
    const path = decodeLocalFileUri(uri);
    if (!path) throw new Error("The edit names another file or an invalid local URI.");
    if (targets.has(path)) throw new Error("gopls returned duplicate edits for this file.");
    if (!Array.isArray(edits) || edits.some(candidate => !candidate || typeof candidate !== "object" ||
      typeof candidate.newText !== "string" || !candidate.range || "annotationId" in candidate)) {
      throw new Error("gopls returned an edit that is not plain text.");
    }
    targets.set(path, { version, edits });
  };
  if (hasDocumentChanges) {
    if (!Array.isArray(edit.documentChanges)) throw new Error("gopls returned a malformed import edit.");
    for (const change of edit.documentChanges) {
      if (!change || typeof change !== "object" || "kind" in change || !("textDocument" in change)) {
        throw new Error("The edit cannot include a resource operation.");
      }
      if (!change.textDocument || typeof change.textDocument.uri !== "string" || !Array.isArray(change.edits)) {
        throw new Error("gopls returned a malformed import edit.");
      }
      if (change.textDocument.version !== null && !Number.isInteger(change.textDocument.version)) throw new Error("The edit has an invalid document version.");
      add(change.textDocument.uri, change.textDocument.version, change.edits as TextEdit[]);
    }
  } else if (hasChanges) {
    if (!edit.changes || typeof edit.changes !== "object" || Array.isArray(edit.changes)) throw new Error("gopls returned a malformed import edit.");
    for (const [uri, edits] of Object.entries(edit.changes)) add(uri, null, edits);
  }
  return targets;
}

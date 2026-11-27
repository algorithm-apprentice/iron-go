import type { CodeAction, Command, TextEdit } from "vscode-languageserver-types";

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
  const isCapturedFile = (target: string) => decodeLocalFileUri(target) === path;
  const hasChanges = Object.hasOwn(edit, "changes");
  const hasDocumentChanges = Object.hasOwn(edit, "documentChanges");
  if (Object.hasOwn(edit, "changeAnnotations") || (hasChanges && hasDocumentChanges)) throw new Error("gopls returned an ambiguous import edit.");
  let edits: TextEdit[] | undefined;
  if (hasDocumentChanges) {
    if (!Array.isArray(edit.documentChanges)) throw new Error("gopls returned a malformed import edit.");
    for (const change of edit.documentChanges) {
      if (!change || typeof change !== "object" || "kind" in change || !("textDocument" in change)) {
        throw new Error("An import edit cannot include a resource operation.");
      }
      if (!change.textDocument || typeof change.textDocument.uri !== "string" || !Array.isArray(change.edits)) {
        throw new Error("gopls returned a malformed import edit.");
      }
      if (!isCapturedFile(change.textDocument.uri)) throw new Error("An import edit cannot touch another file.");
      if (change.textDocument.version !== null && change.textDocument.version !== version) {
        throw new Error("The import edit names a different editor version.");
      }
      if (edits !== undefined) throw new Error("gopls returned duplicate import edits for this file.");
      edits = change.edits as TextEdit[];
    }
  } else if (hasChanges) {
    if (!edit.changes || typeof edit.changes !== "object" || Array.isArray(edit.changes)) throw new Error("gopls returned a malformed import edit.");
    const targets = Object.entries(edit.changes);
    if (targets.some(([target]) => !isCapturedFile(target))) throw new Error("An import edit cannot touch another file.");
    if (targets.length > 1) throw new Error("gopls returned duplicate import edits for this file.");
    edits = targets[0]?.[1];
  }
  if (!edits) return [];
  if (!Array.isArray(edits) || edits.some(candidate => !candidate || typeof candidate !== "object" ||
    typeof candidate.newText !== "string" || !candidate.range || "annotationId" in candidate)) {
    throw new Error("gopls returned an import edit that is not plain text.");
  }
  return edits;
}

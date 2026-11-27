import assert from "node:assert/strict";
import { test } from "node:test";
import { organizeImportEdits } from "../src/go-import-edits.ts";

const uri = "file:///workspace/main.go";
const text = { range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, newText: "" };
const action = edit => ({ title: "Organize Imports", kind: "source.organizeImports", edit });

test("only an enabled direct organize action for the captured version is accepted", () => {
  const actionWithEdit = action({ changes: { [uri]: [text] } });
  assert.deepEqual(organizeImportEdits([actionWithEdit], uri, 3), [text]);
  assert.deepEqual(organizeImportEdits([action({ documentChanges: [{ textDocument: { uri, version: 3 }, edits: [text] }] })], uri, 3), [text]);
  for (const unsupported of [
    { ...actionWithEdit, command: { title: "Run", command: "example.command" } },
    { ...actionWithEdit, disabled: { reason: "not applicable" } },
    { title: "Run", command: "example.command" },
  ]) assert.equal(organizeImportEdits([unsupported], uri, 3), undefined);
  assert.throws(() => organizeImportEdits([action({ documentChanges: [{ textDocument: { uri, version: 2 }, edits: [text] }] })], uri, 3), /version/i);
});

test("an organize edit cannot touch another file or perform a resource operation", () => {
  assert.throws(() => organizeImportEdits([action({ changes: { [uri]: [text], "file:///workspace/other.go": [text] } })], uri, 3), /another file/i);
  assert.throws(() => organizeImportEdits([action({ documentChanges: [{ kind: "delete", uri }] })], uri, 3), /resource operation/i);
  assert.throws(() => organizeImportEdits([action({ documentChanges: [{ kind: "delete", textDocument: { uri, version: 3 }, edits: [text] }] })], uri, 3), /resource operation/i);
  assert.throws(() => organizeImportEdits([action({ changes: { [uri]: [{ ...text, annotationId: "approval" }] } })], uri, 3), /plain text/i);
  assert.throws(() => organizeImportEdits([action({ changes: { [uri]: [text] }, documentChanges: null })], uri, 3), /ambiguous/i);
  assert.throws(() => organizeImportEdits([action({ documentChanges: null })], uri, 3), /malformed/i);
});

test("valid URI escape spellings name the same file, without filesystem aliases", () => {
  const encoded = "file:///workspace/review%40source.go";
  assert.deepEqual(organizeImportEdits([action({ changes: { "file:///workspace/review@source.go": [text] } })], encoded, 3), [text]);
  for (const invalid of ["file:///workspace/REVIEW@SOURCE.go", "file:///workspace/review%40source.go#", "file:///workspace%2Freview@source.go"]) {
    assert.throws(() => organizeImportEdits([action({ changes: { [invalid]: [text] } })], encoded, 3), /another file/i);
  }
});

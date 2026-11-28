import assert from "node:assert/strict";
import { test } from "node:test";
import { goDefinitionPath } from "../src/go-import-edits.ts";

test("definition targets require local, canonical lexical paths", () => {
  assert.equal(goDefinitionPath("file:///some%20folder/pkg/file.go"), "/some folder/pkg/file.go");
  for (const uri of ["file://other/root/a.go", "https://example.test/a.go", "file:///x/%00.go",
    "file:///x/%2e/a.go", "file:///x/%2e%2e/a.go", "file:///x//a.go", "file:///x/a%5cb.go"]) {
    assert.equal(goDefinitionPath(uri), undefined, uri);
  }
});

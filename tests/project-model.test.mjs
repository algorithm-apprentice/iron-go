import assert from "node:assert/strict";
import { test } from "node:test";
import { initialWorkspaceFile, makeTree, quickFiles, scanText, validateRelative } from "../src/project-model.ts";

const files = (...paths) => paths.map(path => ({ path, directory: false }));

test("constructs parent folders once and places folders before files", () => {
  const tree = makeTree([...files("README.md", "cmd/app/main.go", "cmd/app/main_test.go"), { path: "empty", directory: true }]);
  assert.deepEqual(tree.map(node => node.path), ["cmd", "empty", "README.md"]);
  assert.deepEqual(tree[0].children[0].children.map(node => node.name), ["main_test.go", "main.go"].sort((a, b) => a.localeCompare(b)));
  assert.equal(tree[1].directory, true);
});

test("opens a conventional entry file before other Go files, without choosing a run target", () => {
  assert.equal(initialWorkspaceFile(files("main.go", "cmd/app/main.go")), "main.go");
  assert.equal(initialWorkspaceFile(files("hello/main.go", "cmd/app/main.go")), "cmd/app/main.go");
  assert.equal(initialWorkspaceFile(files("local/main.go")), "local/main.go");
  assert.equal(initialWorkspaceFile(files("readme.md", "pkg/example.go")), "pkg/example.go");
});

test("quick open finds path terms and ranks basename matches", () => {
  const paths = ["lib/report/check.go", "internal/status/report.go", "README.md"];
  assert.deepEqual(quickFiles(paths, "REPORT"), ["internal/status/report.go", "lib/report/check.go"]);
  assert.deepEqual(quickFiles(paths, "status report"), ["internal/status/report.go"]);
});

test("search is literal and returns UTF-16 columns with case matching", () => {
  const text = "🚀 Foo.* foo.*\nFoo!";
  assert.deepEqual(scanText("file.go", text, "foo.*", false, 4).map(match => [match.line, match.column, match.length]), [[1, 4, 5], [1, 10, 5]]);
  assert.equal(scanText("file.go", text, "foo.*", true, 4).length, 1);
});

test("rejects absolute paths, traversal, and excluded subtrees", () => {
  for (const path of ["/file.go", "../local", "pkg/./file.go", "x/.git/config", "x\\y", "x//y"]) {
    assert.throws(() => validateRelative(path), /relative workspace path/);
  }
  assert.equal(validateRelative("some project/main.go"), "some project/main.go");
});

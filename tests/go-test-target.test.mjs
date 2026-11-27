import assert from "node:assert/strict";
import { test } from "node:test";
import { SymbolKind } from "vscode-languageserver-types";
import { CursorTestLookup, goTestAt } from "../src/go-test-target.ts";

const at = (line, character = 0) => ({ line, character });
const fn = (name, start, end, kind = SymbolKind.Function) => ({ name, kind,
  range: { start: at(start), end: at(end, 1) }, selectionRange: { start: at(start, 5), end: at(start, 12) } });

test("caret lookup uses the full enclosing top-level test and excludes its end", () => {
  const first = fn("TestFirst", 2, 6);
  first.children = [fn("TestNested", 3, 4)];
  const symbols = [first, fn("helper", 8, 10), fn("TestNext", 12, 16), fn("Testlower", 18, 19), fn("TestMethod", 21, 22, SymbolKind.Method)];
  assert.equal(goTestAt(symbols, at(2)), "TestFirst");
  assert.equal(goTestAt(symbols, at(4, 2)), "TestFirst");
  assert.equal(goTestAt(symbols, at(6)), "TestFirst");
  assert.equal(goTestAt(symbols, at(6, 1)), undefined);
  assert.equal(goTestAt(symbols, at(7)), undefined);
  assert.equal(goTestAt(symbols, at(9)), undefined);
  assert.equal(goTestAt(symbols, at(14)), "TestNext");
  assert.equal(goTestAt(symbols, at(18)), undefined);
  assert.equal(goTestAt(symbols, at(21)), undefined);
  assert.equal(goTestAt([{ name: "TestFlat", kind: SymbolKind.Function, location: { uri: "file:///main_test.go", range: first.range } }], at(3)), undefined);
});

test("an invalidation fences an outstanding result even when final state has returned", async () => {
  for (const event of ["caret move", "tab change", "canceled project reservation"]) {
    const lookup = new CursorTestLookup();
    const pending = Promise.withResolvers();
    const done = lookup.resolve(() => pending.promise, () => true, () => assert.fail(event));
    lookup.invalidate();
    pending.resolve("TestOld");
    await done;
  }
});

test("newer invocation wins, and an obsolete model version cannot hand off", async () => {
  const lookup = new CursorTestLookup();
  const old = Promise.withResolvers();
  const published = [];
  const pending = lookup.resolve(() => old.promise, () => true, name => published.push(name));
  await lookup.resolve(async () => "TestCurrent", () => true, name => published.push(name));
  old.resolve("TestOld");
  await pending;
  await lookup.resolve(async () => "TestEdited", () => false, name => published.push(name));
  assert.deepEqual(published, ["TestCurrent"]);
});

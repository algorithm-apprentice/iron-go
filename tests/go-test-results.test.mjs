import assert from "node:assert/strict";
import { test } from "node:test";
import { GoTestStream } from "../src/go-test-stream.ts";

const encode = events => new TextEncoder().encode(events.map(event => JSON.stringify(event) + "\n").join(""));

test("split UTF-8 test events retain readable output, status, and full source paths", () => {
  const stream = new GoTestStream();
  const bytes = encode([
    { Action: "start", Package: "example.test/p" },
    { Action: "run", Package: "example.test/p", Test: "TestParent/🚀" },
    { Action: "output", Package: "example.test/p", Test: "TestParent/🚀", Output: "    /fixture/source_test.go:12: 🚀 failure\n" },
    { Action: "fail", Package: "example.test/p", Test: "TestParent/🚀", Elapsed: 0.02 },
    { Action: "skip", Package: "example.test/p", Test: "TestSkip" },
    { Action: "fail", Package: "example.test/p" },
  ]);
  const output = [...bytes].map(byte => stream.push(Uint8Array.of(byte))).join("") + stream.finish(false);
  assert.equal(output, "    /fixture/source_test.go:12: 🚀 failure\n");
  const pkg = stream.packages.get("example.test/p");
  assert.equal(pkg.status, "fail");
  assert.equal(pkg.tests.get("TestParent/🚀").elapsed, 0.02);
  assert.deepEqual(pkg.tests.get("TestParent/🚀").location, { absolute: "/fixture/source_test.go", line: 12, column: 1 });
  assert.equal(pkg.tests.get("TestSkip").status, "skip");
  assert.equal(stream.incomplete, false);
});

test("test package failures retain the identity of the build variant or dependency", () => {
  const stream = new GoTestStream();
  const variant = "example.test/p [example.test/p.test]";
  stream.push(encode([
    { Action: "build-output", ImportPath: variant, Output: "./source_test.go:9: broken\n" },
    { Action: "build-fail", ImportPath: variant },
    { Action: "build-fail", ImportPath: "example.test/dependency" },
    { Action: "fail", Package: "example.test/p", FailedBuild: variant },
    { Action: "fail", Package: "example.test/other", FailedBuild: "example.test/dependency" },
  ]));
  stream.finish(false);
  assert.equal(stream.buildFailures.get(variant).failed, true);
  assert.equal(stream.buildFailures.get(variant).location, undefined);
  assert.equal(stream.packages.get("example.test/other").failedBuild, "example.test/dependency");
});

test("unreliable or cancelled streams never mark unfinished tests as passes", () => {
  const stream = new GoTestStream();
  stream.push(encode([{ Action: "run", Package: "example.test/p", Test: "TestPending" }]));
  assert.equal(stream.push(new TextEncoder().encode("not json\n")), "not json\n");
  stream.wireTruncated();
  stream.finish(true);
  assert.equal(stream.incomplete, true);
  assert.equal(stream.packages.get("example.test/p").tests.get("TestPending").status, "incomplete");
});

test("the wire cutoff alone marks an otherwise complete test run incomplete", () => {
  const stream = new GoTestStream();
  stream.push(encode([{ Action: "start", Package: "example.test/p" }, { Action: "pass", Package: "example.test/p" }]));
  assert.equal(stream.incomplete, false);
  stream.wireTruncated();
  stream.finish(false);
  assert.equal(stream.incomplete, true);
  assert.equal(stream.packages.get("example.test/p").status, "pass");
});

test("repeated tests keep failures and link to errors instead of setup logs", () => {
  const stream = new GoTestStream();
  const key = { Package: "example.test/p", Test: "TestRepeated" };
  stream.push(encode([
    { ...key, Action: "run" },
    { ...key, Action: "output", Output: "/fixture/test.go:2: setup\n" },
    { ...key, Action: "output", Output: "/fixture/test.go:3: failure\n", OutputType: "error" },
    { ...key, Action: "fail" }, { ...key, Action: "run" }, { ...key, Action: "pass" },
  ]));
  const repeated = stream.packages.get(key.Package).tests.get(key.Test);
  assert.equal(repeated.status, "fail");
  assert.equal(repeated.location.line, 3);
  stream.push(encode([{ ...key, Action: "run" }]));
  stream.finish(true);
  assert.equal(repeated.status, "incomplete");
  assert.equal(repeated.sawFailure, true);
});

test("bounded rows and overlong fragments do not prevent later package terminal events", () => {
  const stream = new GoTestStream();
  stream.push(encode(Array.from({ length: 2050 }, (_, index) => ({ Action: "pass", Package: "example.test/p", Test: `Test${index}` }))));
  stream.push(new Uint8Array(70 * 1024).fill(0x61));
  stream.push(new TextEncoder().encode("discarded tail\n"));
  stream.push(encode([{ Action: "pass", Package: "example.test/p" }]));
  stream.finish(false);
  const pkg = stream.packages.get("example.test/p");
  assert.equal(stream.incomplete, true);
  assert.equal(pkg.tests.size, 1999);
  assert.equal(pkg.status, "pass");
});

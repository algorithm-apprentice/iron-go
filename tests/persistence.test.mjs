import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const source = name => fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url));
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

async function loadSource(entry, plugins = []) {
  const [bundle] = await build({ configFile: false, logLevel: "warn", plugins, build: {
    lib: { entry, formats: ["es"] }, minify: false, write: false, target: "esnext",
  } });
  const chunks = bundle.output.filter(output => output.type === "chunk");
  assert.equal(chunks.length, 1, "the unit must compile to a single in-memory module");
  return import(moduleUrl(chunks[0].code));
}

let DraftRecorder, readSaved, storage;
before(async () => {
  const draftSource = source("draft-recorder");
  const fakeDraftBoundary = moduleUrl(`
    export const host = {};
    export const bufferText = model => model.getValue(undefined, true);
  `);
  const { host } = await import(fakeDraftBoundary);
  storage = host;
  [{ DraftRecorder }, { readSaved }] = await Promise.all([
    loadSource(draftSource, [{
      name: "draft-unit-boundaries",
      enforce: "pre",
      resolveId(id, importer) {
        if (importer === draftSource && (id === "./editor" || id === "./workspace")) {
          return { id: fakeDraftBoundary, external: true };
        }
      },
    }]),
    loadSource(source("run-configurations")),
  ]);
});

const folder = { id: 1 };

function draftFixture() {
  const indicator = { hidden: true, textContent: "", title: "" };
  const tab = { path: "main.go", disk: "on disk", diskVersion: "disk-v1", dirty: true, text: "first edit",
    model: { isDisposed: () => false, getValue: () => tab.text } };
  return { tab, indicator, recorder: new DraftRecorder(indicator) };
}

test("a superseded draft write can neither mark the newer revision saved nor report its own stale error", async () => {
  for (const fail of [false, true]) {
    const { tab, indicator, recorder } = draftFixture();
    const old = Promise.withResolvers();
    const next = Promise.withResolvers();
    const writes = [];
    storage.writeDraft = (...args) => {
      writes.push(args);
      return writes.length === 1 ? old.promise : next.promise;
    };

    recorder.schedule(folder, tab, true);
    tab.text = "new edit";
    recorder.schedule(folder, tab, true);
    const latest = recorder.settled(tab);
    assert.equal(writes.length, 1, "the recorder serializes writes");
    if (fail) old.reject(new Error("old write failed"));
    else old.resolve();
    await old.promise.catch(() => {});

    assert.deepEqual(writes, [
      [1, "main.go", 1, { text: "first edit", baseline: "on disk", version: "disk-v1" }],
      [1, "main.go", 2, { text: "new edit", baseline: "on disk", version: "disk-v1" }],
    ]);
    assert.equal(recorder.recorded(tab), false);
    assert.equal(indicator.textContent, "");
    next.resolve();
    await latest;
    assert.equal(recorder.recorded(tab), true);
    assert.equal(indicator.textContent, "Draft saved");
  }
});

test("an obsolete draft retirement does not remove a newer write for the same tab", async () => {
  const { tab, indicator, recorder } = draftFixture();
  storage.writeDraft = () => Promise.resolve();
  recorder.schedule(folder, tab, true);
  await recorder.settled(tab);
  assert.equal(recorder.recorded(tab), true);

  const retiring = Promise.withResolvers();
  const retirements = [];
  storage.retireDraft = (...args) => { retirements.push(args); return retiring.promise; };
  const discard = recorder.discard(folder, tab);
  assert.deepEqual(retirements, [[1, "main.go", 2, undefined]]);

  const next = Promise.withResolvers();
  const writes = [];
  storage.writeDraft = (...args) => { writes.push(args); return next.promise; };
  tab.text = "edit during retirement";
  recorder.schedule(folder, tab, true);
  const latest = recorder.settled(tab);
  assert.deepEqual(writes, [[1, "main.go", 3, { text: tab.text, baseline: "on disk", version: "disk-v1" }]]);
  retiring.resolve();
  await discard;
  assert.equal(recorder.settled(tab), latest);
  assert.equal(recorder.recorded(tab), false);
  next.resolve();
  await latest;
  assert.equal(recorder.recorded(tab), true);
  assert.equal(indicator.textContent, "Draft saved");
});

test("a clean tab becoming dirty again keeps its new draft after automatic retirement", async () => {
  const { tab, recorder } = draftFixture();
  storage.writeDraft = () => Promise.resolve();
  recorder.schedule(folder, tab, true);
  await recorder.settled(tab);

  const retiring = Promise.withResolvers();
  const retirements = [];
  storage.retireDraft = (...args) => { retirements.push(args); return retiring.promise; };
  tab.dirty = false;
  recorder.schedule(folder, tab, true);
  assert.deepEqual(retirements, [[1, "main.go", 2]]);

  const next = Promise.withResolvers();
  const writes = [];
  storage.writeDraft = (...args) => { writes.push(args); return next.promise; };
  tab.dirty = true;
  tab.text = "dirty again";
  recorder.schedule(folder, tab, true);
  const latest = recorder.settled(tab);
  assert.deepEqual(writes, [], "the automatic retirement still owns the storage slot");
  retiring.resolve();
  await retiring.promise;
  assert.deepEqual(writes, [[1, "main.go", 3, { text: tab.text, baseline: "on disk", version: "disk-v1" }]]);
  assert.equal(recorder.settled(tab), latest);
  assert.equal(recorder.recorded(tab), false);
  next.resolve();
  await latest;
  assert.equal(recorder.recorded(tab), true);
});

const profile = (id, fields = {}) => ({ id, name: `Run ${id}`, package: "./cmd/app", directory: ".",
  args: ["two words"], environment: { MODE: "test" }, ...fields });
const saved = (profiles, selected) => JSON.stringify({ version: 1, profiles, selected });

test("unreadable or unsupported configuration storage opens with defaults", () => {
  for (const invalid of [null, "{broken", "null", '{"version":2,"profiles":[]}', '{"version":1,"profiles":{}}']) {
    assert.deepEqual(readSaved(invalid), { version: 1, profiles: [] });
  }
});

test("invalid records are isolated and a selected ID must belong to a valid record", () => {
  const usable = profile("usable");
  const records = [profile("invalid-env", { environment: { "A=B": "x" } }), usable,
    profile("invalid-path", { directory: "../elsewhere" }), profile("invalid-args", { args: [5] })];
  for (const selected of ["invalid-env", "invalid-path", "invalid-args", "missing"]) {
    assert.deepEqual(readSaved(saved(records, selected)), { version: 1, profiles: [usable] });
  }
  assert.deepEqual(readSaved(saved(records, "usable")), { version: 1, profiles: [usable], selected: "usable" });
});

test("duplicate configuration IDs keep the first valid record", () => {
  const usable = profile("same");
  const records = [profile("same", { name: " " }), usable, profile("same", { name: "Replacement" }), profile("other")];
  assert.deepEqual(readSaved(saved(records, "same")), { version: 1, profiles: [usable, profile("other")], selected: "same" });
});

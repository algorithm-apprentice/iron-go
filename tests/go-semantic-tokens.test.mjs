import assert from "node:assert/strict";
import { test } from "node:test";
import { fullSemanticLegend, goSemanticData, goSemanticLegend } from "../src/go-semantic-tokens.ts";

const legend = { tokenTypes: ["string", "variable", "method", "property", "typeParameter"],
  tokenModifiers: ["defaultLibrary", "format", "readonly"] };
const index = role => goSemanticLegend.tokenTypes.indexOf(`irongo-go-${role}`);

test("decodes the server legend and re-encodes styled tokens after lexical ones", () => {
  const data = [
    0, 0, 4, 0, 0, // A quoted astral character occupies four UTF-16 columns.
    0, 5, 1, 1, 0,
    0, 2, 1, 1, 4,
    0, 2, 1, 2, 1,
    1, 1, 2, 0, 2,
    0, 3, 1, 3, 0,
    0, 2, 1, 4, 0,
  ];
  assert.deepEqual(goSemanticData(data, legend, 2, line => line === 1 ? '"🚀" a b c' : "abcdefg"), Uint32Array.of(
    0, 5, 1, index("variable"), 0,
    0, 2, 1, index("constant"), 0,
    0, 2, 1, index("builtin"), 0,
    1, 1, 2, index("format"), 0,
    0, 3, 1, index("field"), 0,
    0, 2, 1, index("type"), 0,
  ));
});

test("rejects malformed or out-of-model spans, including omitted ones", () => {
  for (const data of [[0, 0], [1, 0, 1, 1, 0], [0, 4, 1, 0, 0], [0, 0, 1, 5, 0],
    [0, 0, 0, 1, 0], [0, 1, 2, 0, 0, 0, 1, 1, 2, 0], [0, 0, 1, 1, -1]]) {
    assert.equal(goSemanticData(data, legend, 1, () => "abcd"), undefined, JSON.stringify(data));
  }
  assert.deepEqual(goSemanticData([], legend, 1, () => ""), new Uint32Array());
});

test("does not put a semantic style boundary inside a surrogate pair", () => {
  assert.equal(goSemanticData([0, 2, 1, 3, 0], legend, 1, () => '"🚀"'), undefined);
  assert.equal(goSemanticData([0, 1, 1, 3, 0], legend, 1, () => '"🚀"'), undefined);
});

test("requires a supported full-token legend", () => {
  assert.equal(fullSemanticLegend({ range: true, legend }), undefined);
  assert.equal(fullSemanticLegend({ full: true, legend: { tokenTypes: [2], tokenModifiers: [] } }), undefined);
  assert.equal(fullSemanticLegend({ full: true, legend }), legend);
});

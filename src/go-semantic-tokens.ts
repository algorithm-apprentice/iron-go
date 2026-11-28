export const semanticRoles = ["type", "function", "field", "parameter", "constant", "namespace", "builtin", "format", "variable"] as const;
type SemanticRole = typeof semanticRoles[number];

export const goSemanticLegend = { tokenTypes: semanticRoles.map(role => `irongo-go-${role}`), tokenModifiers: [] };

export const goSemanticCapabilities = {
  requests: { full: true },
  tokenTypes: ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable",
    "property", "enumMember", "function", "method", "string"],
  tokenModifiers: ["readonly", "defaultLibrary", "format"],
  formats: ["relative"],
};

interface Legend { tokenTypes: string[]; tokenModifiers: string[] }

export function fullSemanticLegend(provider: { full?: boolean | object; legend?: Legend } | undefined): Legend | undefined {
  if (!provider?.full || !provider.legend) return;
  const { tokenTypes, tokenModifiers } = provider.legend;
  if (!Array.isArray(tokenTypes) || !tokenTypes.length || tokenTypes.length > 256 ||
      !Array.isArray(tokenModifiers) || tokenModifiers.length > 32 ||
      !tokenTypes.every(type => typeof type === "string") || !tokenModifiers.every(modifier => typeof modifier === "string")) return;
  return provider.legend;
}

function roleFor(type: string, readonly: boolean, builtin: boolean, format: boolean): SemanticRole | undefined {
  switch (type) {
    case "type": case "class": case "enum": case "interface": case "struct": case "typeParameter": return "type";
    case "function": case "method": return builtin ? "builtin" : "function";
    case "parameter": return "parameter";
    case "property": return "field";
    case "namespace": return "namespace";
    case "enumMember": return "constant";
    case "variable": return readonly ? (builtin ? undefined : "constant") : "variable";
    case "string": return format ? "format" : undefined;
    default: return undefined;
  }
}

// Keep Monaco's lexical colors for spans without an explicit semantic style.
// Even omitted spans must participate in decoding the server's relative offsets.
export function goSemanticData(data: unknown, legend: Legend, lineCount: number, lineText: (line: number) => string) {
  if (!Array.isArray(data) || data.length > 500_000 || data.length % 5 !== 0) return;
  const mask = (modifier: string) => {
    const index = legend.tokenModifiers.indexOf(modifier);
    return index < 0 ? 0 : 1 << index;
  };
  const readonlyMask = mask("readonly");
  const builtinMask = mask("defaultLibrary");
  const formatMask = mask("format");
  const result: number[] = [];
  let line = 0, column = 0, end = 0, emittedLine = 0, emittedColumn = 0;
  let text = "";
  for (let index = 0; index < data.length; index += 5) {
    const deltaLine = data[index], deltaColumn = data[index + 1], length = data[index + 2];
    const typeIndex = data[index + 3], modifiers = data[index + 4];
    if (![deltaLine, deltaColumn, length, typeIndex, modifiers].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff) ||
        length === 0 || typeIndex >= legend.tokenTypes.length) return;
    line += deltaLine;
    column = deltaLine === 0 ? column + deltaColumn : deltaColumn;
    if (line >= lineCount || (deltaLine === 0 && column < end)) return;
    if (index === 0 || deltaLine !== 0) text = lineText(line + 1);
    if (column + length > text.length) return;
    end = column + length;
    const role = roleFor(legend.tokenTypes[typeIndex], Boolean(modifiers & readonlyMask), Boolean(modifiers & builtinMask), Boolean(modifiers & formatMask));
    if (!role) continue;
    if (splitsSurrogate(text, column) || splitsSurrogate(text, end)) return;
    result.push(line - emittedLine, line === emittedLine ? column - emittedColumn : column, length, semanticRoles.indexOf(role), 0);
    emittedLine = line;
    emittedColumn = column;
  }
  return Uint32Array.from(result);
}

function splitsSurrogate(text: string, offset: number) {
  const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

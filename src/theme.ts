import { byId } from "./dialogs";
import { monaco } from "./editor";
import { goSemanticLegend, semanticRoles } from "./go-semantic-tokens";

type ColorTheme = "dark" | "light";
const preferenceKey = "irongo.color-theme";

const editorRoles = {
  "editor.background": "--canvas",
  "editor.foreground": "--editor-text",
  "editorGutter.background": "--canvas",
  "editorLineNumber.foreground": "--editor-number",
  "editorLineNumber.activeForeground": "--editor-active-number",
  "editor.lineHighlightBorder": "--editor-line-border",
  "editor.selectionBackground": "--editor-selection",
  "minimap.background": "--canvas",
  "editorWidget.background": "--widget",
  "editorWidget.border": "--editor-widget-border",
  "editorSuggestWidget.selectedBackground": "--selected-command",
  "editorSuggestWidget.selectedForeground": "--selected-command-text",
  "focusBorder": "--focus",
};

const goKeywords = (words: string) => words.split(" ").map(word => `keyword.${word}.go`);

const goSyntaxRoles = {
  declaration: goKeywords("chan const func interface map package struct type var true false nil"),
  flow: goKeywords("break case continue default defer else fallthrough for go goto if import range return select switch"),
  type: goKeywords("bool byte complex64 complex128 float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr"),
  string: ["string.go"],
  escape: ["string.escape.go"],
  number: ["number.go", "number.float.go", "number.hex.go", "number.octal.go", "number.binary.go"],
  comment: ["comment.go", "comment.doc.go"],
};

function applyTheme(theme: ColorTheme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  byId<HTMLSelectElement>("theme-setting").value = theme;
  const palette = getComputedStyle(root);
  // The production CSS optimizer can shorten #ffffff to #fff.
  const color = (token: string) => palette.getPropertyValue(token).trim()
    .replace(/^#([0-9a-f]{3,4})$/i, (_, digits: string) => `#${[...digits].map(digit => digit.repeat(2)).join("")}`);
  // It can also emit a named color (e.g. green for #008000). Canvas
  // serializes opaque sRGB colors to the six hex digits Monaco requires.
  const context = document.createElement("canvas").getContext("2d");
  const foreground = (token: string) => {
    let value = color(token);
    if (context && !/^#[0-9a-f]{6}$/i.test(value)) {
      context.fillStyle = "#000000";
      context.fillStyle = value;
      value = context.fillStyle;
    }
    return /^#[0-9a-f]{6}$/i.test(value) ? value.slice(1) : undefined;
  };
  const name = `irongo-vscode-${theme}`;
  monaco.editor.defineTheme(name, {
    base: theme === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: [
      ...Object.entries(goSyntaxRoles).flatMap(([role, tokens]) => {
        const value = foreground(`--go-syntax-${role}`);
        return tokens.map(token => ({ token, foreground: value }));
      }),
      ...semanticRoles.map((role, index) => ({ token: goSemanticLegend.tokenTypes[index],
        foreground: foreground(`--go-semantic-${role}`) })),
    ],
    colors: {
      ...Object.fromEntries(Object.entries(editorRoles).map(([role, token]) => [role, color(token)])),
      "editor.lineHighlightBackground": "#00000000",
    },
  });
  monaco.editor.setTheme(name);
}

export function chooseColorTheme(theme: ColorTheme) {
  applyTheme(theme);
  try { localStorage.setItem(preferenceKey, theme); } catch { /* Still apply for this session. */ }
}

export function bindColorTheme() {
  const readTheme = (value: string | null): ColorTheme => value === "light" ? "light" : "dark";
  let saved: ColorTheme = "dark";
  try { saved = readTheme(localStorage.getItem(preferenceKey)); } catch { /* Use Dark. */ }
  applyTheme(saved);
  const select = byId<HTMLSelectElement>("theme-setting");
  select.addEventListener("change", () => chooseColorTheme(readTheme(select.value)));
}

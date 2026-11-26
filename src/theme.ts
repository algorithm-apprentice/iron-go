import { byId } from "./dialogs";
import { monaco } from "./editor";

type ColorTheme = "dark" | "light";
const preferenceKey = "irongo.color-theme";

const editorRoles = {
  "editor.background": "--canvas",
  "editor.foreground": "--editor-text",
  "editorGutter.background": "--canvas",
  "editorLineNumber.foreground": "--quiet",
  "editorLineNumber.activeForeground": "--text",
  "editor.lineHighlightBackground": "--editor-line",
  "editor.selectionBackground": "--editor-selection",
  "minimap.background": "--canvas",
  "editorWidget.background": "--widget",
  "editorWidget.border": "--control-edge",
  "editorSuggestWidget.selectedBackground": "--selection",
  "focusBorder": "--focus",
};

function applyTheme(theme: ColorTheme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  byId<HTMLSelectElement>("theme-setting").value = theme;
  const palette = getComputedStyle(root);
  // The production CSS optimizer can shorten #ffffff to #fff. Monaco's
  // syntax-token color parser needs a full hex triplet.
  const color = (token: string) => palette.getPropertyValue(token).trim()
    .replace(/^#([0-9a-f]{3,4})$/i, (_, digits: string) => `#${[...digits].map(digit => digit.repeat(2)).join("")}`);
  const name = `irongo-vscode-${theme}`;
  monaco.editor.defineTheme(name, {
    base: theme === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: [],
    colors: Object.fromEntries(Object.entries(editorRoles).map(([role, token]) => [role, color(token)])),
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

# Match VS Code Modern workbench colors

## Scope and reference

The palette described in [ADR 0004](../adr/0004-vscode-color-themes.md) used
VS Code's **2026** colors, which are distinct from **Dark Modern** and
**Light Modern**. Compare the effective colors of the installed VS Code
1.148.0 with the two Modern themes explicitly selected in disposable profiles.
Read resolved workbench theme variables, including inherited defaults, and
wait for the actual editor and sidebar colors before capturing them. Audit
artifact: `test-results/theme-audit/vscode-modern-1.148.0.json`.
The role tables below are the tracked reference for the subset this change
matches. To refresh them, launch the reference VS Code release with temporary
`--user-data-dir` and `--extensions-dir` paths, set `workbench.colorTheme`
in each profile, and read `--vscode-*` properties from `.monaco-workbench`
after comparing the expected editor and sidebar backgrounds. Convert RGBA to
equivalent eight-digit hex for Monaco compatibility.

Match corresponding workbench and Monaco UI roles to this pinned reference.
No new theme picker entries, layout changes, or changes to the completed
control deduplication. Retain the Dark/Light settings names, dark default,
and saved `irongo.color-theme` preference. Keep Monaco's built-in syntax
tokens and Iron Go's domain-specific icons and feedback treatments. Do not
import VS Code's TextMate rules, extension themes, or native OS dialogs.

## Essential role mapping

| VS Code role | Dark Modern | Light Modern | Iron Go surface |
| --- | --- | --- | --- |
| `editor.background` / `editor.foreground` | `#1f1f1f` / `#cccccc` | `#ffffff` / `#3b3b3b` | Monaco editor and editor canvas |
| `sideBar.background`, activity bar, title bar, panel, status bar and inactive-tab surfaces | `#181818` | `#f8f8f8` | Persistent workbench chrome |
| `panel.border`, sidebar/title/status borders and tab borders | `#2b2b2b` | `#e5e5e5` | Chrome borders and dividers |
| `foreground` / `descriptionForeground` | `#cccccc` / `#9d9d9d` | `#3b3b3b` / `#3b3b3b` | Normal and descriptive text |
| `input.background` / `input.border` | `#313131` / `#3c3c3c` | `#ffffff` / `#cecece` | Search, forms, Run Target |
| `focusBorder` / `button.background` | `#0078d4` | `#005fb8` | Focus outline and primary action |
| `button.hoverBackground` | `#026ec1` | `#0258a8` | Hovered primary action |
| `editorLineNumber.foreground` / active | `#6e7681` / `#cccccc` | `#6e7681` / `#171184` | Normal and active gutter numbers |
| `editor.selectionBackground` | `#264f78` | `#add6ff` | Active editor selection |
| `editor.lineHighlightBorder` | `#282828` | `#eeeeee` | Current line border rather than colored fill |
| `editorWidget.background` / border | `#202020` / `#cccccc33` | `#f8f8f8` / `#3b3b3b33` | Monaco widgets |
| `editorSuggestWidget.selectedBackground` and `quickInputList.focusBackground` | `#04395e` | `#005fb8` | Keyboard-focused completion/palette row |
| `editorSuggestWidget.selectedForeground` and `quickInputList.focusForeground` | `#ffffff` | `#ffffff` | Focused row text, descriptions and icons |
| `quickInput.background` | `#222222` | `#f8f8f8` | Command palette |
| `list.inactiveSelectionBackground` / `list.hoverBackground` | `#37373d` / `#2a2d2e` | `#e4e6f1` / `#f2f2f2` | Explorer selection and row hover |
| `list.activeSelectionBackground` / foreground | `#04395e` / `#ffffff` | `#e8e8e8` / `#000000` | Selected Explorer row with focus |
| `tab.activeForeground` / `tab.inactiveForeground` | `#ffffff` / `#9d9d9d` | `#3b3b3b` / `#616161` | Active and inactive filename |
| `commandCenter.background` / border / foreground | `#ffffff0d` / `#cccccc33` / `#cccccc` | `#0000000d` / `#1e1e1e33` / `#1e1e1e` | Title-bar command center |
| `activityBar.foreground` / inactive foreground | `#d7d7d7` / `#868686` | `#1f1f1f` / `#616161` | Active and inactive activity icons |

Where the reference deliberately differs by role (for example active line
number versus ordinary foreground, palette selection versus primary action),
use separate semantic tokens. Use existing common tokens only where the
resolved values agree. Monaco's public `defineTheme` API reads the same
CSS tokens as surrounding chrome and still normalizes short hex values.
Explicitly use a transparent line fill when the reference uses a border, and
the editor canvas for the minimap when no separate background is defined.
Match the default native window startup background to the default dark editor.
Do not install VS Code or depend on it at build or runtime.

Use the exact secondary gutter color even though Dark Modern's inactive
line numbers have about 3.59:1 contrast against the canvas. Do not reuse
that value for shared quiet text on chrome. Use the reference foreground
and background together for selected rows; in particular, normal Light
foreground is not suitable on the blue palette or suggestion selection.
Iron Go's app-specific error/warning and destructive Stop feedback, Go and
module icon colors, status context chip, panel backdrop, and syntax token
colors remain intentional differences. This is a match for the listed roles.

## Acceptance

- Start with a failing built-asset test for the expected Modern colors. In
  both themes, measure computed colors on the editor, sidebar, tab/header,
  primary Run/Test action, command center, active/inactive tabs, Explorer
  selection, palette (including selected text), and line numbers. Verify the
  current line border and transparent fill. Verify a dirty buffer, editing
  focus, and theme persistence across reload.
- Native WKWebView switches both directions through Settings and asserts the
  editor and chrome colors. A real Go completion checks the selected row's
  background and foreground through both themes. Preserve existing dirty-buffer quit, Go/Delve,
  formatting, and layout tests; no restart of the editor or tools on toggle.
- Report matching roles and retained differences. Do not infer pixel parity
  for Go syntax, every dialog, or native menus from a common background.

## Verification

The built-asset regression failed before implementation on the old canvas
and chrome colors. It now checks the listed rendered roles in both themes,
including focused/unfocused Explorer selection, active/inactive tab text,
line number colors and bordered current line, and the palette selection pair.
Theme changes retain unsaved edits and the persisted choice.

Final feedback passed 23 TS, 31 Rust, Go fixture, 28 browser, and 27 native
cases (`test-results/native/1795755989996-80402`). Native Settings switched
both ways and the Go completion case checked the visible selected row's
background and white foreground in both themes. Go token colors are a
separate adjustment documented in [the Go syntax color design](go-syntax-colors.md).

## Keyboard focus follow-up

The Modern primary fill can equal the general focus color. Since the
outline is inset, it then disappears on the primary Run/Test button. Keep
the measured fill and use the contrasting primary foreground for focused
primary buttons. Keep the general focus color for Run's active Stop state,
whose destructive surface is intentionally different. Do not shift layout
or change keyboard navigation. Require a built-asset regression that tabs
onto Run in both themes, verifies a visible contrasting outline, and fails
against the unmodified palette.

The focused Chromium test reproduced a `#0078d4` outline on the identical
Dark Modern fill. After the fix, keyboard navigation reaches Run with a
white 1 px outline in both themes. The final `npm run test:feedback` passed
(23 TypeScript, 31 Rust, Go fixture, 28 browser, and 27 native cases;
`test-results/native/1795756320681-83001`).

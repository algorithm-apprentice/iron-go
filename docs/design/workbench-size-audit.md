# Workbench control size audit

## Method

Measure the current, unmodified layout using an isolated Orbit browser import
and a disposable native WKWebView project. Chromium viewports: 1320×820,
920×720, 760×600, and 650×560. Native logical sizes: 1320×820 and 760×600.
Measurements are CSS pixels, not glyph or physical screen dimensions. Compare
both opened and collapsed chrome, and separate click targets from their visual
icons. Raw local data: `test-results/layout-audit/chromium.json` and
`test-results/layout-audit/wkwebview.json`.

## What takes the editor's space

| Viewport | Left rail + sidebar + divider | Editor container | Bottom panel | Minimap |
| --- | ---: | ---: | ---: | ---: |
| 1320×820 | 294 px | 1026×495.4 px | 188.6 px high | 75 px wide |
| 920×720 (browser) | 263 px | 657×418.4 px | 165.6 px high | 72 px wide |
| 760×600 | 263 px | 497×314 px | 150 px high | 53 px wide |
| 650×560 (browser) | 214 px | 436×277 px | 150 px high | 47 px wide |

The editor container includes the Monaco gutter, scrollbar and minimap; it
is not the text column. At 760 px, collapsing just the sidebar increased the
editor container from 497 to 709 px. Collapsing the output panel as well
increased the browser editor height from 314 to 465 px. The native rail,
sidebar, editor, breadcrumb and output dimensions matched Chromium at both
tested sizes. The minimap scales with the editor, so rail savings are not
automatically an equal increase in the text column.

## Control-by-control findings

| Surface | Observed geometry | Judgment |
| --- | --- | --- |
| macOS title/command bar | 36 px high; Quick Open 430×26 wide/320×26 at 760; 30×30 icon buttons | Keep its height and macOS traffic-light clearance. Wide Quick Open uses otherwise empty horizontal space, not editor width. |
| Activity rail | 51 px wide including its border; 50×49 buttons with 21 px glyphs; 38 px rail at 650 | Oversized for four persistent icons. Compact the track and retain a generous full-width hit area. |
| Project sidebar | 242/211/175 px presets; 44 px section header, 27 px tree rows, 50 px module card, 25×25 actions | Reduce the desktop presets modestly; keep the narrow one and the adjustable divider. The header has room to tighten vertically, but only increases tree rows, not editor height. Tree rows and action targets should not get smaller. The module card costs tree height and partly repeats the status bar; test a one-line alternative separately if tree density is a problem. |
| Search | 30.8 px field; 134×29 input at 760, 98×29 at 650; Match Case 24×21 | Do not blindly narrow Search. Increase the Match Case target inside the existing field; at small widths protect query input and readable result snippets. |
| Run and Test sidebar | 31 px buttons; 32 px browser scope dropdown; content fits the current wide/narrow sidebar | Keep button height. Recheck labels and select affordance after any sidebar change. |
| Editor tabs and toolbar | One shared **40 px** row, with the tab itself fixed at **39 px**. Most action buttons are 25–26 px, except close 19×19. At 760 the actions consume 230 of the editor's 497 px width (46%); tabs get 266 px before Debug controls appear. | The row is explicitly sized; it is not being forced taller by its buttons. Prototype a 32–34 px row without shrinking the targets. Increase tab-close hit area without enlarging the glyph. The picker measures only **95×18 in native WKWebView**, versus 95×26 in Chromium: fix native control styling/hit area, not the glyph. Measure the live Debug toolbar with multiple tabs before deciding whether infrequent actions need an overflow menu. |
| Breadcrumbs | Separate 31 px row across the editor; combined with the file tabs, **71 px** above the buffer | Keep path identification. Try a **24 px** breadcrumb row alongside a 32–34 px tab row (56–58 px combined, giving back 13–15 px in height) before introducing an overflow or merging paths into tabs. |
| Monaco gutter, text and minimap | Monaco 22 px line spacing; minimap costs 53 px at native minimum | Don't shrink code font/gutter to compensate for chrome. Consider auto-hiding the minimap in a narrow editor **only when the user has not explicitly chosen a preference**. Validate actual Monaco text width, not just CSS container width. |
| Output / Problems | 150–188.6 px panel plus 1 px divider; 39 px panel header; tabs around 38 px tall, actions 25×25 | Biggest vertical lever. Preserve explicit panel visibility/size and don't hide running, paused or failed tool feedback. Evaluate a smaller initial height on short windows and a 30–32 px header without shrinking its actions. `⌘J` already recovers the full height. |
| Resize and status | 1 px visible dividers with a ±3 px hit extension; 28 px status bar (25 compact), buttons 24–27 px tall | Keep visual separators thin; test drag hit extension and keyboard resizing rather than making more chrome. Status controls are already compact. |
| Command palette, forms, Settings and welcome | Palette rows ~31 px, field strip 46 px; dialogs ~430 px wide, form buttons ≥31 px; checkbox glyphs are 13×13 but their associated labels cover full 396×48–51 px rows. Welcome uses the empty editor stage, not permanent space. | Keep these generally. They are transient and don't crowd a visible buffer; small checkbox glyph is not a small label hit area. |

## Outcome and proposed follow-ups

1. Reclaim permanent width with the [compact workbench chrome change](compact-workbench-chrome.md).
   At 760 px it recovers 30 px of editor container. Preserve adjustable and
   collapsed layouts. Make the native picker, tab close and Match Case easier
   to hit without making their parent rows bigger.
2. The first pass also shortens breadcrumb and output chrome, but leaves the
   minimap preference alone. Future adaptive minimap experiments should
   remeasure actual text width and not override explicit preferences.
3. Stress narrow native layouts with several long tabs, custom target labels,
   and Debug controls. Only then decide if toolbar overflow is justified.

This is a geometry and interaction inventory, not a Retina visual review or
a claim of accessibility conformance. The audit did not exercise every
conditional view (in particular the live Debug toolbar with many long tabs
and custom target labels). Measurements above are the pre-change baseline;
see the linked implementation design for verified post-change sizes.

## VS Code reference

Measured installed VS Code **1.148.0 arm64** with a disposable user profile
and Orbit copy, extensions disabled. The two viewports were set via Electron
DevTools and matched their requested CSS dimensions. Data:
`test-results/layout-audit/vscode-1.148.0.json`.

| Corresponding control | VS Code measured | Iron Go baseline → design |
| --- | ---: | ---: |
| Title bar / Quick Open height | 35 / 24 px | 36 / 26 px, keep native traffic-light placement |
| Left activity rail / actionable box | 44 / 36×36 px | 51 / 50×49 → 44 / 43×36 at wide size; 36 px rail at native minimum |
| Explorer section title / tree row | 32 / 22 px | 44 / 27 → 32 / 27; keep comfortable tree targets |
| File tab / breadcrumbs / combined editor header | 31 / 22 / 54 px | 39 / 31 / 71 → 31 / 22 / 54 |
| File close glyph button | 20×20 px | 19×19 → 24×24; deliberately larger |
| Output panel header | 32 px | 39 → 32 |
| Status bar | 28 px | 28 px, unchanged |

VS Code's primary sidebar measured 300 px at 1320 and 192 px at 760.
Its panel was initially closed and 292 px high when opened in this run;
its whole editor region contains a different sidebar/panel configuration,
so these outer-shell dimensions are not an apples-to-apples editor-area
comparison. Do not copy the wide sidebar or tall output defaults into
Iron Go. The extension-free reference did not have a one-to-one Go Run
Target selector. Preserve Iron Go's native 26 px combobox and feedback policy.

## Economy of controls

Use the fewest persistent controls that provide equivalent capability. Give
each operation one obvious visible home per context. A keyboard shortcut or
an item in a transient palette need not consume a second permanent slot.
Keep a second entry only if it preserves access in a different state or
answers a different question; do not erase useful status to remove an action.

| Candidate | Why it is or is not redundant |
| --- | --- |
| `Output` tab plus `Go Output` badge | The badge is not interactive; the tab already identifies the visible stream. Remove the duplicate label before tightening row spacing. |
| Top `Toggle Bottom Panel` plus the output panel's `Hide Panel` button | Both close the same open panel. Keep one visible toggle that can also reopen it, plus `⌘J`. |
| Settings gear plus toolchain version/status button | Both open the same Settings dialog. Keep the toolchain status information; consider one Settings trigger rather than two equal visible actions. |
| `Open Project` in title and welcome | The welcome button is useful before a project exists; the title action switches projects. They can be shown in mutually exclusive contexts while retaining `⌘O` and the palette. |
| Project header refresh icon plus project menu refresh | Keep refresh available; prefer combining it into the visible Project Actions menu unless frequent refresh warrants its own permanent button. |
| Toolbar Go Run/Stop versus Go panel actions | Toolbar is one-target immediate action; Build, package scope and Test in the panel retain distinct behavior. Consolidate only equivalent actions, not the scope picker or Build. |
| Active filename versus breadcrumbs | Different information: which buffer is active versus where it lives. Retain enough path context to disambiguate same-named files. |

These are candidates for a separate interaction pass, not removals shipped
by the geometry change. Prove each action still works by pointer and keyboard
when its relevant panel is open or closed before deleting an entry.

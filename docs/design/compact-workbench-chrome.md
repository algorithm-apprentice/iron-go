# Compact workbench chrome

Implementation from the [full workbench size audit](workbench-size-audit.md).

## Finding and scope

The activity rail reserves 51 CSS pixels on desktop and remains visible
when the project sidebar is collapsed. Its 21 px icons sit in 49 px-tall
buttons. The adjacent sidebar defaults to 242 px on a wide window and
211 px at the native minimum width. Together they consume 294 px at
1320 px and 263 px at 760 px, before the editor gutter.

Compact the left rail, sidebar initial width, editor header, and default
output height together. Enlarge the three measured undersized controls.
Keep the title bar, editor font/gutter, and the existing minimap preference
unchanged. Do not automatically hide panels, change saved preferences, or
introduce an overflow menu; those require separate interaction evidence.
No new preference or layout mode.

## Proposed geometry

| Window width | Activity rail, before → after | Default sidebar, before → after | Editor width reclaimed |
| --- | ---: | ---: | ---: |
| 1320 px | 51 → 44 | 242 → 220 | 29 px |
| 760 px | 51 → 36 | 211 → 196 | 30 px |
| 650 px browser | 38 → 34 | 175 → 175 | 4 px |

Use a single rail width token for both the open- and collapsed-sidebar
grids. Keep buttons full width and at least 36 px tall; use an 18 px glyph.
Use the measured VS Code 44 px rail at wide sizes; retain 36 px for native
windows at or below 920 px and 34 px for compact browser previews. The
button's full-width hit area is deliberately wider than VS Code's 36 px in
wide windows so the existing active indicator stays at the rail edge.
Keep the one-pixel divider, focus indicator, accessible names, selection
indicator, tooltips, existing resize behavior and keyboard controls.
The sidebar remains adjustable and collapsible; do not constrain an
explicitly resized width beyond the existing minimum and bounds.

- Editor tabs/toolbar: **40 → 32 px** (31 px tab plus border); breadcrumb
  row: **31 → 22 px**. Match the measured VS Code total of **54 px**.
  Keep the path and action labels. Use **24×24 px** for tab close, keeping
  its icon size, dirty dot and focus style. Make Match Case **24×24 px**
  without increasing the Search row.
- Keep the Run Target element a native `select` with native option popup,
  semantics, keyboard behavior and focus indication. Remove only the
  platform's closed-control painting, use a theme-colored chevron, and give
  the target an actual **26 px** height in WKWebView (baseline 18 px).
  Dim both the closed field and the chevron whenever the select is disabled.
- Output/Problems header: **39 → 32 px**, preserving icon button sizes and
  text. Default panel height is `clamp(112px, calc(31vh - 66px), 214px)`:
  120 px at 600 tall, 112 px at 560, and about 188 px at 820 (near the old
  roomy-window default). Keep manual drag/keyboard resizing and explicit
  visibility. At 760×600, editor container should grow from **497×314** to
  **527×361 px** with both panels open, including one-pixel dividers.
- Sidebar section headers **44 → 32 px** to match VS Code; keep the 27 px
  tree rows and 25 px buttons. Do not copy the wider VS Code sidebar preset
  or its smaller 20 px tab-close target.

## Alternatives

- Hide or merge the rail into the project panel: reclaims more pixels,
  but takes away the persistent Search/Project/Go targets when the panel
  is collapsed and changes the user's navigation model.
- Shrink only the icons: does not reclaim any width.
- Keep the sidebar defaults unchanged: limits the win at the native minimum;
  the confirmed wider layout still remains available by dragging the divider.

## Acceptance

Measure the rail, button hit areas, sidebar, divider and editor at 1320,
760 and 650 px in Chromium. Including the separate one-pixel resize
divider, expect editor widths **1055, 527 and 440 px** respectively.
Collapse should reclaim **221, 197 and 176 px** without changing rail
width. Verify actual clickable bounds of at least **43 × 36 px** at 1320,
**35 × 36 px** at 760 and **33 × 36 px** at 650, plus an outline on keyboard focus.

Verify the collapsed sidebar and divider are no longer in Tab order.
Focus Search in the rail and activate it by keyboard; the reopened sidebar
should focus `#search-text`. At 760 px, verify the Search and Run and Test
controls fit and are usable. Drag the divider and then use its 14 px arrow
step: the editor should change width by the same amount, and the explicit
width should survive collapse and reopen. Keep current resize clamping
semantics; do not add viewport re-clamping.

Use the native WKWebView with a file open at 1320 and 760 px to verify
the measured widths, a one-pixel divider, and editor alignment after a
resize/collapse cycle. Do not claim a visual Retina result from Chromium.
In both layers verify the 32/22/32 px rows and the actual close, case, and
Run Target bounds. Verify manual panel heights remain across hiding and
opening. Assert panel/editor heights for 1320×820 (188.2/512.8 px),
760×600 (120/361 px), and 650×560 (112/332 px), and that the header is
not clipped and the output body can scroll at the 112 px floor.

In native WKWebView on the unlocked console, use real macOS key events to
focus the enabled Run Target, verify its visible focus, open its native popup
and choose a different target without DOM value injection. Verify the selection
commits and the chevron has a dedicated label gutter in both themes. If the
window or popup is not reachable, report that native check as unverified, not
as a browser pass. Keep ordinary Go Run/Debug native acceptance in the gate.
Check disabled field and chevron appearance in both themes and keep the
wrapped selector in the one-pixel toolbar gap test.

## Pre-comparison prototype verification

- Regression failed before the change at the desktop rail (`51 !== 36`).
  Chromium verifies all three viewport sizes, an unobstructed output header
  and scrollable output at the 112 px floor, Search keyboard focus, and
  resize persistence. Native WKWebView verifies the two shipping sizes and
  editor alignment after collapsing and reopening the sidebar.
- `npm run test:feedback` passed (23 TS, 31 Rust, Go fixture, 22 browser, and
  22 native cases; `test-results/native/1795749734834-52759`).
- Real macOS keyboard check on an unlocked console, with the input method
  switched to ABC for the probe and restored after it: keyboard-focused
  Run Target was 26 px with a visible solid focus outline. Space opened an
  app-owned native popup window (layer 101); Down/Enter committed
  `./cmd/orbit` in dark theme, then `./cmd/worker` in light. Neither selection
  was injected into the DOM. The chevron took 14 px from the right edge,
  leaving at least 7 px beyond it in the label's 21 px right padding.

## VS Code-matched revision verification

- The updated regression initially failed at the 44 px wide rail and the
  missing disabled selector styling; both pass with the revision. The
  tests include the native selector in the toolbar's one-pixel gap check.
- `npm run test:feedback` passed (23 TS, 31 Rust, Go fixture, 23 browser,
  22 native; `test-results/native/1795750305401-55930`). Both Chromium and
  native WKWebView now show the 54 px editor header. The native 760×600
  editor bounds are 527×361 px with sidebar and output visible.
- Repeated the actual keyboard popup check on this revision in both
  themes. Focus outline, layer-101 popup, and distinct committed
  selections were verified again at 26 px target height. The test switched
  to ABC before typing English and restored the prior input source;
  measurements are in `test-results/layout-audit/native-popup.json`.

## Native icon alignment follow-up

At 1320 and 760 px, WKWebView measured the SVG frame in all four activity
buttons **9 px above** the button center. Horizontal offsets were zero
relative to the buttons; the rail border accounts for a separate 0.5 px
offset relative to the overall rail. The SVG paths themselves did not
explain the vertical shift. Visible title, project, close-tab, editor,
and output icon buttons had centered frames (small path offsets under
0.4 px reflect the drawings). Raw baseline:
`test-results/layout-audit/icon-alignment-wkwebview.json`.

Make the 36 px cross layout explicit on the activity button instead of
relying on a flex basis to give WebKit's grid button content a definite
block size. Keep the existing widths, rail border, hit areas and SVGs.
Reject per-glyph translations for a shared 9 px layout error. Verify all
four activity icons and the other visible icon-only controls are centered
inside their buttons within half a CSS pixel at native default/minimum
widths and after sidebar collapse. Report visual path and Retina effects
separately rather than claiming exact optical centering.

The new native regression failed against the pre-fix app at `Project:
icon is 0px horizontally and -9px vertically from center`
(`test-results/native/1795750754989-58263`). The prior regression only
checked the outer geometry, so it did not catch the internal alignment.

With explicit 36 px button height, full feedback passed, including the
native icon checks, geometry, and collapsed sidebar case
(`test-results/native/1795751525047-60707`). The wide native test derives the
expected vertical geometry from the actual height when macOS limits it to
the display's available frame.

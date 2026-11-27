# VS Code-aligned line-number gutter

## Measured baseline

Temporary Go files with 9, 10, 99, 100, 999, 1000, and 1001 lines were
opened in a fresh VS Code 1.148.0 profile. The number column is right
aligned. The minimum width fits **three digits**; only 1000+ lines require
a fourth. The leading breakpoint glyph lane is 18 px, and the number's
right edge is 26 px from the start of unindented code at all sizes. Total
left margin: 66 px through 999, 73 px for 1000–9999, and 80 px at
10000. At 9999→10000, only the number column grew (29→36 px); the glyph
lane and trailing gap stayed put. The rendered `10000` right edge was
within 0.125 px of its cell edge. Data:
`test-results/layout-audit/gutter-vscode-1.148.0.json` and
`test-results/layout-audit/gutter-vscode-1.148.0-large.json`.

Native Iron Go keeps four digits even for 9 lines: a 22 px glyph lane,
31 px number column and the same 26 px trailing gap, totaling 79 px through
at least 1001. Data: `test-results/layout-audit/gutter-iron-go.json`.

## Change

Set Monaco `lineNumbersMinChars` to 3 and keep its existing dynamic width,
right alignment, fonts, line height, glyph lane and decoration widths.
The reserved digit count is `max(3, decimal digits of the model's line
count)`, with no hand-coded cutoff. Six digits start at 100,000 lines;
the column can grow beyond that without a new rule.
Digits share the same right edge so 9/10, 99/100 and 999/1000 line up. Empty
space to the left of a short number is intentional; horizontally centering
each number would break this. The left breakpoint lane is a separate hit
area, not padding to remove. A common short file should recover about eight
pixels. Exact overall pixel equality with VS Code is not a goal: its smaller
default row/font also yields a narrower glyph lane and digit advance.

Alternatives rejected: fixed CSS widths (can clip large files and break
Monaco hit testing), centering individual numbers, setting minimum to one
(avoidable content jumps on 9→10 and 99→100), or lowering the editor line
height to match VS Code (out of scope and shrinks breakpoint hit areas).

## Acceptance

- Reproduce that a 999-line and a 1000-line Go file have the same width
  before implementation. At 9/10/99/100/999 a three-digit gutter stays
  stable; 1000/1001 confirm full rendering, model line counts (no trailing
  blank line), and right edges through four digits. Pass five, six, and
  seven-digit counts directly to Monaco's layout calculation in the browser
  fixture, not to generated large models. Check that the code start shifts
  by exactly the computed column increase and the number-to-code gap remains
  unchanged.
- Check the result in native WKWebView and ensure clicking an actual
  four-digit gutter number still selects the correct whole line. Retain
  existing native Go/Delve breakpoint and alignment acceptance.
- No settings or CSS offsets, and no new test hook in a shipped bundle.

## Verification

The focused regression failed before changing the minimum: the 999→1000
step was zero. After the change, small files rendered the expected right
edges; the test passed simulated layout boundary counts through seven digits
without constructing large models. Native acceptance opened 999- and
1001-line fixtures, verified the width step and 26 px gap, and selected
the whole of line 1000 from `(1000, 1)` to `(1001, 1)` using the rendered
WKWebView gutter. Full feedback passed (23 TS, 31 Rust, Go fixture,
24 browser, 23 native; `test-results/native/1795751525047-60707`).

## VS Code breakpoint lane follow-up

Match VS Code's measured **18 px** single breakpoint lane. Monaco derives
the lane width from line height, so set the supported `lineHeight` option
to 18 px (was 22): code rows also become 18 px high. Keep the 13 px font and
the 10 px breakpoint glyph; full-row hit geometry remains under Monaco's
control. Do not CSS-clip the lane, create a custom gutter, or remove folding.
The requested density matches VS Code's row height without forcing its
smaller default font on Iron Go.

Set `lineDecorationsWidth` to 8 px (default 10). Monaco also reserves 16 px
for folding, yielding a 24 px trailing gap, including the 2 px fold inset.
The original idea of a 20 px gap compensated for a 22 px glyph lane and is
not needed once that lane matches VS Code. Target total margin is about
65 px for one–three digits and 73 px for four, with the same automatic
growth beyond four. The extra room stays between the glyph and code rather
than shrinking its hit area below VS Code's.

Acceptance: fail against the old 22 px lane; verify 18 px lane and row
height, fixed 24 px gap, stable right alignment and digit boundaries.
Click the rendered fold chevron at browser pointer coordinates to collapse
and expand, verify native four-digit number selection, and place a native
breakpoint through the glyph gutter and verify a real Delve stop at the
expected source row. Typography and underline position should not clip.

Verified in native WKWebView: 9, 99 and 999 lines measure **65 px** for
the whole gutter; 1001 lines measure **73 px**. All four have an **18 px**
breakpoint slot, **18 px** row, and **24 px** gap. Raw readings:
`test-results/layout-audit/gutter-iron-go-after.json`. Full feedback passed
(23 TS, 31 Rust, Go fixture, 25 browser, 23 native; artifact
`test-results/native/1795752117076-64612`), including pointer-based folding,
diagnostic and text bounds, native four-digit selection, and a breakpoint
set by a coordinate hit in the native glyph lane followed by a real Delve
stop on the expected row.

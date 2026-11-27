# One persistent control for the bottom panel

## Scope

The [workbench audit](workbench-size-audit.md#economy-of-controls) found two
redundancies in the bottom panel: the non-interactive `Go Output` badge
repeats the Output tab, and the panel's Hide button duplicates the title-bar
toggle. Remove these two elements as a first pass. Do not consolidate other
workbench controls or adjust panel geometry in this change.

## Interaction invariants

- The title-bar toggle is visible whether the panel is shown or hidden. It
  controls the bottom panel and keeps its `aria-pressed` state in sync. The
  `⌘J` shortcut and command palette entry continue to work in both states.
- Output and Problems remain distinct tabs. Clear Output, Stop Task, and the
  resize separator stay available; hiding the panel does not clear output,
  change the selected tab, or stop a task. Automatic reveal behavior is
  unchanged. The status-bar Problems entry still opens its tab directly.
- If a keyboard shortcut hides the panel while focus is inside it (including
  the adjacent resize separator), move focus to the remaining toggle. If
  focus is in the editor or another visible control, leave it there.

Keep the title-bar toggle rather than the panel-local Hide button: the
latter cannot reopen a hidden panel. Renaming or shrinking the badge would
still leave a second label for the same stream. A transient palette command
and a shortcut do not consume additional workbench space.

## Acceptance

1. A browser regression fails on the old duplicate elements and verifies
   pointer and keyboard toggling, `aria-pressed`, focus handling, retained
   output, and preservation of the active Problems tab. Clear Output
   continues to work after reopening.
2. Native WKWebView verifies the visible toggle and `⌘J` against an open
   disposable project. A real Go task still displays output and can be
   stopped from the output header; when both actions are visible, their
   spacing stays one pixel. Retain the native narrow-layout checks.

## Verification

The focused browser regression failed on the duplicate badge before the
change. After the change, it passed with both removed elements absent,
focus recovery from the tab and separator, editor focus preserved, the
status-bar Problems route working, and output unchanged until explicitly
cleared. The existing browser spacing and narrow-layout tests also passed.

`npm run test:feedback` passed: 23 TypeScript tests, 31 Rust tests, the
Go fixture, 26 browser cases, and 24 native cases. The native run verifies
the remaining toggle, `⌘J` event handling, focus recovery, and a real Go
task that was stopped from the output header. Native artifacts:
`test-results/native/1795753393147-70114`.

A local macOS keyboard check also hid the focused output pane with `⌘J`
and reopened it with Return on the title-bar toggle, retaining its log.
The focused Chromium regression was rerun after adding an explicit check
that editor focus stays put on both closing and opening the panel.

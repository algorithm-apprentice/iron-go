# Editor row and gutter alignment on macOS

Status: Confirmed viewport synchronization defect fixed. The original
foreground visual report is not yet reproduced.

Scope: keep Monaco's code row, line number, and active-line highlight in sync
when opening and scrolling long Go sources, including the vertical space
inserted by test CodeLens. Use a disposable Raft checkout for native
verification; do not modify an open user project.

Acceptance: check position of a known Go source line and its corresponding
gutter number and highlight in the real macOS WebView, with and without
CodeLens. Verify after large vertical scrolls and test-control insertion.

The longer native acceptance caught stale viewport dimensions: after panel
changes, the editor host was about 526 px tall but Monaco still reported
796 px. Explicitly synchronize Monaco when workbench chrome changes, in
addition to its automatic layout for native window resizes. It also exposed
an acceptance issue: a background WKWebView reported `visibilityState=hidden`
and would leave newly switched tab rows unpainted. Request an explicit
Monaco render after model activation or when returning to a visible window.
The off-screen acceptance explicitly scrolls and paints the actual model
coordinate for geometry checks; locked macOS sessions can defer smooth
navigation and compositor updates. This does not replace an observation of
the user's foreground row mismatch.

The native Raft geometry gate now passes at normal size and at 760 px with
wrapping enabled. The native Orbit gate checks the editor viewport against
Monaco before a gutter breakpoint is exercised.

## Diagnosing a gutter click

Use the native acceptance build to log the rendered gutter row, the source
line hit by Monaco's mouse target, the selection and its active endpoint,
and the highlighted gutter number. Compare row coordinates separately from
selection behavior. The probe runs on a disposable project and does not add
logging or change settings in the installed application.

See [real project snapshots](../TESTING.md#real-project-snapshots-and-cleanup-diagnostics)
for the gutter probe command and flags.

The probe reproduced the reported click: row delta `0`, mouse target
`GUTTER_LINE_NUMBERS` at line 28, selection `28:1` through `29:1`, caret at
`29:1`, highlighted number `29`. Monaco's whole-line selection includes
the newline and its active-number styling follows the caret, not the mouse
target.

Keep Monaco's whole-line selection and caret behavior (including newline,
copy, and drag). While that selection originates in the number column, show
the selected model rows in the gutter instead of the active endpoint. Clear
the override when the user moves the caret normally, clicks in the editor,
or changes files. Verify a native click on line 28 still selects `28:1` to
`29:1` but visually highlights only `28`; a subsequent caret move to 29 must
restore the normal gutter highlight and colors.

Verified in both the native Orbit suite and the Raft probe: the selected
row uses the normal active foreground; the caret's following row retains
the inactive foreground until the selection is cleared. The caret endpoint
and zero-pixel vertical alignment are unchanged.

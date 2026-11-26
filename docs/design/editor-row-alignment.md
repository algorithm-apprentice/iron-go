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

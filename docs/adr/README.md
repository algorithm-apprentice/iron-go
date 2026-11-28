# Architecture decisions

Following Iron C++: numbered ADRs record lasting decisions; linked designs
record detailed behavior, alternatives, implementation order, and acceptance.

| Record | Decision | Status |
| --- | --- | --- |
| [0001](0001-macos-go-workbench.md) | macOS-first Go workbench on Tauri and Monaco | Accepted |
| [0002](0002-test-feedback-loop.md) | Document-first, test-driven autonomous feedback | Accepted |
| [0003](0003-apache-source-license.md) | Retain Apache-2.0 for Iron Go source | Accepted |
| [0004](0004-vscode-color-themes.md) | Shared VS Code dark/light palettes for the workbench and Monaco | Accepted |
| [0005](0005-goland-run-and-test.md) | GoLand-inspired run target and test workflows | Accepted |
| [0006](0006-project-first-welcome.md) | Project-first welcome; Orbit is test-only | Accepted |
| [0007](0007-delve-test-debugging.md) | Delve DAP over a private socket for named Go tests | Accepted |
| [0008](0008-appkit-quit-guard.md) | Send ordinary macOS Quit and window close through one AppKit guard | Accepted |
| [0009](0009-save-transactions.md) | Serialize same-profile save replacement and reject stale file results | Accepted |
| [0010](0010-workbench-workflow-ownership.md) | Separate project transitions and Quit reservations from Go execution | Accepted |
| [0011](0011-native-tool-transport.md) | Share bounded Go tool transport without merging LSP and DAP | Accepted |
| [0012](0012-vscode-modern-color-reference.md) | Use VS Code Modern colors for workbench roles | Accepted |
| [0013](0013-go-syntax-colors.md) | Give Go tokens their own color rules | Accepted |
| [0014](0014-editor-typography.md) | Bundle JetBrains Mono as the editor default | Accepted |
| [0015](0015-external-file-reconciliation.md) | Reconcile native filesystem changes against document baselines | Accepted design |
| [0016](0016-reviewed-disk-conflicts.md) | Bind a disk conflict decision to the version shown to the user | Accepted design |
| [0017](0017-save-before-transition.md) | Guard sequential saves before project cutover and native Quit | Accepted design |
| [0018](0018-exclusive-new-path-save.md) | Publish new-path saves with exclusive native replacement | Accepted design |
| [0019](0019-go-navigation-snapshots.md) | Bind Go navigation results to the originating editor snapshot | Accepted design |
| [0020](0020-explicit-go-import-edits.md) | Apply only direct, version-bound Go import edits | Accepted design |
| [0021](0021-preview-go-renames.md) | Rebuild and verify Go workspace state before applying a rename preview | Accepted design |
| [0022](0022-parallel-feedback.md) | Overlap independent feedback layers and preserve native teardown | Accepted design |
| [0023](0023-build-and-run-configurations.md) | Build and run configured Go executables under one task owner | Accepted design |
| [0024](0024-structured-go-test-results.md) | Decode bounded Go test events independently of the visible output limit | Accepted design |
| [0025](0025-verify-go-test-reruns.md) | Verify the Go package snapshot before rerunning a named test | Accepted design |
| [0026](0026-read-only-go-source.md) | Open Go toolchain and module cache source as read-only snapshots | Accepted design |
| [0027](0027-pause-scoped-debug-inspection.md) | Bind debug frames, scopes, and variables to one pause and selection | Accepted design |
| [0028](0028-executable-debug-handoff.md) | Build and hand off an executable to Delve under one native launch identity | Accepted design |
| [0029](0029-native-project-recovery.md) | Persist immutable crash snapshots and incarnation-bound project sessions | Accepted design |
| [0030](0030-workspace-path-mutations.md) | Rebind editor paths after native exclusive file operations | Accepted design |
| [0031](0031-native-terminal-ownership.md) | Own terminal sessions and output credit in the native host | Accepted design |
| [0032](0032-editor-accessibility-mode.md) | Use Monaco screen-reader modes in the native editor | Deferred |
| [0033](0033-go-semantic-highlighting.md) | Overlay gopls semantic colors on Monaco lexical highlighting | Accepted |
| [0034](0034-go-modern-color-baseline.md) | Use pinned VS Code Modern foreground colors for Go | Accepted |
| [0035](0035-native-menu-and-navigation-history.md) | Route native menu commands through the workbench and keep jump history in the editor | Accepted design |
| [0036](0036-native-acceptance-report-completeness.md) | Verify critical native case results by phase | Accepted design |

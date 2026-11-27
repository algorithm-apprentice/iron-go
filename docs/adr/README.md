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

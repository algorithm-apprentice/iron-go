# Design index

Designs record feature invariants, alternatives, acceptance criteria, and
verification. For current instructions, start at the [documentation index](../README.md).
Long-lived decisions are indexed in [ADRs](../adr/README.md). Historical plans
and initial baselines are in the [archive](../archive/README.md).

The [architecture review follow-up](architecture-follow-up.md) tracks the
cross-cutting ownership and complexity fixes.

## Projects, files, and recovery

- [Welcome and project opening](goland-projects.md); [recent projects and editor sessions](recent-projects.md).
- [External file reconciliation](external-file-reconciliation.md); [reviewed disk conflicts](reviewed-disk-conflicts.md); [save and discard decisions](document-decisions.md).
- [Save to a new path](save-to-new-path.md); [format on save](format-on-save.md); [workspace file operations](workspace-file-operations.md); [crash drafts](crash-drafts.md).

## Navigation and Go tooling

- [Native menus and navigation history](native-menu-and-navigation-history.md); [keyboard commands](keyboard-workbench.md); [Go symbol navigation](go-symbol-navigation.md).
- [Read-only dependency source](go-dependency-source.md); [refactor previews](go-refactor-preview.md).
- [Run and Test](goland-run-and-test.md); [run configurations](go-run-configurations.md); [structured test results](go-test-results.md).
- [Delve test debugging](delve-test-debugging.md); [paused inspection](debug-inspection.md); [executable debugging](debug-go-program.md); [interactive terminal](interactive-terminal.md).

## Workbench appearance and accessibility

- [Project and Settings entry points](workbench-entry-points.md); [bottom panel controls](output-panel-controls.md); [keyboard accessibility](workbench-accessibility.md).
- [Control size audit](workbench-size-audit.md); [compact chrome](compact-workbench-chrome.md); [editor row alignment](editor-row-alignment.md); [gutter density](editor-gutter-density.md); [editor typography](editor-typography.md).
- [VS Code themes](vscode-color-themes.md); [Modern workbench colors](vscode-modern-colors.md); [Go lexical colors](go-syntax-colors.md); [semantic highlighting](go-semantic-highlighting.md); [Go Modern color alignment](go-modern-color-alignment.md).
- [Application icon](app-icon-edge.md).

## Testing design

- [Feedback layers and isolation](test-feedback-loop.md); [parallel feedback](feedback-test-efficiency.md).
- [Hosted native Quit](hosted-native-quit.md); [focused regression coverage and report completeness](focused-regression-coverage.md).

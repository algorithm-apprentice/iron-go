# ADR 0005: Discover Go Targets and Run Tests from Code

Status: Accepted.

Design: [GoLand-inspired Run and Test](../design/goland-run-and-test.md).

Keep the VS Code workbench layout but prefer selectable Go targets and
in-editor test actions over required CLI text. Use Go's own `go list` to
discover packages and existing gopls document symbols for test CodeLens.
Neither discovery path executes the workspace. Build, run and test retain
the existing explicit action, save-first and process-group rules.

# ADR 0012: Use VS Code Modern colors for workbench roles

Status: Accepted. See [the Modern color design](../design/vscode-modern-colors.md).

Supersede only the 2026 palette reference in [ADR 0004](0004-vscode-color-themes.md)
with the resolved Dark Modern and Light Modern colors from VS Code 1.148.0.
Keep one semantic CSS palette per theme and feed matching roles to Monaco's
public theme API. Retain the existing stored theme choice, Monaco's syntax
tokens, application colors without a direct reference, and native OS dialogs.
VS Code is a validation reference, not a build or runtime dependency.

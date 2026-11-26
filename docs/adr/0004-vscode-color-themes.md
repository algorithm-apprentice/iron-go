# ADR 0004: Shared VS Code Dark and Light Palettes

Status: Accepted.

Design: [VS Code Color Themes](../design/vscode-color-themes.md).

Store the selected theme as a local workbench preference. Use the VS Code
2026 palette for existing workbench roles and feed the same CSS tokens to
Monaco's public theme API. Let Monaco's built-in `vs` and `vs-dark` themes
provide syntax tokens. Do not copy the full VS Code theme or reset editor
models when the display theme changes.

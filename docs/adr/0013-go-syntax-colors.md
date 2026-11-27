# ADR 0013: Give Go tokens their own color rules

Status: Accepted. See the [Go syntax color design](../design/go-syntax-colors.md).

Supersede [ADR 0004](0004-vscode-color-themes.md)'s reliance on inherited
syntax colors only for tokens already classified by Monaco's Go tokenizer.
Style Go-specific tokens in both standalone Go and embedded Markdown Go;
keep other tokens, tokenizer behavior, and unclassified names unchanged.
Keep [ADR 0012](0012-vscode-modern-color-reference.md)'s Modern workbench
colors and the stored theme choice. Do not import a second grammar or make
syntax colors dependent on a running language server.

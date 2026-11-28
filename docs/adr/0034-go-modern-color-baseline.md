# ADR 0034: Use pinned VS Code Modern foreground colors for Go

Status: Accepted. See [the alignment design](../design/go-modern-color-alignment.md).

Use the VS Code 1.148.0 Modern palettes as the baseline for mapped lexical
and semantic Go roles. Keep upstream colors separate from token coverage:
Monaco and gopls retain their existing responsibilities. Future overrides
should name the baseline role and explain why it needs to differ.

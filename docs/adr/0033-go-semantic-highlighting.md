# ADR 0033: Overlay gopls semantic colors on Monaco lexical highlighting

Status: Accepted. See [the design](../design/go-semantic-highlighting.md).

Use full-document semantic tokens for native Go models with a supporting
gopls. Translate its negotiated legend into a Go-specific Monaco legend.
Only explicitly styled spans override the tokenizer. This preserves prompt
lexical coloring without the server and avoids a separate delta-token cache.

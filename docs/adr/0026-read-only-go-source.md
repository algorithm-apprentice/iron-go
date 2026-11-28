# ADR 0026: Open external Go source as read-only snapshots

Status: Accepted. See [the source navigation design](../design/go-dependency-source.md).

The workbench's Go to Definition action can read source from the current Go
toolchain and completed module cache. Discover roots offline in the admitted
workspace and use native no-follow traversal below each configured root.
Keep external files out of the editable workspace and language-server model
lifecycle. Monaco's built-in definition provider remains workspace-only,
including Peek; the workbench action carries the exact selection directly to
the read-only viewer.

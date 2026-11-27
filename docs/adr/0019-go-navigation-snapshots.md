# ADR 0019: Bind Go navigation to the originating editor snapshot

Status: Independently reviewed design. See [Go symbol navigation](../design/go-symbol-navigation.md).

Reuse the live `gopls` connection for symbols and references. Flush open Go
buffers before a workspace reference request. Capture editor and workspace
identities and versions, and cancel a request when its snapshot is superseded.
Keep the selection guard through the last activation check, including a
pending read of an unopened result file.

Use the ordinary workspace reader and bounded ranges. Accept canonical local
file URI syntax and validated workspace-relative paths; validate UTF-16
bounds before publishing a new editor. Opening dependency sources remains a
separate capability with a narrower native read policy.

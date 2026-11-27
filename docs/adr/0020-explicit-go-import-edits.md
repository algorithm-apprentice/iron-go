# ADR 0020: Apply only direct Go import edits

Status: Independently reviewed design. See [Go refactor preview](../design/go-refactor-preview.md).

Use the enabled `gopls` organize-imports code action only when it supplies an
explicit text edit to the originating buffer and no command. Reject changes
outside the captured URI or version, workspace resource operations, and
invalid or overlapping ranges before mutation.

Apply the exact normalized text as a single undo unit using its individual
edit ranges. Preserve unrelated whitespace and editor decorations. An
accepted import edit marks the buffer dirty and does not change its disk
baseline or write it to disk.

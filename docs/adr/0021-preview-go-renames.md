# ADR 0021: Preview Go renames against a verified workspace

Status: Independently reviewed design. See [Go refactor preview](../design/go-refactor-preview.md).

Use a fresh workspace `gopls` session for Rename so an old package view cannot
hide closed-file changes. Validate each open Go overlay against its disk
baseline and carry a bounded native source stamp across preparation and
approval. Reject stale or incomplete observations and unsupported edits.

Show the validated before-and-after text in disposable read-only models.
Apply only after every target and the workspace remain current. Changes are
undoable per buffer and still require an ordinary conditional save.

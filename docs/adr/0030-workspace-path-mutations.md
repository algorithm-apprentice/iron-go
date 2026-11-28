# ADR 0030: Apply exclusive native workspace path mutations

Status: Accepted. See [workspace file operations](../design/workspace-file-operations.md).

Serialize native moves and Trash staging with the stable profile Save lock.
Use descriptor-relative exclusive rename on macOS and verify the moved
identity before rebinding Monaco, breakpoints, or drafts. Record uncertain
or stranded paths as partial results that require a fresh Save decision.
Invoke macOS Trash from a verified staging path and never permanently
delete in response to a failed Trash request.

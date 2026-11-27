# ADR 0018: Publish new-path saves exclusively

Status: Independently reviewed design. See [Save to a New Path](../design/save-to-new-path.md).

Reuse the profile lock and descriptor-relative staging from
[ADR 0016](0016-reviewed-disk-conflicts.md). Publish the complete file with
macOS exclusive rename; do not overwrite or create missing directories as a
fallback. Exclude the app's reserved profile directory, including its nearest
existing ancestor when the profile has not yet been provisioned.

The renderer reserves the destination against open and opening aliases using
Unicode case folding and normalization. After commit, use the disk spelling
and a new Monaco identity, preserve newer buffer text, and keep it dirty
against the committed baseline. The original source file is unaffected.

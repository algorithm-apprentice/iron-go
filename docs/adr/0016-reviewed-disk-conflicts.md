# ADR 0016: Bind disk conflict decisions to reviewed versions

Status: Independently reviewed design. See [reviewed disk conflicts](../design/reviewed-disk-conflicts.md).

A conflict comparison uses disposable, read-only snapshots, leaving the
ordinary save baseline untouched. Applying a reviewed reload or save requires
the captured model revision and the matching disk identity, metadata and
bytes. Stale decisions require a new comparison. This adds a precondition to
[ADR 0009](0009-save-transactions.md) and keeps its limits on external writes.

Stage, validate, and replace files relative to the captured destination
directory descriptor under the existing profile lock. Check the admitted
root and directory identity again before replacement. Remove a staging name
only when descriptor-relative metadata identifies it as the owned file.

# ADR 0017: Save before project cutover and native Quit

Status: Independently reviewed design. See [save and discard decisions](../design/document-decisions.md).

Individual file decisions use app-owned dialogs and one file-activity
reservation through settlement. Applying a close or reload still requires the
captured document and revision. Save and Close never discards later edits.

Save All and save-before-transition write dirty tabs sequentially. Stop at
the first failure or newer unsaved edit and report committed paths; do not
roll back earlier writes. A project transition requires both successful saves
and a clean workspace before the native cutover.

Extend the [native Quit guard](0008-appkit-quit-guard.md) to check a monotonic
ticket deadline at each save admission and final approval. An admitted write
can settle after expiry; queued writes and approval cannot start on that
ticket. Refusal preserves the workbench and running children and releases the
renderer reservation after admitted I/O settles.

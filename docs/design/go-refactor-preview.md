# Review Go refactors before applying them

Status: Organize Imports and multi-file Rename implemented. This follows
[Go symbol navigation](go-symbol-navigation.md).

## Scope

- **Rename Symbol** uses `gopls` prepare/rename and previews Go source changes
  per file before applying. **Organize Imports** requests the explicit
  `source.organizeImports` code action for the active Go document. Reuse the
  language client's workspace edit validator for both operations. Do not
  rewrite imports as part of gofmt or an unrelated file move.
- Advertise rename prepare support and literal code-action support for
  `source.organizeImports`. Accept only an enabled organize-imports action
  with a direct edit confined to the active model and no command, even when
  that command accompanies an edit. Decline unresolved or unsupported actions.
  Organize Imports is an independent first slice: apply its accepted single
  buffer edit immediately as one Undo unit. Waiting for the bounded language
  request does not reserve file activity; obtain the reservation only before
  applying to the still-current model. Rename retains the multi-file diff
  and approval workflow below.
- The first implementation accepts only workspace text edits, in either
  `WorkspaceEdit.changes` or text-only `documentChanges`. No file create,
  rename, delete, command-only action, or external path is executed. Do not
  apply a partially validated edit set.

## Invariants

- Prepare Rename and Find References identify candidate workspace files.
  Load any missing candidate documents from the same native observation that
  supplies their disk version, without activating them, then sync them through
  the ordinary `didOpen` and `didChange` path. Opening candidate tabs makes
  their lifetime visible and avoids temporary overlays with competing owners.
  References need not enumerate every rename target (for example receivers
  of other methods): load and sync additional returned targets, then rerun the
  rename. Cap the expansion at two reruns and 128 models. An unprepared target
  after that cap fails without applying edits.
- Capture project, language service, model identities, versions and the
  readable disk observations of all participants. A mismatch while preparing
  or between preview and Apply invalidates the entire proposal. No operation
  follows a path or URI to an unrelated project. Losing `gopls` leaves ordinary
  editing and `gofmt` available.
- Rename also captures membership and revisions of all tracked Go buffers,
  and a bounded workspace source signature from Rust (Go sources and module
  inputs, with anchored paths and native metadata versions). Recheck the
  signature after the language request and before Apply; a new reference in
  a non-participant may make an otherwise valid proposal incomplete. Refuse
  rename where enumeration is truncated or the signature cannot be verified.
- To bind rename to disk state even if files changed before invocation, start
  a fresh workspace language server under the existing session owner for the
  rename preparation. Wait for initialization, replay the open Go models,
  and capture or recheck the signature across initialization and the request.
  Do not rely on language-server watching of closed files or reuse of its
  old package view. Verify every replayed Go overlay against its current disk
  baseline, including buffers gopls will not later identify as participants.
  Verify directory membership and source-file versions across the native scan.
  Changes during preparation or a failed restart invalidate the operation
  before any edits. This restart is not needed for the local Organize Imports
  request against a synced open model.
- Decode and validate the entire edit set before presenting it. Validate
  canonical workspace file URIs, declared document versions when supplied,
  UTF-16 ranges against exact source text, and nonoverlap. Reject an endpoint
  in the middle of a surrogate pair, a duplicate or ambiguous edit, or a
  range that Monaco would need to clamp. Preserve existing text outside edits.
- On Apply, reserve file activity before the first reinspection and hold it
  through the final synchronous preflight and application. Revalidate all
  participants, including their original model identities and revisions,
  immediately before changing any model. After a complete preflight,
  apply the prepared operations synchronously as undoable edits per model.
  Compute the preview and applied text with the same model EOL convention.
  Disable Monaco's automatic whitespace trimming during the explicit edits,
  restoring that option afterward, so hidden whitespace edits cannot change
  lines outside the proposal. Verify the resulting text matches the preview.
  Do not auto-save. If an unexpected model failure causes partial buffer
  application, report the changed paths and preserve access to Undo.
- Use separate read-only before-and-after models, with changed lines derived
  from the validated edit ranges. Dispose them on cancel, apply, invalidation,
  or project switch. Keep distinct the proposed editor edits and any external
  disk conflict; a refactor does not acknowledge the external disk version or
  bypass a conditional Save.

## Alternatives

- Do not infer Go symbol identity from text search or guessed syntax tokens.
  `gopls` owns semantic rename and import decisions; Iron Go owns validation,
  user approval, and editor state.
- Do not let the language server execute unknown workspace commands or apply
  changes in the background. Preview a bounded accepted operation instead.

## Acceptance

- Use real `gopls` in a multi-package fixture. Rename a symbol with references
  in opened and unopened files, preserving unrelated unsaved edits. Verify a
  range after a supplementary-plane character, per-file undo, and no disk
  writes until Save. Organize a valid file with an unused import and verify
  only the intended model is edited.
- Rename a method receiver with another method in an unopened file so a later
  language response adds a previously unprepared target. Cover an active Go
  buffer with pending auto-indent whitespace and assert that Apply exactly
  matches the preview.
- Edit a second participant or change its on-disk identity while the preview
  is open; reject Apply before the first edit. Use deterministic malformed
  payloads for outside-workspace URIs, resource operations, inconsistent
  versions, invalid endpoints and overlapping ranges. Also introduce a new
  reference outside the original edit set, once in an open buffer and once
  on disk in a previously closed file; neither stale preview may apply.
- Change a closed file before invoking Rename, after the old language server
  has seen the workspace. Its new reference must appear in the proposal or
  cause refusal; equal native signatures alone are not sufficient.

## Organize Imports verification

- The first native Go regression failed because the palette command was absent.
  The implemented command passed against real `gopls`, with unchanged disk
  bytes and one-step Undo. The native case also holds a real reply, saves newer
  work while it is pending, then waits for the stale action to be rejected.
- Focused parser tests cover literal commands, malformed and mixed edit sets,
  resource operations, foreign targets, and different equivalent URI escape
  spellings. Browser coverage verifies CRLF, unrelated automatic indentation,
  a tracked decoration, and Undo after exact range application.
- The final check and 39 browser cases passed. In the first native run of the
  final build, the existing typography assertion did not settle in the Files
  group (`test-results/native/1795802893006-60812`); that same Files group
  passed unchanged on a targeted repeat (`test-results/native/1795803007406-62638`)
  and all six native groups passed together on the same build
  (`test-results/native/1795803034172-62728`).

## Rename verification

- The first native regression failed because Rename was missing. The final
  native Go group passed with required `gopls`
  (`test-results/native/1795804408540-71110`). It checks a closed file changed
  before invocation, refusal of a stale overlay that would hide a reference,
  before-and-after preview text, refusal after a disk change, four-buffer
  application without writing disk, per-buffer Undo, and subsequent Hover
  and Go to Definition.
- Rust regressions inject directory membership changes and in-place source
  writes during the workspace stamp and verify refusal. The native fixture
  does not separately exercise the receiver-specific candidate expansion or
  every form of malformed workspace edit.

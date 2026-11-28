# External file reconciliation

Status: First implementation slice of the
[daily Go workbench plan](../archive/daily-go-workbench.md).

## Scope

Detect external changes in native projects, refresh the project tree, reload
clean open files safely, and visibly distinguish changed, missing, and
unreadable disk versions while preserving dirty work. Keep the existing
conditional save path. An interactive comparison, explicit conflict
replacement, Save to a New Path, and dirty tab choices require separate
decisions and are not shortcuts around this slice's guarantees.

## Design and invariants

- Start one recursive native `notify` watcher for the current workspace ID.
  Rust owns the subscription and stops it on project cutover or close. The
  callback advances a latest-value revision, not a queue of filenames or
  contents. The renderer waits for a new revision with at most one outstanding
  wait, then revalidates before waiting again. Ignore read/access events and
  paths excluded from the workspace tree; rescan and ambiguous events bypass
  that filter. Watch setup or terminal failure surfaces the manual fallback.
  An idle wait also verifies the admitted root identity periodically, without
  rescanning the tree: FSEvents can remain silent when an ancestor is moved.
  A failed identity check ends the watch and triggers a final reconciliation
  so the retained tabs report that disk is unavailable.
- After subscription, on coalesced signals, on activation, and on **Refresh
  Project**, request the current tree and inspect open files. Only one automatic
  pass runs at a time; a new request during that pass schedules another. Scope
  results to the project and document. Apply newest-request-wins ordering to
  every tree publication, including existing manual and own-write refreshes.
  Tree changes refresh Quick Open. Package discovery keys off Go paths and
  bounded `go.mod`/`go.work` content signatures, including nested modules.
- Inspect paths using native path validation and bounded regular-file reads.
  At workspace admission, retain a directory descriptor obtained by no-follow
  traversal from the filesystem root. Bind it to the admitted workspace ID.
  Verify that the canonical workspace path still names that admitted directory
  before and after each observation. An absent, redirected, or replaced root
  is unavailable; never adopt its replacement under the old workspace ID.
  New File also verifies admission and creates paths relative to the bound
  descriptor, so it cannot write into a replacement workspace.
  Walk descriptors using `openat` with no-follow checks for directory segments
  and a nonblocking, no-follow leaf open. Validate type on the opened file.
  Distinguish missing paths from unreadable, unsupported, or replaced paths
  that cannot be read safely; keep transport and stale-workspace errors
  separate. Recheck descriptor metadata and path identity after reading; retry
  an unstable observation. A recheck at application time must match the live
  tab, its model version, and its save/reload revision. Inspect a native tab
  after it becomes live, including an open whose initial read overlapped a
  notification. Defer while explicit save/reload is active, then follow up
  after settlement. An Iron Go save whose observed bytes match the updated
  baseline does not produce a conflict.
- A changed clean tab adopts the new bytes without resetting its undo history
  or intentionally moving the caret for ordinary content changes. If a changed
  BOM or line-ending convention requires replacing the Monaco model value,
  use explicit reload semantics, including resetting undo. Commit raw disk
  bytes, normalized clean text, and disk state together; do not make a
  synchronous model change event report an intermediate baseline. Preserve
  cursor, selection, and scroll where the new file allows. Undoing an ordinary
  external reload restores the old text as dirty against the new baseline.
  A changed dirty tab keeps all edits and is marked
  changed on disk. A missing or unreadable file keeps the current model even
  when it was clean. Show the state in the tab and a status region for the
  active file. If disk returns to the saved baseline, clear the indication.
  A user save still uses the original baseline and must never implicitly
  acknowledge a disk change. Reconciliation itself never writes source files.

## Alternatives

- Recursively polling the workspace increases steady-state I/O. Use macOS
  file events through `notify`, plus bounded revalidation on demand or wake.
- Applying watcher paths as authoritative new state misses rename pairs,
  overflow, and events from the app's own transactional writes. Verify current
  bytes and use the same path rules as explicit reads.
- Pristine-only reload without a warning leaves dirty tabs deceptively quiet;
  automatic merge would alter unsaved work. Track and display disk divergence.

## Acceptance

- Native WKWebView: in a disposable project, change two open files externally,
  one clean and one dirty, and add a file. Without pressing Refresh, verify
  clean text changes, the dirty buffer and disk bytes both survive, the changed
  state is visible, and the new file appears in Quick Open. Remove an open file,
  then recreate it; verify the missing state and eventual clean reconciliation.
- Make an open path unreadable using an unsupported replacement. Confirm the
  buffer survives and the indication is distinct from deletion. Exercise manual
  refresh and stopping the old subscription on workspace transitions.
- At the document layer, delay an external read across an edit or save and
  verify the late observation cannot clobber new text or report a stale
  conflict. Exercise a first open overlapping a notification, save failure,
  undo after automatic reload, and BOM and line-ending changes. Confirm
  matching baseline clears the mark and own saves do not create a warning.
- Cover replacement of the admitted root, an ancestor move with no focus
  change, a parent replaced by a symlink, a leaf replaced by a FIFO, events
  coalescing during an in-flight pass, and a delayed old-project signal. Verify
  an older snapshot cannot replace a newer tree and a `go.work` edit changes
  run targets even when tree paths are unchanged.

## Verification

- The first native regression failed because an external write did not update
  a clean buffer. The first browser document regression also failed before
  reconciliation existed.
- The full `npm run test:feedback` run passed with 32 browser cases and all
  five native groups (`test-results/native/1795798261065-21957`). The native
  Files group verified live Quick Open, clean reload, dirty and missing file
  handling, `go.work` rediscovery without a tree change, and refusal to create
  a file under a replacement root after moving the original root's parent.
- After the final reviewed change to subscription retirement, `npm run check`
  and the native Files group passed again (`test-results/native/1795798345126-24135`).
- Focused cases prove stale edit/save and snapshot results cannot apply,
  ordinary external reload is undoable against the new baseline, BOM and CRLF
  changes are adopted, and an anchored inspection refuses a symlink, FIFO, or
  replacement root.
- Native lifecycle tests exercise closing and switching projects. A
  deterministic injection of FSEvents overflow and a first-open IPC delay
  are not part of this verification. Conflict comparison and resolution are
  follow-up work; this slice marks the condition and preserves both versions.

See [reviewed disk conflicts](reviewed-disk-conflicts.md) for the next slice.

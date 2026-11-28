# Review and resolve disk conflicts

Status: Follow-up to [external file reconciliation](external-file-reconciliation.md).

## Scope and choices

- **Compare with Disk** is available from the active tab's disk notice and
  the command palette for a native file. A workbench dialog shows read-only
  Monaco panes, with disk on the left and the captured editor buffer on the
  right. Highlight the regions between the common prefix and suffix of
  lines, and reveal their first changed line immediately. The full snapshots
  remain available for independent review and scrolling. Compute the suffix
  only from lines left after taking the prefix. For insertion or deletion,
  the empty side has no highlight and reveals the corresponding line, clamped
  to its last line. Identical displayed text has no highlight or forced scroll.
  The dialog names the captured path. It offers **Keep Editing**, **Reload
  Reviewed Disk Version**, and, for a dirty buffer, **Save Over Reviewed Disk
  Version**. Escape cancels. Missing or unsupported disk files have no reviewed
  replacement choice; Save to a New Path owns that separate workflow.
- Capture the workspace, tab identity, editor version, and save/reload revision
  before requesting the disk observation. Never redirect a decision to a newly
  active tab. After any await, check the operation's captured identity; a model
  edit or intervening save/reload invalidates the question. Keep only one file
  decision active, and count it as file activity through settlement. An ordinary
  Quit, project cutover, or Go admission cannot overlap the decision.
- Reserve before opening a loading dialog and starting inspection. Escape can
  cancel during loading; ignore the abandoned result. Suppress automatic
  reconciliation for the captured tab from reservation through settlement,
  including already in-flight observations, and request a new check on release.
  Selecting an action closes the dialog and consumes the decision once. Once a
  write is admitted it finishes normally; editing after submission is allowed.
- Keep both snapshots immutable in separate, disposable diff models. Dispose
  preview models on close, and retain the original buffer, selection, and view
  unless the user chooses a valid write or reload. Restore focus to the opener
  or current editor after close. Loading and errors cannot leave an invisible
  modal or active reservation.
- Render whitespace and disable whitespace-ignoring diff. Show each side's
  BOM and line-ending convention. If either side has mixed line endings, the
  diff remains available but destructive choices stay disabled because Monaco
  does not show the raw placement of each terminator.

## Version and write contract

- For a stable readable observation, Rust returns bytes and an opaque metadata
  version encoding the native file identity, size, and change times. Compare
  bytes as well as version: the version is a concurrency precondition, not
  authority to name a different workspace or file. The ordinary Save command
  continues to use its original baseline.
- Reviewed Save supplies the displayed disk bytes and metadata version to the
  existing atomic save. Hold the admitted root and destination-parent
  descriptors across the transaction. Stage, inspect and rename relative to
  that parent, and recheck root and parent reachability under the stable save
  lock. Recheck the full reviewed version and exact bytes after reading the
  destination, immediately before replacement. Reject a replacement inode even
  when bytes match, and reject a moved parent even when it still holds the file.
  Error leaves the buffer dirty and does not advance its disk baseline. Success
  advances the baseline to the text actually written; edits made while saving
  remain dirty. As in ADR 0009, there is no guarantee against an external writer
  after final validation.
- Reviewed Reload re-inspects the current disk file and adopts the displayed
  version only when metadata and bytes still match. The existing reload
  transaction prevents replacing a newer editor buffer. After a stale decision,
  show an error and require reopening the comparison; never silently refresh
  a review just before applying its action.
- Successful reviewed saves run the same Go module and search refresh work as
  ordinary Save. All disk writes continue through Rust; there is no browser
  preview substitute for opening or saving native paths.

## Alternatives

- A disk timestamp alone misses preserved timestamps or inode replacement;
  the native identity and change times supplement exact bytes.
- An overwrite-anyway button or updating the baseline when opening the dialog
  would let the next ordinary Save overwrite unseen content. Bind each
  destructive action to the reviewed snapshot instead.
- Use Monaco's editor and model APIs rather than its asynchronous diff worker.
  The worker can reject when a preview closes before synchronization, or
  never signal completion after failure. The bounded changed region does not
  claim to be a minimal diff, needs no worker or cancellation handoff, and
  never hides text from either snapshot. No merge is performed.

## Acceptance

- In a disposable native workspace, make different buffer and disk edits.
  Open the diff from the visible conflict notice; verify it displays each edit
  on the appropriate side. Keep Editing preserves both. Save Over writes the
  captured edit only when the reviewed disk file is still current.
- Replace the reviewed file by renaming a new file with the same bytes over
  it. Reviewed Save rejects it and preserves both versions. Repeat with a
  changed disk file and Reload Reviewed Disk Version; the editor remains dirty.
- Reopen the current comparison and reload successfully. A newer buffer edit
  while the comparison is open invalidates both destructive actions. If the
  file is missing or unavailable, no overwrite can be initiated from this UI.
- Exercise Escape while loading, native Quit during a held reviewed save, and
  newer typing while the save is held. Verify a whitespace-only diff and a
  changed BOM or line-ending convention are visible before applying an action.
- Check a line added below the viewport, a pure insertion and deletion with
  an empty region on the other side, and identical displayed text. Close and
  immediately reopen the comparison with different contents; both panes must
  show the new snapshots, without invoking the diff worker or leaking models.
- In a filesystem regression, replace the root or destination parent across
  lock acquisition and change same-inode metadata after staging. Verify no
  unexpected path is written and replacement staging names are never removed.

## Verification

- The native regression initially failed because the comparison was absent.
  The full feedback suite later passed all five native groups and the browser
  suite (`test-results/native/1795799189083-28343`).
- The final native Files run (`test-results/native/1795799344742-31131`)
  verified both sides of the comparison, rejected a same-byte replacement,
  rejected stale reloads, displayed CRLF versus LF, and ran ordinary AppKit
  Quit and real editor typing while the native reviewed save was held. An
  ordinary Save then committed the newer edit against the advanced baseline.
- `npm run check` passed including the parent identity, same-inode metadata,
  and unreadable-stage regressions. The final focused browser case verified
  Escape during loading, mixed-ending and BOM display, disabled destructive
  actions for mixed endings, and disposal after closing the preview.
- A later Files regression showed blank or stale diff panes, followed by a
  Monaco worker error when temporary models were disposed mid-comparison.
  An earlier worker-based fix passed the native Files group once
  (`test-results/native/1795812053873-5918`) but remained vulnerable to delayed
  worker results. It was superseded by the worker-free preview design above.
- The worker-free preview passed the changed-region unit cases and a Chromium
  rapid-reopen case with a change below the initial viewport, zero worker
  requests, and no retained models after close. The native Files group passed
  with the same preview (`test-results/native/1795812537392-6701`).
  The subsequent full feedback run also passed
  (`test-results/native/1795812597296-7292`).

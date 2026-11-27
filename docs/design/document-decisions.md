# Save and discard decisions

Status: Implemented follow-up under the [daily Go workbench plan](daily-go-workbench.md).

## Scope and user-visible behavior

- Replace `window.confirm` in Close Tab and Reload File from Disk. Dirty
  Close offers Cancel, Discard, and Save and Close. Dirty Reload offers
  Cancel and Reload and Discard. Escape cancels. Clean close is immediate;
  clean reload keeps the current behavior. A dirty tab under a disk conflict
  still uses conditional Save; an error leaves it open and points to comparison.
- Add a standalone Save All command. Dirty project transitions offer Save
  and Continue alongside Cancel and the existing discard/continue choice.
  Ordinary macOS Quit and window close offer Save and Quit once native
  presentation succeeds. A failed or partial save leaves the project active
  and reports completed writes and the first failure. Quitting with no edits
  follows the existing clean path.

## Reservation, identity, and focus

- Share file activity admission with Compare with Disk. Reserve before
  prompting, through the close event, accepted save/reload, project metadata
  refresh and the last tab-close check; release in `finally`. The accepted
  operation can use the document methods directly under its own reservation.
  Acquire only when saves, formatting, other file mutations, and Go
  preparation are idle; make this check reciprocal with the operation gates.
  Other file decisions, project transition, Go admission and ordinary Quit
  cannot overlap it. After submitting an individual decision, users may
  continue typing; never discard newer work to finish closing an old version.
- Capture project, tab identity, model version, and save/reload revision.
  Revalidate after confirmation and before the final close. Save and Close
  closes only after the captured tab is still live, unchanged and clean.
  Reload uses the existing version and generation guard across disk I/O.
  The captured tab remains the target even when it is inactive.
- Keep Cancel initially focused. Preserve the role (tab label or close
  button) as well as tab identity across a workbench rerender. If Cancel's
  opener was replaced, restore the matching live control. Closing the active
  tab uses a remaining editor, or Go to File when it was the last editor,
  only if focus still belongs to the closed tab or its editor. If a user
  focuses another control during a save, completion does not steal focus;
  the document close operation has a no-focus path for this caller.

## Save All and transitions

- Save dirty tabs sequentially in the existing tab order with normal
  conditional saves. Capture every tab's version at batch start. Before each
  next write and at completion, check for newer unsaved edits across the batch,
  including a tab that was already saved. Stop on the first failure or newer
  edit. Track paths whose writes committed independently of their current
  dirty state. Report the committed paths and first failure or interruption;
  never signal complete success while a relevant tab is still dirty.
- Project transitions and Quit keep the existing exclusive reservation through
  the save sequence and final clean-state check. Cancelled or failed choices
  do not call the project picker or stop running children. A cancelled picker
  after successful saves keeps the project and its completed writes.
- Thread the native Quit ticket into each Save and Quit IPC admission. Rust
  stores a monotonic deadline with the ticket and checks it under the same
  gate both before admitting a write (including before the acceptance hold)
  and during final approval. Expiry is authoritative even when the AppKit
  timeout callback has not run yet. Stop queued saves on expiry or admission
  failure; an admitted write may finish and stays saved. After it settles,
  cancel, expiry, conflict, and save errors send a best-effort negative reply
  for that exact ticket before releasing the renderer reservation, so an
  immediate retry can get a new ticket.
- Keep ordinary Save, task save barriers, and reviewed disk saves independent
  of Quit tickets. Reject duplicate dialog submissions. Continue to rely on
  the accepted [AppKit guard](../adr/0008-appkit-quit-guard.md); do not add a
  separate termination path or block the AppKit run loop on disk I/O.

## Alternatives

- A WebView `confirm` is unavailable in the shipped app and cannot express a
  Save choice. Reuse app-owned dialogs and the existing file transactions.
- Do not save tabs in parallel or replace an existing disk version to make a
  transition succeed. Sequential conditional saves give observable failure
  boundaries and preserve unsaved text.

## Acceptance

- Native dialogs: Cancel, Escape, Discard, and Save and Close on a dirty
  inactive tab. A conflict leaves it open, and saving never changes the wrong
  file. Dirty reload uses the real buttons, including rejection after a newer
  edit. Hold Save and Close for an active tab with a successor available, move
  focus to another control, and verify completion doesn't steal it. Type in a
  separate held save to prove newer edits survive. A native Quit during a
  pending file decision must be refused.
- Keyboard: Cancel restores a keyboard-focused tab close control after render;
  closing the last editor sends focus to Go to File.
- Save All and project switch: save two dirty tabs; induce a conflict on the
  second, retaining the workspace and uncommitted text, then retry after
  resolving it. During a three-tab batch, re-dirty the first while the second
  is held and verify the third write never starts. Use an acceptance-only
  cancel route for the next picker, preserving the existing fixture routing
  and proving that Save and Continue followed by cancellation keeps the same
  project, its running child, and the completed writes.
- Ordinary native Quit: successful Save and Quit writes both files and tears
  down the running child. With a held save that outlives the ticket, retain
  the project and child, allow the admitted write to settle, and leave the
  second tab dirty. If the second tab conflicts after the first commit, show
  the completed path, retain the failed buffer and child, and prove that an
  immediate fresh Quit opens a new decision. Separately test native rejection
  of an elapsed ticket before the expiry callback runs.

## Verification

- The first Chromium regression failed because the dirty close dialog was
  absent. `npm run test:feedback` subsequently passed all 35 browser cases
  and six native groups (`test-results/native/1795800403886-37241`).
- Native Files verified real close and reload dialogs, replacement opener and
  Explorer focus, typing during an admitted Save and Close, and an interrupted
  three-file Save All. Lifecycle verified partial Save and Continue and picker
  cancellation without losing the running child.
- Native Save and Quit exercised both a partial save and an expired ticket that
  was still pending before native callback delivery. An admitted write settled,
  a queued write was rejected, and a fresh successful Quit saved both files and
  stopped the child. The separate native Discard scenario still passed.

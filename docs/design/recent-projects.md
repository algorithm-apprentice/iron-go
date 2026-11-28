# Recent projects and editor session restore

Status: Implemented slice of [project continuity](../archive/daily-go-workbench.md#5-project-continuity-and-file-management).

## Scope and invariants

- Welcome remains the startup screen. Add **Open Recent** on Welcome and in
  the command palette. Only an explicit open, new project, or recent-project
  selection records a location. Do not start a build, task, or debugger on
  launch or restore. Recovery drafts are independent of editor view state.
- Store a versioned, bounded app-local index of at most 20 recent projects
  with their stable native root identity, canonical path and display name.
  Store up to 32 ordered editor paths per project with an active path, cursor
  line/UTF-16 column and first visible line. No source text, run environment,
  process identity, or temporary IPC workspace ID is persisted. Limit the
  index to 1 MiB before decoding, canonical paths to 4096 UTF-8 bytes, names
  to 512 bytes, editor paths to 1024 bytes, and view coordinates to positive
  signed 32-bit values. Invalid or unsupported history remains available to
  clear explicitly; it must not prevent use of the normal picker. If the
  encoded replacement would exceed 1 MiB, refuse that update and retain the
  previous published index.
- Rust reads and updates the index under an advisory profile lock. Publish
  by private atomic replacement; two app instances can update different
  entries without overwriting each other. For the same project, the last
  valid committed session snapshot wins. Give each new entry an opaque
  incarnation that is never reused following remove, clear or eviction.
  Bind session writes to the admitted workspace ID and this incarnation;
  a delayed update cannot enroll a project, even after explicit re-add.
- Reuse the native project identity used for recovery. Open Recent uses the
  selected incarnation in a locked index lookup, verifies the identity of
  the exact opened root anchor. Stage any outgoing draft retirement while
  keeping its old index published, then recheck the selected path against
  that anchor immediately before the short retirement rename and in-memory
  cutover. A failed final check leaves the old index and outgoing workspace
  published. The admitted anchor continues to fence all later file I/O.
  Acquire locks in one order: workspace state, recent profile, draft
  runtime, then draft profile. Keep the recent lock through admission.
  If removal or clear commits first, a stale
  selection refuses cutover and leaves the outgoing workspace and drafts
  intact. After cutover, a failure to refresh recency cannot undo a workspace
  that was already installed; make the persistence failure visible.
- Open only regular, indexed workspace files. Restore at most the recorded
  documents and preserve their order; if the active path is absent, activate
  the first surviving tab, or use the normal initial file when none survive.
  Clamp stale coordinates to current text. Capture view state before changing
  a Monaco model, set the cursor then restore viewport after destination
  layout so cursor reveal cannot overwrite the scroll. Summarize skipped
  paths; a missing or replaced root leaves the ordinary picker available.
- Capture position/scroll and view state after normal workbench navigation,
  debounce writes with one in flight and one coalesced latest snapshot.
  Await the last visible state at switch and Quit. A Quit flush tries the
  native locks without waiting, checks the ticket again before publishing,
  and never publishes on an expired ticket. Use the existing ticket expiry
  to thaw the renderer if any earlier work has not returned. On a metadata
  failure keep the last completed state, report it, and let an otherwise
  approved Quit proceed. Reserve workbench
  navigation through restore, check the committed workspace after reads,
  and suppress persistence until the restored view is coherent. **Refresh
  Project** preserves current editors, deliberately reopening the active
  root starts fresh, and a recent open from Welcome restores. A fresh
  session can replace the old snapshot after its initial file settles.
- Remove one recent project or clear all recent history after confirmation.
  Remove its corresponding session metadata without closing the project or
  affecting source files or crash drafts. A delayed session update cannot
  re-enlist removed history; a later explicit open can add it again.

## Alternatives

- Keep project admission in Rust rather than making an arbitrary absolute
  open IPC available to the workbench. A recent entry is an explicit capability
  to reopen one previously admitted identity.
- Store stable cursor and scroll data rather than serializing Monaco's
  internal view-state shape, which can change between editor versions.

## Acceptance

- Open a disposable project, leave several files open at different cursor
  and scroll positions; hold the normal debounce after the last move and
  verify ordinary Quit flushes it. Delete one file. Relaunch with the same
  profile, verify Welcome, explicitly open a recent project, and verify
  surviving tab order, active and inactive positions and first visible
  lines, and the skipped-file message. Run a held-restore race plus Refresh
  Project and same-root reopen to prove their different navigation behavior.
- Verify missing/replaced root handling and fallback to the ordinary picker.
  Remove and clear entries, explicitly re-add the same root under a new
  incarnation, and release a held old view-state write. Verify it cannot
  overwrite the new entry. Verify one process updating a project preserves other projects'
  metadata. Verify unstable restoration replies cannot move a newer editor.
- Run `npm run check` and native acceptance with a real macOS relaunch.

## Verification

- The initial native relaunch failed at the missing Welcome action
  (`test-results/native/1795839752470-43748`). The native Recent group later
  passed real AppKit Quit and reopening through Open Recent with the same
  profile. It held the debounce and verified the last active and inactive
  carets and first visible lines, skipped a deleted tab, left Refresh Project
  intact, and used a fresh session on deliberate same-root reopen
  (`test-results/native/1795840775118-46246`, Recent group).
- The Rust incarnation test rejects an old owner's revision after clear and
  re-add. Chromium verified an obsolete restore could not replace a newer
  project's editor. Independent review approved the failed-index guard.

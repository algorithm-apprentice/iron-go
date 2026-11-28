# Recover unsaved project drafts after a crash

Status: Implemented slice of [project continuity](../archive/daily-go-workbench.md#5-project-continuity-and-file-management).

## Scope and invariants

- Record bounded UTF-8 draft text, its expected disk bytes and version token,
  canonical project path plus directory device, inode and creation time,
  relative path, and monotonic writer revision in the
  macOS app-local profile. The profile owns the records; no workspace file or
  Git metadata changes when recording, listing, or recovering a draft.
- Give each app process a native writer directory with an advisory owner
  lease held for its lifetime. Restrict its permissions to the owner. Use
  an opaque native draft ID and a new immutable payload filename for each
  publication. Publish only by atomically swapping the per-writer index;
  never alter a payload that a published index references. Readers hold the
  profile lock from the index read through opening the matching payload. A
  later action with an obsolete ID/revision refreshes its list and asks for a
  new selection. Remove an entry from the index before unlinking its payload.
  Reclaim unreferenced payloads and empty detached writer directories under
  the profile lock and the relevant owner lease. Validate profile owner and
  restrictive permissions, use descriptor-relative no-follow opens, and
  bound reads before parsing.
  Allow 2 MiB each of decoded text and baseline, 24 MiB encoded per payload,
  and at most 128 indexed records / 128 MiB of payloads across 64 writers in
  one profile. Limit each index to 256 KiB. Quota admission, publication and
  reclamation share the profile advisory lock. Failed admission is visible;
  allow explicit reviewed removal of detached drafts and never silently
  evict recovery text.
- A writer serializes revisions and retirement for its own path through a
  native revision watermark. Keep up to 4096 active path watermarks per writer
  in memory under the same lock as publication. A crashed writer never
  publishes again, so its index needs only the live records, not tombstones.
  A save, deliberate discard, or rebind retires
  only the revisions it actually supersedes. Assign a new writer fence at
  baseline change as well as edit: a snapshot produced before a committed
  Save cannot publish after its fence, even if it includes newer typing than
  the save submitted. Republish still-dirty text against the new baseline.
  Save to a New Path retires the old key and records later edits at the new
  key. Return the native token of the actual committed file from both save
  operations (from its descriptor), rather than inspecting a path that
  another writer could replace. Undo-to-clean, successful Reload and Discard, and deliberate Close
  retire the current key. Reopening a tab uses a newer revision in the same
  writer. A failed save does not retire the draft.
- After the user explicitly opens a matching native project, offer recovery
  from completed snapshots. Show conflicting snapshots separately and
  preserve other writers' records. Reading an active writer's snapshot does
  not grant ownership. A recovered copy is a fresh unsaved buffer with its own
  writer identity; recovering leaves the original for explicit removal. To
  remove a detached record, acquire the exclusive lease nonblocking on the
  same stable lock inode and hold it while re-reading the reviewed index,
  removing the matched revision from it and unlinking its payload. Do not
  treat a PID probe as ownership.
- Compare the recorded baseline with actual disk. An unchanged file recovers
  into a dirty buffer. A changed, missing, or unreadable file also recovers
  into a dirty buffer but retains the original bytes and version token; a
  normal Save uses both under the existing conditional-save lock and
  must not automatically authorize overwriting the newer disk. Reuse the
  disk-conflict and Save to a New Path flows. Readable disk is unchanged only
  when bytes and version both match; a same-byte replacement is changed.
  An unstable inspection requires retry before applying recovery. If that path
  already has a dirty live buffer, offer the draft for comparison without
  replacing the buffer. Do not replace a recovered buffer with another
  candidate for the same path. Cancelled or stale recovery leaves both the
  selected tab and its recovery record available.
- Schedule bounded writes on a short debounce, with a maximum dirty interval
  so continuous typing can still reach a completed snapshot. Report recording
  failure persistently in the workbench, including disk-full and limit cases.
  Explicit Close waits for retirement. For switch, carry the outgoing ID and
  captured retirement plan through the picker, and publish at native cutover
  only after a new workspace was selected and validated. A cancelled picker
  never retires drafts. For Quit, freeze the writer after preparing the new
  index and keep the old index published throughout fallible process cleanup,
  ticket checks, and AppKit's termination request. Publish the prepared index
  only in the native final `RunEvent::Exit` for the approved Quit. If AppKit
  falls through, the ticket expires, or preparation fails, discard the stage
  and thaw the writer; no republishing is needed. A last-moment filesystem
  failure publishing during final Exit leaves the old drafts recoverable.
  Quit retries contested workspace, runtime, and profile locks for a bounded
  interval, without holding them while waiting, and rechecks the ticket
  before accepting a prepared index. The editor thaws if its ticket expires
  while the native decision is still pending.
  Reopening starts on Welcome.
- Source replacement and draft-index publication are distinct. If a crash
  falls between successful disk commit and index publication, recovery may
  show a redundant older snapshot. Never apply it silently. Surface cleanup
  failure independently of the already committed file bytes; a committed
  Save followed by an acknowledged retirement cannot resurrect a snapshot.

## Alternatives

- Do not use browser storage or workspace sidecar files for crash drafts.
  The former does not give native writer ownership or transactional disk
  constraints; the latter pollutes repositories and can point outside them.
- Use one record per document per writer, rather than rewriting the entire
  recovered workspace every time a document changes.
- Leave recent-project metadata and explorer file mutations to separate
  slices. Use the same stable project identity and expose a retirement/rebind
  operation that later file mutations can call under the file-operation lock.

## Acceptance

- In a disposable native app, edit a Go file, await its completed draft, and
  abruptly terminate the app. Launch with the same test profile and explicitly
  open the project. Recover into an unsaved buffer and verify original disk
  bytes. Repeat after changing, replacing, and removing the baseline file.
- Hold an older write across newer typing, Save, and explicit Discard. Verify
  only the highest still-dirty revision remains after reopening, and a failed
  save preserves its recoverable snapshot. Exercise same-path drafts from two
  app processes and show that a retired writer cannot unknowingly erase the
  other's snapshot.
- Cancel Discard and Continue at the picker, expire Discard and Quit while
  staged, and simulate AppKit refusing prepared Quit; all must retain the
  published draft and buffer. Run two real app instances
  on one disposable profile: removal of an active owner's snapshot fails,
  and stale removal after that owner publishes a newer revision and exits fails.
- At the cheapest layer prove record bounds, atomic replace, monotonic
  retirement, project identity checks, symlink rejection, and persistent
  failure reporting. Use native acceptance for IPC, the real profile, and
  crash/relaunch behavior.

## Verification

- The first native run failed because editing did not publish a draft
  (`test-results/native/1795838568131-39768`). Recovery then passed real
  `SIGKILL` and relaunch, same-byte inode replacement, canceled chooser,
  refused and expired staged Quit, and ordinary Discard and Quit
  (`test-results/native/1795839628444-42796`). Profile-wide removal worked
  after closing a moved root.
- A separate held reviewed-reload test changed disk while draft retirement
  waited. The draft and dirty buffer survived the native conflict
  (`test-results/native/1795840283310-44955`). Independent review approved
  the stage–validate–publish ordering. Rust and Chromium checks cover lease
  separation, immutable payloads, stale revisions, coalescing, and thaw.
- Two real native workbenches shared the same disposable profile. The
  second writer could not be removed while live, and a stale removal was
  refused after its newer revision was published and its app was terminated
  (`test-results/native/1795845610727-64917`, Recovery group). Quit also
  thawed while the other process still held the profile lock. The runner
  captured actual gopls descendants before both crashes and confirmed that
  none remained afterward.

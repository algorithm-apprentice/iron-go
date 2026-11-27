# Daily Go workbench: feature completion plan

Status: Proposed. This document defines the implementation scope and acceptance
criteria. It does not claim that the proposed features are implemented.

## Goal and baseline

Make Iron Go usable for the full daily loop in an existing Go repository:
open or reopen a project, edit while Git and external tools change files,
navigate and refactor Go code, run a configured program or test, and inspect a
debug stop. Keep the lightweight macOS workbench and the native Go toolchain.

Baseline: Iron Go opens `go.mod` and `go.work` projects, saves with conflict
checks, searches saved files, runs/builds/tests packages, and uses `gopls` for
completion, hover, local definitions, and diagnostics. Delve can stop and step
over in a named test. Existing capabilities, including preview limitations,
are described in the [README](../../README.md).

## Delivery order

| Batch | User outcome | Depends on |
| --- | --- | --- |
| 1. File decisions and external changes | I can safely close, reload, or reconcile a file while Git or another editor changes it. | Existing save and project guards |
| 2. Go navigation and refactoring | I can find usages, navigate to dependencies, rename across files, and organize imports. | Batch 1 document version and conflict rules |
| 3. Run configurations and test results | I can repeat a real program invocation and inspect or rerun a failed test. | Existing Go execution lane |
| 4. Debug inspection and executable launch | I can inspect a paused program and step into or out of a call. | Existing Delve lane; Batch 3 for reusable executable configuration |
| 5. Project continuity and file management | I can return to my work, recover unsaved edits, and manage files in the explorer. | Batch 1 file identity and conflict rules |
| 6. Interactive terminal | I can run a shell or use a program that needs a terminal. | A separate native PTY design with explicit ownership and teardown |

Batch 1 is the first implementation target. Batches 2 and 3 need no dependency
on each other. Keyboard and assistive access are acceptance criteria for every
batch; the existing editor and explorer also have explicit accessibility work
below. Signing and notarization are a distribution gate, not a feature batch.

## Shared invariants

- Rust owns local paths, file I/O, watchers and processes. TypeScript owns
  Monaco buffers and visible workbench state. Reuse the existing workspace
  identity, IPC channels, project transition guard, and Go execution lane from
  [ADR 0010](../adr/0010-workbench-workflow-ownership.md).
- A late filesystem, `gopls` or Delve result must still match its workspace,
  document or session, and relevant version when applied. Closing or switching
  a project retires its work; nothing may mutate a later project through an
  old result.
- Preserve [conditional saves](../adr/0009-save-transactions.md) and their
  guarantees. A watcher event, refactor preview, or conflict choice never
  authorizes an unchecked write. An operation that fails after a partial effect
  reports exactly what changed and leaves buffer and disk state reconcilable.
- Opening a repository, restoring preferences, and processing external changes
  may refresh discovery and language services. Running user programs, builds,
  tests, shells, or debuggers requires an explicit action. Optional Go tools
  degrade only the features that need them. Browser preview continues to use
  imported copies and does not gain native file or process capabilities.

## 1. File decisions and external changes

Implementation starts with [external file reconciliation](external-file-reconciliation.md).
The next file workflows are [reviewed disk conflicts](reviewed-disk-conflicts.md)
[save and discard decisions](document-decisions.md), and
[saving a retained buffer to a new path](save-to-new-path.md).

### Behavior

- Replace `window.confirm` in Close Tab and Reload File from Disk with
  workbench dialogs. Dirty Close offers **Save and Close**, **Discard**, and
  **Cancel**. Failed save keeps the tab open. Dirty Reload offers **Reload and
  Discard** and **Cancel**. Escape cancels. Clean close is immediate. The target
  is the originating tab, even when it was not active. Revalidate it after
  confirmation and keep any edit made after the operation's captured version.
- Add **Save All** as a standalone command. Dirty project transitions offer
  **Save and Continue**; ordinary Quit offers **Save and Quit**. Save
  sequentially under the existing transition reservation. Recheck that the
  reservation is valid and all relevant tabs are clean before approving
  cutover. Check the [expiring Quit ticket](../adr/0008-appkit-quit-guard.md)
  before starting each save and let the host make the final approval check.
  On failure, a newer unsaved edit, or expiry, do not switch, exit, or stop
  the running child. Stop issuing queued saves; an already admitted save may
  finish under its normal rules. Keep completed writes, report which files
  were saved, and preserve the remaining dirty buffers. A later Quit needs
  its own ticket. Preserve the existing clean close and Quit paths.
- Rust observes the active root, coalesces notifications and triggers a
  bounded revalidation of the tree and affected open files. Treat notifications
  as hints, including events caused by Iron Go's own saves. Recover from lost
  events or watcher restart with a full recheck of the tree and open files;
  check again on activation and retain manual refresh. If watching is
  unavailable, surface that status and keep manual revalidation available.
- A clean tab reloads only when bytes change and no edit arrived during the
  read. Preserve cursor, scroll and selection where the new file permits. A
  dirty tab keeps its buffer and presents a visible conflict. External delete
  or rename marks the old path missing and preserves an open buffer; do not
  infer that a different path contains the same file. Refresh quick-open and
  run targets when relevant paths or module files change.
- **Compare with Disk** shows the current buffer and the latest readable disk
  version. The user can keep editing, reload, or explicitly save against the
  reviewed disk version. Bind that decision to the originating path, editor
  revision, and native observation of file identity and bytes. Revalidate at
  replacement under the save lock; a new identity, even with identical bytes,
  invalidates the reviewed decision. This narrows the race, but cannot rule
  out a non-cooperating external write after final validation (ADR 0009).
  There is no automatic merge in this batch.
- Distinguish missing paths from unreadable or unsupported files. Neither
  authorizes replacing the path. **Save to a New Path** uses a validated
  workspace-relative path and exclusive creation; a destination collision,
  including an already open destination, keeps the original tab and buffer.
  Rebind the tab and its save baseline only after successful creation and
  write. Never regenerate a deleted file as a side effect of ordinary Save.

### Acceptance

Use the real dialogs in WKWebView, without stubbing `window.confirm`. Verify
Escape, Save/Discard, and an external-write save failure. Use ordinary native
Quit to hold an admitted save past ticket expiry, and fail the second save
after the first succeeds. Verify the project and running child survive both
cases and that completed writes and remaining dirty buffers are reported.
In a disposable Git worktree or repository,
switch between two commits while one clean and one dirty tab are open. Check
the tree, clean reload, dirty comparison, deletion, and preservation of the
unsaved buffer. Change the disk again after opening a comparison and confirm
that the reviewed save is rejected, including a same-content file replacement.
Test a destination collision and a missed watcher notification recovered by
revalidation. Add deterministic tests for in-flight edits, watcher overflow,
self-generated save events, and late events after switching projects.

## 2. Go navigation and refactoring

Implementation starts with [Go symbol navigation](go-symbol-navigation.md).
The next step is [reviewing Go refactors](go-refactor-preview.md), starting
with the single-buffer Organize Imports action.

- Add **Find References** and **Go to Symbol in File**. Use `gopls`, with
  cancellable requests, and group references by file. Selecting a result opens
  the target location; stale results cannot select or edit a replacement model.
  Add **Go to Line** as a local shortcut independent of `gopls`.
- Extend definition navigation to Go toolchain and dependency sources outside
  the workspace. Expose read-only views through a narrowly scoped native
  reader for recognized Go source roots. The runtime verifies canonical roots,
  paths and size limits; do not expand general workspace IPC to arbitrary
  absolute paths or enable writes, tasks, or file commands from those views.
  An unrecognized target should explain why it could not be opened.
- Use LSP `prepareRename`/`rename` and the organize-imports code action. Preview
  changes against the captured models and disk baselines. The first version
  accepts `WorkspaceEdit.changes` and text-only `documentChanges` using
  `TextDocumentEdit`. Reject resource operations, edits outside the workspace,
  and overlapping or stale changes. Open affected files as needed. Validate
  canonical URIs, UTF-16 ranges, and document versions or captured disk
  baselines across the whole set at preview and again at Apply. Any stale
  target invalidates the preview before any buffer is mutated. Preserve
  unrelated unsaved edits, leave changes dirty for review and save, and keep
  per-file undo. Do not promise a transactional multi-file disk save.
- Keep `gofmt` available on its own. Offer **Format on Save** as an opt-in;
  preserve explicit import organization as a distinct action. A format failure
  is visible and must leave the buffer available to edit or save without format.

**Acceptance:** In a real multi-package Go fixture, navigate to a dependency
definition, find references across packages, rename a symbol with an unsaved
unrelated edit and a UTF-16 range after a non-ASCII character, and organize
imports. Verify no disk changes before Save, and reject the whole preview if a
second file changes before Apply or a target lies outside the workspace.
With `gopls` missing, Go to Line, ordinary editing, and `gofmt` still work.

## 3. Run configurations and test results

- Keep automatic package selection and the scope picker. Add named setups
  stored locally per project: target, an ordered argument list (including
  whitespace and empty strings), project-relative working directory, and
  environment overrides. Resolve the package and build context from the selected
  project first; set the launched program's working directory and environment
  independently. Validate again in Rust on launch. Use argv directly;
  there is no shell expansion, arbitrary executable field, or repository-supplied
  launch config in the first version. Allow inherited environment and
  session-only overrides; never print override values in the launch summary.
  Persist non-secret values only; session-only values are intentionally lost
  at restart. Existing save-before-launch and cancellation rules still apply.
- Use `go test -json` for a test result view grouped by package and test,
  including subtests, failures, skips, duration, and captured output. Keep raw
  output available. Each run has its own identity and bounded result data;
  incomplete or cancelled results are identified, not represented as passes.
  Rerun a failed named test or subtest by exact package and test name, escaping
  and anchoring each slash-separated component for `go test -run`. Link
  recognized workspace source locations to the editor; keep unrecognized text
  as output. Program Runs that need stdin are handled by Batch 6.

**Acceptance:** Run a disposable CLI that prints its received arguments and
working directory and checks an override. Restart and reopen the project to
verify saved settings and the absence of session-only values. Exercise a
package build error, a pass, a fail, a skip, a failing subtest, an exact rerun,
and cancellation. Verify the exact rerun does not run similarly named siblings,
source links open the right file, and results from one run cannot appear in the
next.

## 4. Debug inspection and executable launch

- Extend the current named-test session with a call stack, selected frame,
  expandable scopes and local variables, and **Step Into** / **Step Out**.
  Request variables lazily and bound large displays. Every frame and variable
  reference belongs to one pause; clear them on resume, switch or teardown.
  Preserve the selected stack frame when its source cannot be opened, with
  a clear unavailable-source state.
- Add **Debug Go Program** for the selected executable package. Reuse the
  applicable run configuration and the existing save barrier, lane and Rust
  process ownership. Extend [ADR 0007](../adr/0007-delve-test-debugging.md) before
  shipping executable launch; keep Delve local with a private socket and
  disposable binary. No arbitrary attach, remote listener, or evaluation console.

**Acceptance:** Stop in a nested function of a real Go test, inspect a local
value and an expanded struct, switch frames, step in and out, and continue.
Run and debug the same executable in a `go.work` fixture from a working
directory different from its package. Verify both use its configured args,
directory, and environment without changing package resolution.
Stop and switch projects during inspection; stale replies must not update a
new session and the debuggee must exit.

## 5. Project continuity and file management

- Add **Open Recent** on Welcome and in the palette, with Remove from Recent
  and Clear History. Keep the [project-first welcome](../adr/0006-project-first-welcome.md):
  startup never opens a project implicitly. After the user opens a remembered
  root, restore valid tabs, active file, cursor and scroll. Store a bounded,
  versioned app-local record keyed by project identity, never by transient IPC
  ID. Missing or moved roots do not block access to the project picker; missing
  files are skipped with a summary.
- Store bounded, app-local recovery drafts separately from session metadata,
  with restrictive permissions and atomic replacement. Record the expected
  disk baseline and model revision. On a subsequent explicit open, offer
  recovery into unsaved buffers and compare with disk if it changed; recovery
  never writes source files. Key drafts by project, path and writer/session;
  two app instances cannot silently replace or discard each other's drafts.
  Serialize draft commits and retirement, with a revision watermark so an
  already queued snapshot cannot resurrect a saved or discarded version.
  Discover other instances' completed drafts without treating their open
  sessions as owned. Show persistent failures to record drafts;
  recovery is limited to the last completed snapshot and does not guarantee
  recovery from power loss before it was written.
- Add Rename, Move, and Move to Trash for workspace files/folders, plus
  New Folder. Start with same-root moves without overwriting an existing path.
  Validate paths and collisions in Rust, handle case-only rename on macOS, and
  never implement Trash as permanent deletion when the system action fails.
  Serialize native rename, move and Trash against saves under the profile's
  stable lock. Reject operations on app-owned paths, aliases by identity, and
  ancestor moves that would relocate the lock or recovery data. Refuse an
  affected file operation while a document save is in flight; prevent new
  saves to those paths until the operation settles. Fence watcher results
  captured before the mutation and recheck after it settles. A successful move
  rebinds all affected descendant tabs, breakpoints and owned drafts, preserving
  dirty text and view state. Trash with dirty descendants requires an explicit
  decision. Refresh the tree, language-server documents and task discovery.
  Treat package import-path rewriting as a separate refactor, never a hidden
  consequence of a file move.

**Acceptance:** Reopen a known project and restore valid tabs after another file
was deleted. Abruptly end a disposable app after a completed draft snapshot,
then reopen with unchanged and externally changed disk baselines. Verify
discarded/saved text is not resurrected by a late snapshot or another app
instance. Exercise a directory move with a pending save, rename with dirty
descendants, case-only rename, destination collision, successful and failed
Trash, and refusal to relocate the stable lock. Verify explorer, buffer,
breakpoint and draft state, and that nothing writes outside the project root.

## 6. Interactive terminal

Provide a separate **Terminal** pane for an explicitly started local shell
or an interactive Go Run. Prototype the existing terminal-emulator and native
PTY libraries before adding infrastructure. Rust owns each PTY, foreground
job and its teardown. Support keyboard input, resizing, Ctrl-C and a visible
close action. A shell starts in the workspace by default; it is not sandboxed
to that directory and the UI must not imply it is. An IDE-launched interactive
Go Run takes the existing execution lane; a general-purpose shell is separate.
Task Output remains a read-only, bounded transcript. Confirm close or switch
with an active terminal, then close its PTY and retire its owned foreground
job. Verify teardown while its process identity is live; detached descendants
and signalling a recycled process group are outside the guarantee in ADR 0011.

**Acceptance:** Exercise stdin with a real interactive Go fixture, resize its
PTY, send Ctrl-C, and close/switch with an active job. Check no IDE-owned PTY
or child handle remains and no stale output appears in a new terminal.

## Accessibility and distribution

- Remove the forced-off Monaco screen-reader setting after proving the
  supported WKWebView path. Test editor text input and navigation with
  accessibility enabled, visible focus, and keyboard access through the
  explorer, result lists, dialogs and debug controls. Verify dialog focus
  returns to the initiating control or a valid replacement. With VoiceOver,
  verify reading a Go line, moving the caret and editing text, hearing a
  confirmation and its options, and navigating announced search results.
  Record this separately from automated keyboard and accessibility-tree checks.
- Before public binary distribution, complete the [release checklist](#release-checklist).
  Local development builds do not require distribution credentials.

### Release checklist

1. Sign and notarize the production app and distribution artifact using
   authorized credentials, then staple where applicable.
2. Verify the artifact retains third-party notices and contains no acceptance
   driver or fixture.
3. On each supported architecture, download the distributed artifact into
   a clean macOS profile, confirm it is quarantined, and verify it launches
   with Gatekeeper enabled. Record the artifact and macOS version tested.

## Alternatives and scope boundaries

- Use event notifications plus revalidation over a periodic full workspace
  scan or automatic merge: it preserves timely updates without treating a
  watcher event as an authoritative write or making silent edits.
- Use `gopls` and Delve rather than building Go parsers, a refactor engine,
  or a custom debugger. Keep LSP and DAP responsibilities separate as in
  [ADR 0011](../adr/0011-native-tool-transport.md).
- Keep project preferences and drafts local rather than inventing a required
  repository config format. Git integration beyond reacting to external edits,
  full Git UI, extensions, multi-window workspaces, remote debugging and
  additional platforms are outside this plan. Keep current literal saved-file
  search; search indexing, regex, and workspace replace are separate work.

## Implementation and verification gates

For each batch, update the detailed design where implementation choices are
needed and record approved durable decisions in ADRs. Add focused failing
regressions before product code, then run `npm run check` and the relevant
acceptance groups. Changes involving local files, AppKit, WKWebView, or Go
processes require native verification using disposable fixtures. Record
results and unverified cases per batch. Finish with independent review of the
exact diff and evidence before committing or pushing; the integrated release
gate is `npm run test:feedback` plus the applicable distribution checks.

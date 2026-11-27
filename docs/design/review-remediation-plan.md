# Code review remediation plan

Status: Design approved by independent review. Implement in order; each code
batch requires its own review before publication.

Baseline: `33c0ddc` on `main`. The review ran `npm run check`, 7 browser
scenarios and 16 native scenarios successfully. A separate disposable native
probe reproduced quitting a dirty project without confirmation. Six attempts
at racing two saves did not overwrite the second edit; the check-to-replace
gap is a static finding, not a reproduced lost-write incident.

## Review and publication gates

1. Review this plan before writing implementation, including the save guarantee
   and what is deliberately out of scope. Change the draft in response to review;
   do not treat silence or a passing test as approval.
2. Work in the ordered batches below. For each behavior change, first reproduce
   it in a disposable test, including the exact failure or expected invariant.
   If a risk cannot be reproduced timing-wise, use a deterministic fake or
   synchronization point and identify the boundary being tested.
3. Before committing a batch, provide its diff, self-review findings, tests run,
   results, and remaining gaps. Resolve review feedback and rerun affected tests.
   Wait for explicit code-review approval of the exact diff and evidence before
   committing that batch. Before pushing, verify the approved commit and patch
   are the ones being published; any further change requires review again.
   Keep changes local and uncommitted while review is pending. Run `npm run
   check` and the relevant native gates for each affected batch, not just at the
   end. Post-push CI supplements review; it cannot substitute for it.
4. Record accepted durable decisions in ADRs as appropriate, and record actual
   verification in the design. Keep the existing macOS/Tauri/Monaco stack,
   native project ownership, Go tool integrations, and UI conventions.

## Scope and order

| Batch | Issue from review | Required result |
| --- | --- | --- |
| 1. Exit protection | Native macOS Quit bypasses the window-close confirmation | Dirty work is not lost through ordinary Quit or window close |
| 2. File concurrency | Save revalidation and replacement are separate; late file results are hard to reason about | Serialize Iron Go saves and narrow external conflicts; stale results cannot change the active document |
| 3. Workbench responsibilities | Lifecycle and save-before-launch logic are scattered across `main.ts` | One workflow owner per concern; the entry point wires services and UI |
| 4. Native tool transport | DAP and LSP duplicate channel, process and cleanup ownership | Share process transport without conflating the protocols |
| 5. Test isolation and failure coverage | Native cases share mutable state, abort on first failure, and do not consistently assert runtime errors | Independent suites, deterministic negative cases, and usable diagnostics |
| 6. Final acceptance and review | Local, native, real-project, and release evidence are separate | Report exactly what passed, what was skipped, and which platform gaps remain |

No framework migration, full debugger redesign, new feature surface, or
unrelated UI redesign. The separate known mixed-DPI picker sharpness issue
is not fixed by this review plan; run the existing diagnostic where possible
and do not report the prototype workaround as shipped.

## 1. Protect ordinary application exit

**Finding:** [the frontend](../../src/main.ts#L844) only intercepts the
window's close request; [the native run handler](../../src-tauri/src/main.rs#L166)
cleans up after exit. In the review's cleanly isolated E2E process, native
macOS Quit exited with a dirty model and never consulted confirmation.

**Interception point:** With the pinned runtime, the default macOS Quit
menu calls AppKit `terminate:`; Tao's `applicationWillTerminate:` maps to
`RunEvent::Exit`, not the preventable `ExitRequested`. Last-window close
can emit `ExitRequested` after the window is already destroyed. Neither is
an acceptable entry point for the dirty check.

**Proposed design:** Add the public AppKit `applicationShouldTerminate:`
delegate hook to the existing Tao delegate on the main thread. Keep that
delegate and its other methods intact; do not swizzle or replace an existing
implementation of this selector. Verify the hook is installed against the
pinned runtime; do not ship a silent fallback if a future runtime changes
the delegate contract. A user window `CloseRequested` is prevented before
destruction and requests AppKit `terminate:` on the main thread, so it enters
the same guard as the app menu/⌘Q and normal system/Dock Quit. `RunEvent::Exit`
continues to clean up only after approval. No unrelated programmatic exit
path should bypass the guard by destroying an editable window.
Enqueue `terminate:` outside Tao's current dispatcher
callback, not just on the main thread. Remove production `allow-destroy`;
the acceptance app may still force teardown for its disposable fixture.
Code review found that Wry does not implement its JavaScript confirm panel;
mocking `window.confirm` exercised a choice the user could not actually make.
For a protected session, synchronously cancel the first AppKit request and
send one tokenized request to the renderer. Use an app-owned HTML dialog to
show Cancel/Discard in the normal interactive run loop, not an AppKit modal
run loop waiting for `NSTerminateLater`. This intentionally revises the initial
deferred-reply design in response to that blocker. Do not change unrelated
`window.confirm` call sites in this batch.

An approved, matching reply consumes the pending ticket and retries native
`terminate:` with a one-shot permit. Arm and consume it on the main thread
around that invocation only; clear it if the invocation returns without
exiting. Never use a prompt result as permission for a later unrelated Quit.
Ignore stale/duplicate replies and coalesce repeated requests while a decision
is pending. Expiration closes the matching dialog, refuses the old ticket and
restores editing so a user can retry. Cancel failed delivery; a missing reply
expires without termination. This route uses the main queue outside Tao's
current dispatcher, without running a nested AppKit termination loop.

Freeze user edits and new mutating actions until the dialog and approval
resolve, and decline if any file mutation (including save, reload or format)
is in flight. Unlock on cancellation, expiration, or rejection by the host.
The affirmative reply must be the one for that request's protected buffer state.

A dirty decision must be visible even when the main window is minimized or
the app is hidden. After the renderer freezes and opens the dialog, ask the
host to present the main window for that ticket. On the main queue, verify the
ticket is still pending, unhide and restore the window as needed, and bring it
forward. If presentation fails, close the dialog and decline that request.
Clean or busy Quit never invokes this presentation path. Do not let a late
presentation request for an expired ticket raise the window.

**Invariants:** Cancel, a save still in progress, or an unanswered renderer
must not be treated as approval. A clean window can exit without a dirty-file
prompt. Approved exit stops processes; Cancel leaves tabs and processes intact.
Force Quit, SIGKILL, and abrupt OS shutdown are not recoverable via this guard.

**Tests:** Re-run the actual system Quit Apple event on a disposable dirty
project (the same application termination route used by Dock Quit). Also
exercise the default native menu item's AppKit action and `NSWindow.performClose:`.
Drive the actual visible Cancel and Discard controls instead of replacing
`window.confirm`. Prove Cancel keeps both the buffer and an active child;
retry and approve Discard, checking the unsaved bytes were not written and
the child actually stopped. Verify clean Quit, duplicate requests, and an
in-flight save, with a test-only barrier inside real `save_file` IPC. Attempt
normal editor input while the decision is displayed and ensure the buffer
does not change. Check actual expiration dismisses the dialog. Use focused
tests for stale approvals. Minimize the main window through AppKit before
system Quit, verify AppKit reports it restored and visible while the dirty
dialog is open, and then Cancel. Do not use a synthetic `AppHandle::exit`
or the test bridge's force-destroy shortcut as the native quit oracle.

**Batch 1 evidence:** The initial native regression failed with `Native Quit
exited before confirming the unsaved buffer`. The first fix passed with a
mocked confirmation, but independent code review found that it did not give
the user a real choice. With the revised flow, the native Quit probe
(`test-results/native/1795738554415-9387`) passed using the real dialog and
the system Quit, AppKit menu and `performClose:` routes. It observed a save
held inside the native IPC, checked that Monaco refused input during the
dialog, and verified Cancel and expiry preserve the buffer and child process.
Discard exited normally, stopped the child, and did not write the buffer.
The release `.app` built, and a scan found no acceptance quit/save markers
in its binary or the production frontend assets. It also exited cleanly on
system Quit when launched with a disposable home. `npm run test:feedback`
passed (10 TS, 10 Rust, Go fixture, 7 browser, 17 standard native cases with
gopls and Delve, and the standalone dirty Quit probe). Full-run artifacts:
`test-results/native/1795738688726-10424` and
`test-results/native/1795738728150-11786`.

A follow-up review identified the minimized-window gap. The added AppKit
regression failed before the presentation command (`1795738809624-12161`,
window state still minimized and invisible), then passed after presentation
was added (`1795738854283-12791`). The final test also requires the restored
dialog's Discard control to be enabled before testing Cancel.
The final `npm run test:feedback` rerun passed, including the 17 native
cases (`1795738900935-13780`) and the strengthened dirty Quit probe
(`1795738953379-15129`). Strict Clippy with `e2e` also passed. Independent
code review approved the batch; the separate hidden-application branch was
reviewed in code but not separately exercised by native automation.

## 2. Define and harden save/reload transactions

**Finding:** [`persist_text`](../../src-tauri/src/workspace.rs#L101) checks
the baseline before staging and replacing. The test today checks edits that
are already on disk before a save; it does not place an edit between the
comparison and commit. The frontend also needs controlled ordering tests
for reload/format/save results that come back after later edits or tab changes.

**Proposed design:** Stage locally without changing the destination. Use one
OS-backed advisory lock per app profile, on a stable file in the user's
app-local data directory. All cooperating Iron Go processes using that profile
take the same lock; do not unlink/replace its file on release. Fail the save
if the lock cannot be acquired; never stage or write unlocked. Under the lock,
stage, then recheck path, bytes and target identity immediately before the
same-directory atomic replacement. Compare the editor's expected bytes from
its last read or save; compare destination file identity captured for this
transaction before staging, not at tab open.

Under a small frontend operation guard, validate workspace/model identity and
buffer version before applying asynchronous results. A successful save updates
that tab's disk baseline to the committed text, even if later edits leave the
buffer dirty. A stale reload cannot reset the document or that baseline after
a save changes it. A refused save leaves the buffer dirty and reports the
conflict.

**Guarantee for review:** Concurrent Iron Go saves of the same baseline
within a profile cannot both commit different content. Differences from the
staged identity or expected bytes observable at final validation are rejected.
Arbitrary external editors
do not acquire the cooperative lock: a write after the final check still cannot
be ruled out by a portable compare-and-rename. This batch narrows that window
and documents the limit; it does not promise a filesystem compare-and-swap.
A macOS exchange/recovery scheme would be a separate design if preserving an
arbitrary last-moment external write is required. Do not silently restore a
backup over potentially newer bytes written by another process.

**Tests:** Use barriers or an internal test seam, not repeated sleeps. Start
two distinct saves from one baseline in **two processes** using the production
lock path in one disposable profile. Assert exactly one commits, the other
reports conflict, and disk contains the winner's bytes. Test lock acquisition
failure, an external edit after staging but before final validation, and
staging/replace failure. With controlled save/reload interleaving, verify
the committed baseline advances even when later edits remain dirty, and a
late reload cannot undo it. Also test late format and closing/reopening a
tab or workspace before an operation resolves. Re-run native conflict smoke.
Hold one writer after its final check and prove the other cannot enter its
commit section before release; a simultaneous start alone can pass without
working serialization.

**Batch 2 implementation design (independently approved):** Resolve the application
local-data directory with Tauri on the native side; no path comes through
renderer IPC. Open one stable lockfile under it with private mode on creation,
no symlink following, nonblocking I/O, and no truncation. Require a regular
file from the opened handle. Use Rust's OS-backed `File` locking on the
blocking worker. The lockfile is never renamed or removed when unlocked.
Fail closed for a profile-directory or lock open/acquire error. A workspace
can enclose the app-local data directory. At the native save boundary,
compare the staged and final candidate's device/inode with the opened lock
file's identity and reject a match. This protects the reserved lock from
Iron Go's own saves even through case aliases or hard links, without relying
on path spelling or tree filtering. External removal or replacement of the
profile's lock file is outside the cooperative guarantee.

Capture the destination device/inode and permissions from a regular-file
handle before staging. Keep the existing same-directory `NamedTempFile`.
Code review found that an ordinary Iron Go save could target another
writer's staged pathname while it waits for the profile lock. Reserve a
private staging basename prefix with no case-folded characters. Reject
paths containing such a component at the native workspace boundary and
omit them from scans, rather than relying on UI filtering. String spelling
alone is not a filesystem identity check (e.g. HFS+ ignores some Unicode
characters), so acquire the profile lock before creating the staging file.
This adds a bounded 2 MiB staging write to the critical section but removes
the window in which another cooperating process can commit to the new
staged pathname. A regression must attempt a second cooperating save to the
reserved name from the first save's `Staged` seam and check refusal before
lock acquisition and the correct outer bytes. Under the lock, also verify
the staging pathname's identity against the open temporary file before
replacement. On all errors, remove the staging pathname only if it still
names the owned file. Test a pathname replacement at the staging seam:
neither commit the wrong file nor remove the replacement. This does not
protect against arbitrary external writers changing a temporary file in
place or racing after the staging identity/cleanup check.
For both destination opens (staging and final validation), do not follow a
final symlink, open nonblocking, and verify a regular file from the handle
before reads. This prevents a swapped FIFO from waiting for a peer while
the profile is locked. Under the lock, re-resolve the workspace path and
compare the final handle's identity and bounded bytes with the staged identity
and editor baseline. Recheck the path identity
before replacing it. The lock remains held through replacement and best-effort
cleanup of the owned staging file; a failure does not advance the editor
baseline. This is not a durability guarantee across power loss and does not
extend the existing workspace path model to race-proof directory traversal.
The guarantee is about staged identity and observable bytes, not complete
disk history: replacement before staging with the same bytes and changes
undone before observation cannot be detected.

Use a private worker mode in the Rust test binary, not a shipped command. In
the two-process test, A stops after validation under the real lock. B starts
from the same baseline and reports the production lock attempt's actual OS
`WouldBlock` result before blocking. Allow A to commit only after observing
that result. Assert no B commit entry while A holds the lock, then require
A success, B conflict, winner bytes, and staging cleanup. A bounded parent
owns both workers and releases or reaps them on failure. In-process seams
cover an external edit, same-byte inode replacement, lock and stage/replace
failure. A bounded subprocess test swaps the destination for a FIFO between
staging and validation, requires refusal, then proves a later save can acquire
the lock. A disposable enclosing workspace attempts to save over the lockfile
and verifies the identity and bytes remain unchanged; exercise a case alias
where the test filesystem resolves one. Synchronization seams are absent from
normal builds.

At the document boundary, capture the project and exact live tab, not just a
relative path. Reload captures buffer version and a monotonic per-tab reload
revision; a newer reload or save start invalidates an older reload, and reload
does not start while saving. An accepted reload updates text and baseline
together. A fulfilled save advances the captured live tab's baseline even if
the buffer version changed while the write was pending; recompute dirty from
current text. Format can only update its captured live tab at the captured
model version; opening another tab does not retarget any in-flight result.
Close/reopen or workspace reset invalidates that tab even at the same path.
Apply the same applicability checks to fulfilled and rejected results: a
superseded reload/format or disposed tab cannot report a status or error.
Current results may update their captured, live tab, but operation feedback
belongs only to the active tab in the current project. A current save error
still reports its conflict and keeps the editor dirty; subsequent edits do
not make a committed save's baseline update stale. Check delayed rejection
after a tab or project is replaced and after save supersedes reload. Exercise
the real document methods with controllable adapter promises and Monaco in
browser tests; keep the existing native external-conflict acceptance as an
end-to-end check of the actual IPC and disk boundary.

**Batch 2 regression evidence:** Before changing behavior, the Chromium/Monaco
test observed an older reload replacing both the committed buffer and disk
baseline. A Rust staging seam separately reproduced overwriting an external
edit placed after staging. Both focused regressions pass with the respective
guards. The Rust worker regression waits for an actual OS `WouldBlock` while
the first writer is paused after validation; resuming it yields one commit and
one conflict. The subprocess-only worker entry is invoked by its parent tests;
the top-level test runner intentionally does not run that entry standalone.
`npm run test:feedback` passed (10 TS, 17 Rust tests, Go fixture, 11 browser
scenarios, 17 native cases with gopls and Delve, and the standalone Quit
probe). The native file cases verify that the lock inode is created in the
disposable profile and retained after a refused write. Native artifacts:
`1795739366294-16386` and `1795739408886-17770`. Strict Clippy with `e2e`
also passed for that revision. Review then found the staging pathname gap.
Two added Rust regressions failed before the fix: the cooperating nested
save caused the successful outer save to commit `wrong bytes`, and a swapped
staging pathname could be committed. Both now pass, including the case where
a destination conflict takes the cleanup path and must preserve the replaced
staging file.
Final full feedback passed (10 TS, 19 Rust tests, Go fixture, 11 browser
scenarios, 17 native cases with gopls and Delve, and the separate Quit probe).
Final native artifacts: `1795739659941-18897` and `1795739956770-20575`.
Strict Clippy with `e2e` and the release `.app` build passed; test-only save
worker and document fixture markers were absent from the shipped artifacts.
Independent code re-review approved this batch.

## 3. Simplify the workbench with behavior pinned

Extract the project transition workflow and the shared save-before-launch
step from [`src/main.ts`](../../src/main.ts), using the tests from batches 1–2.
Rust still owns workspace IDs and subprocess admission; TypeScript still
owns models, dirty state, and user decisions. Do not split out unrelated
settings or theme code merely to reduce a line count.

- One project/exit coordinator for consistent busy/cancel/commit decisions.
  A cancelled folder picker keeps the old project and processes; a committed
  switch invalidates old results before it enables the new project's controls.
  A valid late file result may still update its own still-open background tab,
  but must not switch views or replace status belonging to the active editor;
  stale workspace/model results cannot update either.
- One exclusive Go task/debug lifecycle interface. Remove overlapping flags
  where a small explicit state suffices. Keep document save/format state
  separate where intentionally concurrent. Reuse save-before-launch for both
  normal Go tasks and named debug tests.
- Move the acceptance hooks into a test-only module and verify they remain
  absent from a production bundle. The entry point should wire the hooks and
  services without owning their internals.

**Tests:** Use a fake host with controllable promise resolution to test
cancel/success/error paths and delayed events from an old workspace. Test
run/debug start after save, rejection after save failure, and cancel/switch
during execution. Keep native smoke coverage for actual IPC and UI wiring.
Success is fewer independently writable flags/duplicated decisions, not a
target file size.

**Batch 3 implementation design (independently approved):** Split by ownership, not
by UI widget. A small project workflow coordinates open/import/create/close
and the app Quit decision. Keep native workspace identity in Rust and one
renderer project reference in the workbench. Use a single exclusive
reservation for a transition or exit decision; no raw writable `busy` shared
between unrelated callbacks. A transition reserves before any confirmation
or asynchronous picker, freezes document edits and prevents new mutations
while the user is deciding, and releases on cancel or error. Do not start a
transition during active save, reload, format, create-file, or Go launch
preparation. Keep ordinary Go execution and Debug eligible for switching
after confirmation. Preserve the previously approved native Quit ticket,
timeout, presentation and retry path; only replace its renderer reservation.

Use app-owned Cancel/Continue controls for **project transition** confirmation
because the pinned native WebView does not expose `window.confirm`. Preserve
the existing dirty/stop warnings and do not redesign tab-close or reload
confirmation here. From New Project, show the confirmation above the form
while submission is pending; Cancel returns to the same filled form. Test
both buttons in native acceptance, including this overlapping-dialog case.
Browser import starts its picker synchronously (user
activation) and reserves/confirms on a returned selection, not on cancel.
Native open/create returns no candidate on picker cancel: do not touch the
current project, running readers or children before a result. For close,
call the native close command as the commit boundary; no preemptive Debug
stop on a close command failure. On a committed change invalidate outgoing
operation identity before new controls become enabled. Set the new renderer
project and detach old callbacks before asynchronous tree/model setup; if
setup fails after native commit, keep the new project and show its error,
not an unsafe rollback. Old callbacks may render only while both their
project and their specific operation are current.
Apply the project identity check to both snapshot results and errors at the
point they publish. A rejected snapshot from the outgoing project must not
replace feedback in the new project; a rejection for the current project
still surfaces. Test both outcomes with held adapter promises.

Give Go task/debug an independent typed lifecycle with at most one token:
idle, preparing/starting, running (task or Debug session), and task stopping.
Make start/stop/finish effects conditional on the captured token, not just
the workspace. A terminal event wins over a later rejection from the same
request; an old event from the same project cannot reset a new launch.
Native task Stop targets the workspace's slot rather than a task ID. If the
terminal event arrives with a Stop IPC outstanding, retain the token and
withhold new launches until that IPC execution has settled. A committed
workspace change gets a new native ID, so a pre-cutover Stop cannot affect
its slot. Test delayed *execution*, not only a late rejection. For Debug,
do not expose Stop before native admission returns the server ID. If an
early terminal event happens before the admission returns, keep the old
token until admission and cleanup of the eventual server ID both settle;
exactly one owner retires that server.
Before either Run/Build/Test or Debug dispatch, use the same save barrier:
admit only with no save/reload/format/create already in flight; prevent new
competing file mutations while preparing, except this launch's saves and
ordinary typing. Capture a monotonic document edit revision before any save
and recheck it, the token, and dirty state just before dispatch. Any edit
after capture vetoes dispatch even if undo makes the buffer clean again.
Verify this for both Run and Debug with a controlled pending save and an
edit followed by undo; do not disable typing to pass. Native project ID and
Rust's existing admission checks remain authoritative for subprocesses.

Existing DebugSession owns DAP pause/resume and process-specific control;
do not model those states twice. Synchronously retire outgoing Debug
renderer effects on committed cutover before resetting documents and
breakpoints, not on cancel or failed native operations. A delayed pause read
checks the captured session and pause at the point Documents would create,
activate or focus a tab, and again before drawing its annotation. If the
lookup shares a pending read with ordinary navigation, each caller validates
its own intent before applying it. A conditional Debug open observes the
ordinary navigation generation but does not advance it. Only a newer
ordinary navigation may supersede an earlier ordinary intent, even when an
ordinary caller starts the shared read before an expired Debug pause joins
it. Test both orders. Breakpoint verification also checks
session identity at the point it writes to the shared store. Test late pause
navigation after a same-project relaunch and a breakpoint response across
a committed switch. No DAP protocol changes in this batch.

Keep package selection, toolbar rendering, editor annotations and feedback
formatting in the workbench or their current modules. Move the existing
`__ironTest` bridge into a conditional test-only module and verify it is
not bundled in release. Use fake host promises for cancelled/failed and
committed transitions, competing requests, save barrier rejection and later
edits, run/debug exclusivity, and late finish/stop errors from old tokens.
Native acceptance uses the real project confirmation buttons; retain Quit
tests and Go/Delve smoke, and verify a cancel cannot stop an existing child.

**Batch 3 red evidence:** The existing native app timed out on the dirty
Close Project path when the suite stopped replacing `window.confirm`
(`test-results/native/1795740152327-21046`). The native runner now requires
actual workbench controls instead of treating an injected answer as proof.
The nested New Project case also checks focus and pointer hit-testing so
programmatic clicks do not mask an inaccessible top dialog.
Code review's ordinary-first shared-read case reproduced a stale Debug pause
leaving the old tab active (`initial.go` instead of `next.go`). The regression
passes after separating ordinary activation from conditional Debug lookups.
A controlled snapshot test passes for outgoing failures/results and for
publishing current-project failures and results.

**Batch 3 final verification:** `npm run test:feedback` passed (15 TS,
19 Rust, Go fixture, 16 browser, 17 standard native with gopls and Delve,
and the standalone dirty Quit probe). Native artifacts: `1795741693097-25635`
and `1795741745211-27284`. Native Open and Close Cancel preserved the running
Go child; approved Close stopped it. New Project Cancel restored the filled
form, and Continue created and ran the disposable module. The real picker
cancel return is covered by a fake pending host result, not console automation.
The release `.app` built without the acceptance chunk, hooks or test fixtures.
Independent review approved the final code diff.

## 4. Share native process plumbing, not protocols

Extract only the duplicated framed-JSON I/O, cancellation, child wait, and
ownership cleanup in [`lsp.rs`](../../src-tauri/src/lsp.rs#L119) and
[`debug.rs`](../../src-tauri/src/debug.rs#L82). Keep gopls stdio and Delve's
private Unix socket as separate adapters. LSP initialization and DAP
request/event meanings stay independent. Do not generalize normal Go task
output or package discovery into this transport.

**Invariants:** Preserve message bounds, session IDs, and independent lifetimes.
Final protocol messages and EOF are handled deliberately; old workers cannot
clear new ones. Stop, early child exit, and connection failure have one cleanup
path and no duplicate terminal state. Explicit Stop, switch and quit signal
live groups; the natural-leader-exit exception is detailed below. Delve
retains its private socket and explicit process ownership.

**Tests:** Focused bounded framing and fake transport/child teardown tests
cover partial frames, EOF, oversized data, cancellation before connect,
unexpected disconnect, and stale worker cleanup. Native gopls and Delve tests
must still prove real hover/diagnostics and stop/step/continue/stop behavior,
including project switch during debugging.

**Batch 4 implementation design (independently approved):** Introduce a Rust
`tool_transport` module with one bounded outbound queue, framed reader/writer,
cancellation token and child/group owner for each server instance. Keep the
public commands, `ServerEvent` shape, workspace admission rules and current
message limits. A narrow kind selects the native slot and existing error
wording; no LSP or DAP payload policy moves into the transport. `gopls` gives
the worker already-open stdio. Delve gives it an asynchronous connection to
the existing private Unix listener with its eight-second timeout; the worker
creates the directory with owner-only permissions atomically (before bind),
closes the listener once accept resolves, and retains the directory through
child teardown. Directory deletion on app exit remains best effort if the
runtime cannot poll cleanup. Stop before connect, child exit before connect
and accept failure all feed the same cleanup path.

Keep synchronous process-group kill on handle drop so switch and native app
exit do not depend on async tasks getting another poll. The common worker
owns the child and eventually reaps it; remove the session slot only if its
ID still matches and send one terminal event on the original channel after
cleanup. Old server events must not retire or notify a newer handle. Use a
transport-specific group owner: both a synchronous signal (including the
syscall, not just claiming the identifier) and each poll of the sole Tokio
child wait hold the same short mutex. On successful wait, disarm within that
poll before releasing the mutex; never disarm on a wait error. Do not hold a
session lock while polling child wait, and release the group mutex before
retiring the native session slot. Stop/switch/quit and abnormal I/O signal
the live group before reaping. If the leader exits naturally first, we do
not signal a numeric group after reaping: descendants may survive that case
even if they stayed in the group. Inherited descriptors do not extend the
drain budget. Go task and package discovery keep their existing behavior.
On worker drop, signal/disarm before dropping the Tokio child, because its
destructor may itself reap or transfer reaping.

Distinguish a clean frame-boundary EOF from a partial header/body and reject
duplicate `Content-Length` or values above the cap. Retain byte lengths and
the 8 KiB header and 16 MiB body bounds. An explicit stop need not deliver
buffered messages. Observed child exit or writer closure starts a bounded
read drain with a single absolute deadline (300 ms); the later event must
not reset it. Keep the frame future pinned across these events, so the drain
continues a partially parsed frame instead of starting another read. Check
cancellation and the deadline between delivered frames and yield so a
continuously ready reader cannot starve them. Recheck both immediately before
delivery: a single frame poll can do synchronous JSON parsing after select
last checked cancellation. Clean read EOF while the child
is still live ends the session and kills/reaps the group after already-read
frames. Invalid input or IPC delivery failure ends delivery immediately.
An explicit stop takes priority in all phases and can discard unread frames.
Do not retry launches.

First reproduce a truncated header being treated as clean EOF in a Rust
test. Add deterministic in-memory framing/EOF/oversize and duplex drain
tests, including a partial frame across exit, concurrent write closure and
cancel during drain. Add disposable child tests for cancellation before
connection, early exit, disconnect, and one cleanup notification. Verify the
private socket directory mode and that an older worker cannot clear a newer
slot or send a notification to its channel. In native acceptance
retain the real gopls/Delve cases and add Stop and workspace switch while
paused; verify the debug state is cleared and a fresh launch is admitted.

**Batch 4 focused verification:** The baseline truncation test failed because
an incomplete header returned `None`. The shared transport's 10 focused Rust
tests pass, including the moved Unicode regression, partial header/body and
bounded framing cases, in-flight frame preservation across child exit or a
broken writer, cancellation between ready frames, a bounded dangling-reader
drain, and test child reaping with ID/channel isolation.
`npm run test:feedback` passed (15 TS, 29 Rust, Go fixture, 16 browser,
18 standard native with gopls and Delve, and the standalone Quit probe).
Native artifacts: `1795742134403-28075`, `1795742186410-29572`. The native
Delve case observed the app's own child PID, verified its removal after
Stop and workspace cutover while paused, then admitted and stopped a fresh
session in the replacement workspace. A Rust check verified that the socket
directory mode grants no permissions to other users or groups. Review found
that cancellation arriving inside a frame read could still deliver it. The
new regression reproduced one delivered frame; checking cancellation and
the deadline again after the frame poll reduced the count to zero.

**Batch 4 final verification:** `npm run test:feedback` passed with 30 Rust
tests (11 focused transport), 15 TS, the Go fixture, 16 browser, 18 native
with gopls and Delve, and the standalone Quit probe. Final native artifacts:
`1795742341148-30605` and `1795742386125-32080`. Strict Clippy with `e2e`
passed on the revised code, and independent code re-review approved it.

## 5. Improve test independence and diagnostics

Keep one E2E build but split the long [native runner](../../tests/native/workbench.mjs#L178)
into support code and selectable workflow groups: lifecycle, files/editor,
Go/language services, and debugging. Give destructive or stateful groups
fresh workspace copies or fresh sessions, so one failure does not hide
unrelated outcomes. One group can still stop at the first failure if later
cases depend on its state. Keep stable fixtures, startup predicates, cleanup,
and the existing opt-in external Raft probe.

- Promote cheap deterministic cases over more long end-to-end scenarios:
  save/reload ordering, current/custom Go scope, delayed DAP responses, and
  stale sessions belong at the lowest meaningful layer.
- Native successes must assert no unexpected `error`/`unhandledrejection`, not
  just collect JS errors when another check fails. Preserve per-group reports,
  screenshots, and Go/DAP output on failure.
- Keep the existing Go 1.25.x CI lane. Add a compact Go 1.27.x smoke using
  compatible gopls/Delve weekly and on manual request, not on every PR. Do not
  require the user's checkout for CI. Missing tools, locked-console picker
  cases, and separately gated profiles must be distinguished from passes.

**Acceptance for the runner:** Select one group without rebuilding; force one
controlled failing group and verify subsequent independent groups still report,
overall status is nonzero, and the disposable process/files are reaped. Verify
that the native test can catch an unexpected JS error independently of a UI
timeout.

## 6. Final gate

Run the updated `npm run check`, browser UI, and required native gopls/Delve
suite according to the [macOS acceptance plan](macos-acceptance-plan.md).
Run the Raft smoke only on a disposable snapshot. Build production `.app`
and `.dmg`, check tool/automation boundaries and verify the mounted package.
Run real picker/Retina probes on an unlocked console where available; record
any remaining OS-dependent result as unverified, not green by assumption.

Deliver a finding-by-finding report with regression evidence, status, and
remaining limits. The final review approves the actual diff and results, not
merely the fact that the plan was followed. No commit or push before the
applicable review gate.

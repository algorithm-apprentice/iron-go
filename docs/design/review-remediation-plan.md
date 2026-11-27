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
short OS-backed advisory lock per app profile, on a stable file in the user's
app-local data directory. All cooperating Iron Go processes using that profile
take the same lock; do not unlink/replace its file on release. Fail the save
if the lock cannot be acquired; never write unlocked. Under the lock, recheck
path, bytes and target identity immediately before the same-directory atomic
replacement. Compare the editor's expected bytes from its last read or save;
compare destination file identity captured at staging time, not at tab open.

Under a small frontend operation guard, validate workspace/model identity and
buffer version before applying asynchronous results. A successful save updates
that tab's disk baseline to the committed text, even if later edits leave the
buffer dirty. A stale reload cannot reset the document or that baseline after
a save changes it. A refused save leaves the buffer dirty and reports the
conflict.

**Guarantee for review:** Concurrent Iron Go saves of the same baseline
within a profile cannot both commit different content. Edits from another
program before the final validation are rejected. Arbitrary external editors
do not acquire the cooperative lock: a write after the final check still cannot
be ruled out by a portable compare-and-rename. This batch narrows that window
and documents the limit; it does not promise a filesystem compare-and-swap.
A macOS exchange/recovery scheme would be a separate design if preserving an
arbitrary last-moment external write is required. Do not silently restore a
backup over potentially newer bytes written by another process.

**Tests:** Use barriers or an internal test seam, not repeated sleeps. Stage
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
path; no duplicate terminal state or orphan process. Delve retains its private
socket and explicit process ownership.

**Tests:** Focused bounded framing and fake transport/child teardown tests
cover partial frames, EOF, oversized data, cancellation before connect,
unexpected disconnect, and stale worker cleanup. Native gopls and Delve tests
must still prove real hover/diagnostics and stop/step/continue/stop behavior,
including project switch during debugging.

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

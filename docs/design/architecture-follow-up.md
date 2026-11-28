# Architecture review follow-up

Status: Implemented and independently reviewed. Baseline: `f4f1ec5`.

This plan addresses the repository-wide review without changing the macOS,
Tauri, Rust, TypeScript, or Monaco architecture. A refactor earns its keep
when a rule has fewer owners, a race has a deterministic regression case, or
an operation reports what actually happened. Line count alone is not a goal.

## Scope and rollout

| Batch | Finding | Deliverable |
| --- | --- | --- |
| 1 | Same-session breakpoint replies can paint an older result. | Check the latest breakpoint request for each file before updating markers. |
| 2 | Terminal cleanup can wait indefinitely on a failed or unrepeatable observation. | Report a bounded, retryable or unconfirmed cleanup outcome, while retaining ownership until cleanup is proven. |
| 3 | Workspace mutations and Go rerun source scans hold the shared native lock over slow I/O. | Give file mutations a workspace-bound reservation; verify rerun inputs without holding `Core`. |
| 4 | New Project can write files and return an error that omits that fact. | Return explicit creation and opening outcomes; preserve starter files on partial failure. |
| 5 | Run, executable Debug, and Terminal Run repeat build and handoff rules. | Share the configured launch preparation and working-directory verification; keep runtime teardown separate. |
| 6 | Command eligibility, file operations, editor-session persistence, and UI rendering have mixed owners. | Unify the file command rules, extract editor-session lifecycle, and separate file activity from rendering. |
| 7 | The native worker mixes scenarios and its completeness checks only pin Go. | Validate critical Quit, Recovery, and Terminal cases by phase, then extract native scenarios from the worker. |

Run the batches in order. Within batches 3, 6, and 7, review independently
landable slices rather than one combined refactor. Batches 3 and 4 share the
cutover admission boundary; batch 5 builds on batch 3's lock rules. Each batch
has a focused red/green check or, for a structural move, a characterization
check run before and after the move. No batch adds a production test hook.

## 1. Debug breakpoint replies

[`DebugSession.setBreakpoints`](../../src/debugger.ts#L223) currently checks the
debug session after the reply, but not whether a newer request for that file
already replaced it. A disposable Chromium reproduction with injected DAP
replies painted `[5, 9]`, then cleared verification when an older reply
arrived. This proves renderer behavior under reordering, not that Delve emits
out-of-order replies in normal operation.

- Record the latest request identity per workspace-relative file within the
  session. Apply success or surface a request error only for the current
  session and latest request for that file. Keep transport sequence numbers
  and pending promise cleanup separate from marker freshness.
- Clearing all breakpoints is an update. A previous reply must not verify
  markers after a clear or override markers from a newer request. Updates to
  one file do not invalidate another file's response. Preserve startup
  breakpoint configuration and the existing stale-project guard.
- **Acceptance:** the existing Chromium document fixture sends two requests
  for one file and replies newest-first; the old success or failure cannot
  change the current marks or report a stale error. Cover a clear request and
  an independent request for a second file. Keep the existing project-change
  and native Debug coverage.

## 2. Terminal retirement and proof

The tail of [`terminal::run`](../../src-tauri/src/terminal.rs#L792) stores a
single reap result and drops the master before waiting for proof. An error
from `wait` or a missing final foreground observation can leave no operation
that changes the result. A repeated Close only subscribes to the same
completion. This is a static finding; inject failures to test it before
assuming a particular macOS error is reproducible with a real shell.

- Model live, retiring, and unconfirmed cleanup explicitly. A **retired**
  result requires leader reaping and the existing native foreground proof.
  Send the existing `Closed` event and free the matching native and renderer
  slots only at retirement, once per terminal ID. Unknown is never equivalent
  to closed. A shell holds the terminal slot; a terminal Go program also holds
  the Go lane through cleanup.
- Each command's cleanup wait is bounded. Keep the owned master and child handle
  while they are still needed to retry eligible observations or reap. Retry
  only observations that can still produce evidence: transient wait errors
  for an owned child, an unreadable foreground with the master still owned,
  or exit confirmation for already observed stamped processes. If no valid
  evidence source remains, retain the unresolved ownership record and report
  that further in-app retries cannot prove cleanup. Continue automatic
  observation at a bounded sampling rate while a known foreground survivor
  can still disappear; this preserves automatic retirement after a Close
  timeout. Park an unresolved owner when no observation can change the
  result. Refresh the owned PTY's foreground evidence before each kill
  attempt, including a retry after a transient reap error. Do not keep a
  timer alive for an unchangeable predicate or invent proof from a timeout.
- Report retiring or unconfirmed status to the renderer without calling the
  existing `closed` callback; disable terminal input when it is no longer
  live. Explicit Close/Stop retries under the same ID when proof can improve;
  concurrent requests share the active attempt. Natural exit can enter the
  same retirement path. Stop/Close returns success only on proof; an exhausted
  wait or unconfirmed attempt rejects the IPC with the cleanup reason so the
  renderer clears its in-flight Close flag and restores the Go lane's Stop
  retry. Distinguish an occupied owner from a live input stream. Existing
  bounded switch/Quit waits refuse cutover if
  proof is missing; refusal drops the cutover fence, not terminal ownership.
- Keep [ADR 0031](../adr/0031-native-terminal-ownership.md): signal the
  kernel-bound foreground group only through the owned PTY, and use observed
  PIDs only as evidence. Preserve credit isolation, no premature slot reuse,
  and the documented limits on background or detached processes. No new force
  close path or changes to AppKit Quit ticket semantics.
- **Acceptance:** drive cleanup with fake observations and a controlled clock
  for wait error then recovery, failed sample then recovery while the master
  remains owned, an observed foreground that disappears later, and permanent
  uncertainty. Assert correct diagnostics, bounded attempts, no false
  completion, no replacement admission, and one final completion when proof
  arrives. Exercise renderer Close and Go Stop after a failed attempt and
  on retry; verify an observed survivor that exits after timeout releases the
  slot without another click. Native Terminal and Quit checks must still
  show real foreground retirement and reject cutover while cleanup is unconfirmed.

## 3. Native admission without a global I/O lock

[`mutate_workspace_files`](../../src-tauri/src/workspace_files.rs#L281) holds
`Core` while waiting for the cross-process Save lock and doing path/draft work.
Go test rerun takes `Core` for its initial source signature and again for the
final signature in [`TestRerun::spawn`](../../src-tauri/src/tasks.rs#L535).
Other native work that needs the same mutex waits behind these operations.

### Workspace mutations

1. Under `Core`, verify the workspace ID, required idle lanes and cutover
   state, reserve one mutation for that workspace generation, and capture the
   admitted root and anchor. The reservation spans the operation; the mutex
   does not. Its release is identity-checked on all returns, including errors.
2. On the blocking worker, acquire the same stable profile Save lock and
   perform the verified descriptor-relative operation and draft-index work.
   Preserve the lock across verification, the filesystem effect, and related
   draft publication as in [ADR 0030](../adr/0030-workspace-path-mutations.md).
   An accepted operation has a stable workspace owner; external path changes
   still require identity rechecks. Preserve partial, unverified, and stranded
   outcomes. Do not introduce a filesystem rollback claim.
3. Make the native reservation reciprocal with workspace install/close,
   Open Recent, New Project admission, ordinary Quit, and Go launch. An
   incompatible cutover must be refused before it stops a live terminal or
   retires drafts. Retain the frontend `ProjectWorkflow` reservation for UI
   ownership; native checks remain authoritative. Ordinary shell I/O, output
   credit, and Stop for an existing owner are not blocked by a mutation lease.

### Cutover, cancellation, and lock order

- Separate acquisition of cutover admission from terminal teardown. Quit
  acquires the reservation while its ticket is live and before staging draft
  retirement. Recheck the ticket immediately before initiating stop requests
  for the terminal or executable debugger, and at final approval. Keep the
  reservation through the AppKit retry and matching draft-stage cleanup if
  refused or expired. Expiry prevents new teardown but does not undo a stop
  already admitted or roll back an admitted save. A busy reservation or a
  failed draft preflight does not start teardown. While a cutover is only
  reserved, existing Go owners may complete a previously admitted handoff;
  new launches still require an unreserved workflow. The matching cutover
  lease authorizes teardown under `Core`. Replacement fences the entire
  outgoing workspace. Quit keeps new admission closed but authorizes stops
  owner by owner: starting terminal cleanup does not fence an unrelated
  Debug or ordinary Go handoff before that owner's stop is authorized.
- Store reservations with the work that owns them. Move mutation and creation
  leases into the blocking job; a dropped IPC waiter must not free a lease
  while the job can still write. The Quit operation similarly owns its lease
  and stage cleanup outside the lifetime of the IPC waiter. If the operation
  has not begun an effect when native acceptance seals admission, refuse it.
  If it has begun, allow the admitted effect and its filesystem/draft
  bookkeeping to settle, but refuse any later cutover against the sealed
  session. The acceptance supervisor waits for these leases as well as
  process ownership; timeout or unproved settlement cannot acknowledge clean
  shutdown. Notify the supervisor when the matching lease releases.
  Native New File also owns a lease through its Save-lock wait and commit;
  it may coexist with a previously admitted Go task but cannot race a
  workspace cutover.
- For path mutations, take and release `Core` for admission, then use
  Save lock → `DraftRuntime` → recovery profile lock where needed. Drop all
  storage guards before the mutation lease destructor reacquires `Core`.
  Final rerun handoff uses Save lock → `Core` and has no draft or Recent work;
  no operation may take the Save lock while holding `Core`. Keep Recent's
  existing `Core` → **nonblocking** Recent profile lock transaction separate;
  its cutover can enter `DraftRuntime` → recovery profile, never Save. Do not
  introduce Recent-profile-lock → `Core` or recovery-profile-lock → `Core`
  paths. Quit draft staging captures its workspace under the admission lease,
  drops `Core`, then takes `DraftRuntime` and the recovery profile lock with
  the existing bounded/nonblocking policy. `ExitGate` is a short check at
  admission or final approval and may be checked under those guards; release
  it before acquiring session/storage locks, waiting, or calling AppKit.

### Verified test rerun

- Under `Core`, capture the workspace identity and `RootAnchor` and give the
  rerun a preparing owner in the existing native Go lane. It has a task ID
  and cancellation latch but no child or process-group handle. Native Stop
  can cancel it, and cutover can retire it. Keep the existing renderer rule
  that the Stop button enables after `Started`; test initial cancellation at
  the native boundary. Move the initial, post-preflight, and final source
  scans onto blocking workers without `Core`. After the initial scan, recheck
  workspace and preparing owner before
  atomically replacing preparation with the published first process. Before
  first spawn, cancellation or failure releases only the matching reservation
  and settles the command without emitting `Started`. A later request cannot
  be displaced by a completed stale scan.
- Preserve [ADR 0025](../adr/0025-verify-go-test-reruns.md)'s verified import,
  package, manifest and environment checks. At final handoff, hold the
  existing profile Save lock outside `Core` across the final signature and
  spawn, so cooperating saves and path moves cannot slip into the gap.
  Include native file creation in this lock's coverage. Treat a contended
  final lock as a retryable launch failure rather than blocking Stop. Then
  take `Core` only to recheck workspace and task identity and latched Stop,
  verify the root identity, spawn, and publish the process group. At every
  process boundary (`go env`, `go list`, and final `go test`), check both the
  cutover fence and Stop along with ownership. A Stop or cutover that wins
  before publication cannot lead to a child spawn. If an admitted task is
  stopped during a scan, cancellation takes precedence over a stale scan error.
- Eliminate `Core` → Save-lock acquisition on all paths before allowing the
  final Save-lock → `Core` handoff. Do not hold `Core` while waiting for a
  profile/file lock, walking a tree, or awaiting process retirement in these
  flows. Preserve the accepted limitations of conditional writes and source
  verification against unrelated external writers.

**Acceptance:** use barriers or real disposable profile locks. A blocked
path operation does not delay an unrelated native state read, terminal credit,
or existing-owner Stop. Conflicting launch/cutover is refused without stopping
terminal or changing draft state. Stale leases cannot release another
reservation. Simulate workspace replacement and Stop during each rerun scan,
Save-lock contention, and manifest change before final verification; assert
no stale spawn and one terminal result for an admitted task. Verify that a
successful rerun still pins its verified package and effective environment.
Drop the IPC waiter during blocked mutation and Quit staging; the operation
must keep its lease through settlement. Seal the acceptance host before an
effect and during an admitted effect; check refusal in the first case and
wait-for-settlement with no premature shutdown acknowledgement in the second.
Exercise Quit expiry before teardown and while cleanup is in progress to
verify the matching draft stage and fence are released.

## 4. New Project creation and cutover

[`new_module`](../../src-tauri/src/main.rs#L204) writes the starter project
before it waits for terminal cleanup. The present diagnostic covers failed
installation but misses prior terminal errors and failures partway through
writing the template.

- Validate the name/module and finish the chooser first. Once a location is
  chosen, acquire the native cutover admission reservation from batch 3
  before creating anything; keep the terminal running until starter creation
  succeeds. Preserve exclusive project directory/file creation. A rejected
  chooser or a pre-creation failure makes no change to the chosen path or
  terminal. The admission reservation is released on every outcome.
- After the first successful directory creation, any later result must
  carry the created path. Use explicit native outcomes for `cancelled`,
  `opened` with the admitted workspace, `created_not_opened` with path and
  explanation, and `incomplete` with path and failed stage. Pre-effect errors
  may still use the ordinary command error. Preserve actual disk effects and
  never delete or overwrite a path to roll back a partial creation.
- Only `opened` installs a new renderer project. For a created but unopened
  or incomplete project, keep the current editor/workspace state, close the
  creation form, and show the path and actual next step; do not silently
  repeat creation. Terminal cleanup may already have started after successful
  creation; do not imply that every child process is still running. A recent
  history error after successful installation remains a warning for the new
  project, not a failed cutover.
- Map form completion separately from `ProjectWorkflow.transition`'s installed
  boolean. Keep the form open after cancellation or pre-effect validation
  errors as today, but treat a committed filesystem effect as a completed
  submission even if no workspace is installed. Preserve the existing form
  API for other forms.
- **Acceptance:** unit-test stage outcomes for mkdir success followed by a
  failed starter write, and terminal or install failure after creation. In a
  disposable native lifecycle run, extend the existing acceptance-only
  cancel-next-picker routing to New Project, cancel location selection, reject an
  existing destination, and hold/fail cutover after starter files exist.
  Verify exact residual files and path reporting, preserve the previous
  project and drafts on failed installation, and open the completed project
  using ordinary Open Project without trying to recreate it.

## 5. Shared Go launch preparation

Share the rules currently repeated by [configured Run](../../src-tauri/src/tasks.rs#L246),
[executable Debug](../../src-tauri/src/debug_program.rs#L65), and
[Terminal Run](../../src-tauri/src/terminal.rs#L338). Share a small concrete
preparation path rather than a generic process state machine.

- Reuse literal package validation, root-relative build command setup,
  configured cwd capture, private artifact ownership, and executable
  validation. Capture the working directory descriptor before the build and
  compare device/inode at handoff for **all three** modes. Reject a replacement
  even when the new path names a regular directory; build from the admitted
  workspace root and run from the validated descriptor. Keep existing
  program-only arguments and overrides, system `PWD` handling, and Debug's
  build flags explicit. Preserve the named-test Debug and plain `go run`
  paths unchanged unless they already call a shared helper.
- Preserve per-mode worker teardown, event ordering, process-group ownership,
  and the workspace/task/Stop atomic publication boundary. Reuse shared
  temporary-artifact cleanup only for identical lifetimes; a failed artifact
  cleanup must stay visible to the owning mode. Do not put DAP, PTY, and
  captured output behind one generalized runner.
- **Acceptance:** test identity capture against an unchanged directory, a
  regular-directory replacement, and a symlink replacement. At the existing
  build barrier, verify all three modes refuse a replacement and a late Stop
  prevents handoff. Native Go, Debug, and Terminal retain their distinct cwd,
  argv, environment, event, and teardown assertions.

## 6. Workbench state and command ownership

### File command policy

Start with Save File, Reload File from Disk, and Format Go File; then migrate
the remaining actions already shared by menu, palette, toolbar, or keys.
Unify *eligibility and invocation* before moving UI glue out of `main.ts`.
Use a typed action ID and one decision per action, with an unavailable reason
where useful. A surface uses the decision for enabled state and delegates
invocation; invocation recomputes it against current state. Preserve localized
surface behavior such as clean Save feedback and keyboard event consumption
where necessary. Native menu labels, responder commands, and generation
checks remain in Rust as in [ADR 0035](../adr/0035-native-menu-and-navigation-history.md).

File operations use one workbench admission owner across decisions (including
dialog-close settlement), formatting, and path changes. Migrate one gate at a
time and remove that gate from its old call sites. Preserve allowed editing
during admitted saves, the existing independent Run and Quit save barriers,
model-version checks, conditional writes, history, and focus. Browser preview
still edits imported copies and does not gain native capabilities.

**Acceptance:** table-test command decisions for clean/dirty, formatting,
save/reload, modal open versus close pending, project transition, and preview
versus desktop. Hold Format and verify Reload is unavailable through normal
entry points until the underlying action can be admitted. Check real menu
projection in native acceptance, including refusal of stale updates. Keep the
dirty-tab Escape and quick-open/Back tests.

### Editor sessions and rendering effects

Start batch 6 by extracting the editor-session recorder, then migrate command
policy and file admission, and remove lifecycle effects from rendering.
The recorder owns its timer, queued work, current project identity, and revision.
Preserve debouncing/coalescing, a
single write at a time, no new writes after project/cutover invalidation,
restoration and failed-snapshot guards, and Quit ticket expiry. Only successful
cutover invalidates the recorder's project; after a cancelled chooser or a
refused/expired Quit, resume scheduling for the same project after release.
An accepted write may finish after a switch; neither its result nor its error may update
the new project. Persisting history remains best effort and does not undo an
installed workspace.

Move navigation invalidation and session persistence notifications from
`renderDocuments` into the document lifecycle sites that change their inputs.
Publish model, editor, selection, and view changes before consumers capture
them; preserve both per-model and workspace guards. The rendering function
must not schedule persistence or decide when pending navigation is obsolete.
Avoid a global state store or event bus; prefer existing lifetimes and direct,
small dependencies.

**Acceptance:** controlled-promise tests cover coalesced writes, old write
completion/failure, transition flush, cancelled chooser, failed restore, and
refused/expired Quit. Verify a scroll-only change persists the new first
visible line even when the caret does not move. Keep
the existing Recent and Quit acceptance coverage and both held-read
navigation scenarios. Verify selection, viewport, dirty text, and focus
survive the extraction through the actual workbench pathways.

## 7. Native acceptance ownership and completeness

Add critical-case checks before moving scenarios so extraction cannot silently
drop coverage. Keep the reporter and phase validator independent of execution;
do not derive the required cases only from the report or selected callbacks.
Use stable case IDs for newly pinned scenarios, leaving names as displayed
diagnostics. Validate individual worker phases before merging their cases.

| Group and phase | Minimum required existing evidence to pin |
| --- | --- |
| `quit`, `quit-save` | Dirty Quit cancellation/preservation and approved discard; partial/expired Save and Quit and successful retry, in their respective groups. Keep the verified AppKit terminal oracle. |
| `recovery` initial | Completed draft, primary app's pre-crash observation and verified intentional SIGKILL. |
| `recovery` reopen | Recovery of the old draft, rejection of stale/wrong-writer removal, refusal/expiry retaining staged recovery, and the case that performs ordinary Discard and Quit with verified primary-app exit. |
| `recovery` after Quit | Observe that ordinary Discard and Quit retired only that writer's draft, then require acknowledged supervisor teardown of the after-Quit app. |
| `terminal` initial | Real PTY I/O and Stop, backpressure and old credit isolation, surviving foreground keeping the slot reserved, and switch/Quit retiring that foreground. |

These are critical case contracts, not hardcoded total case counts. Extend
[ADR 0036](../adr/0036-native-acceptance-report-completeness.md) without replacing
Go's optional gopls check or allowing skips for the mandatory cases above.
Preserve worker, assertion, native Quit, and cleanup error priority. Recovery
binds process evidence to the primary app and the exact phase: watchdog
termination cannot satisfy native Quit, and the second writer's separate
crash report cannot satisfy the primary reopen phase's contract. Keep
the worker entry responsible for its driver session, recorder, and report;
move Go, Debug, Terminal, Recovery, and other scenario groups into small
modules with explicit dependencies. Preserve one fixture/app per group,
intentional shared state within a phase, current relaunch ordering and profile
reuse, report paths, crash teardown, and later-group execution on failure.

**Acceptance:** report unit tests reject missing, duplicate, skipped, and
wrong-phase critical cases and retain primary diagnostics. Reject missing
or wrong-phase process evidence even when all required cases report pass.
Compare the ordered
case names, worker phases, fixture ownership, actual process teardown, and
explicit skips before and after the split. Run the existing native groups and
the runner-crash probe separately; its expected nonzero status is not a test
pass unless cleanup evidence and later-group execution match the contract.

## Review and verification gates

- Reuse `ProjectWorkflow`, `ExecutionLane`, `RootAnchor`, and existing test
  infrastructure. Avoid a rewrite, new framework, fully generic launch
  supervisor, replacing the profile lock with a process-local mutex, or
  partitioning code solely to make files shorter.
- Keep accepted ADR history intact. [ADR 0037](../adr/0037-ownership-and-admission.md)
  records the new durable rules. Existing product behavior stays fixed except
  for the specific failure and admission outcomes above.
- Follow [AGENTS.md](../../AGENTS.md) and [the testing guide](../TESTING.md).
  Run `npm run check` and the affected suites; when a slice touches native,
  WebView, or IPC behavior, validate through native acceptance. Before
  publishing code or runner changes, run the full feedback gate. The
  implementer records results and artifact paths here for each slice. The
  independent reviewer uses those results and may run a focused reproduction,
  not rerun the full suite.

## Verification

Baseline evidence is the controlled DAP breakpoint reply reproduction
described above and the static paths cited in the review.

- **Batch 1:** Chromium reproduced stale marker paint and a stale error before
  the change. The new breakpoint-order case, three related Chromium cases,
  `npm run check`, and native Debug with required gopls and Delve passed
  (`test-results/native/1795866484172-18722`).
- **Batch 2:** Rust terminal tests and a focused Chromium Close/Go Stop retry
  case passed. Native Terminal and Quit passed, including automatic retirement
  after a known foreground survivor exited (`test-results/native/1795866710258-20432`).
  The retryable observation/wait errors have not been induced on a real PTY.
- **Batch 3:** native lifecycle, Files, Go/reopen, Quit, Quit Save, Recovery,
  and Trash passed (`test-results/native/1795867084718-21471`). Rust added
  focused reservation identity and preparing-task cancellation checks.
  The final Files case held the profile Save lock and confirmed that other
  native file inspection still responded and two ordinary Quit refusals each
  released their own ticket (`test-results/native/1795869068044-37406`). The
  effect/seal ordering and nonblocking handoff lock have Rust coverage.
- **Batch 4:** the location cancellation case failed on the previous build
  (`test-results/native/1795867263528-23306`). Rust verified a failed second
  starter write; Lifecycle and Terminal verified picker cancellation,
  duplicate destination, successful creation, and reporting the path left
  by a real terminal-retirement refusal (`test-results/native/1795867370139-23516`).
- **Batch 5:** the old build ran the executable in a substituted regular
  directory (`test-results/native/1795867473078-24532`). The shared-identity
  unit test, native Debug and Terminal (`test-results/native/1795867679332-25379`),
  and native Go/reopen (`test-results/native/1795867877387-27084`) passed after
  the change. The earlier Go run timed out waiting for the light completion
  widget; the test now waits for Settings to finish restoring focus before
  requesting a completion.
- **Batch 6:** File command and editor-session recorder unit tests passed.
  Lifecycle, Files, Recent/reopen, and Quit Save passed in the first native
  run (`test-results/native/1795868104731-28009`). The follow-up also tests
  actual AppKit command availability while Format is held, and persists a
  scroll-only viewport change before Quit.
- **Batch 7:** the report unit tests reproduced false passes for incomplete
  Terminal and Recovery evidence. Scenario extraction split the worker into
  ten modules. A label comparison found all 75 pre-existing native case
  labels preserved; a full report comparison confirmed the same case order in
  all ten default feedback groups except for the added contention scenario.
  The intentional worker-crash probe returned nonzero as required; its cleanup
  record confirmed the app and observed Go child were gone and the later
  Files group passed (`test-results/native/1795869175917-38580`).

The combined feedback run passed 73 Node tests, 69 Rust tests, 54 Chromium
cases, and 66 native cases (`test-results/native/1795868898401-34245`). After
the final busy-Quit ticket fix and two additional Rust tests, `npm run check`
passed with 73 Node and 71 Rust tests, and native Files, Quit, Quit Save, and
  Recovery passed (`test-results/native/1795869068044-37406`).

Final publication review added regression checks for a failed New Project
preflight overlapping an admitted build, queued file creation excluding a
native close, and fresh PTY sampling on reap retry. These passed together in
`test-results/native/1795869923116-42378` with the focused Rust cleanup test.
The subsequent owner-specific Quit check passed on real Delve: an expired
Quit waiting on a tracked terminal foreground did not discard a held Debug
handoff (`test-results/native/1795870219546-45477`).

Independent review required explicit contracts for rerun cancellation,
reservation lifetime and lock order, terminal cleanup retry and proof,
Recovery process evidence, and creation/form and recorder outcomes. A second
review approved the revised design with no remaining implementation blockers.

# Inspect paused Go programs

Status: Implemented first slice of [debug inspection and executable launch](daily-go-workbench.md#4-debug-inspection-and-executable-launch).

## Scope and invariants

- Use the existing Delve test session and Go execution lane. A DAP stopped
  event creates a new pause identity for the reported thread. A frame ID,
  scope, or variable reference is valid only for that pause. Continuing,
  stepping, stopping, replacing the project, or ending the session clears
  the inspection state immediately and discards late replies and errors.
- Enable Continue, Step, and Stop as soon as the paused thread is known.
  Stop clears the pause before waiting on disconnect. If a resume request
  fails while that resume still owns the session, preserve existing behavior
  and finish with the Delve error. If a newer stop has already arrived, ignore
  the old resume reply, including failures.
- Request at most 32 stack frames and select the top frame. Use a separate
  selection revision for frame changes (including reselecting a former frame).
  Fence editor reveal, decorations and source status by that revision. Reveal
  indexed workspace files only. The first automatic reveal may focus the
  editor; selecting a frame from the stack leaves keyboard focus there.
  Keep the selected frame when its source is unavailable.
- Show a call stack and scopes in the debug view. Request scopes only for
  the selected frame and children on expansion. While switching frames, do
  not publish replies for the old selection. Treat repeated variable
  references as distinct tree locations. A disclosure can retain its reply
  while collapsed and reuse it on reopening during the same selection.
  Render at most 16 scopes, 100 children per disclosure, 400 variable rows
  per selection, six disclosure levels, and 512 characters per name or value.
  Allow at most four concurrent inspection requests across a debug session;
  saturated branches show a retry control. If capacity blocks the current
  stack or scopes request, retain one waiting top-level request. When a slot
  frees, start it only if its owning pause and selection still apply. Newer
  top-level work supersedes an obsolete waiter. Show when a list, string or
  depth is truncated and keep the available partial view on failure.
- Add Step Into and Step Out beside Step Over, preserving Continue and Stop.
  Admit one resume operation per pause. Continue or Step clears frame state
  synchronously before sending DAP and a late failure cannot clear a newer
  pause. Inspection failures do not end the session.
- Use ordinary buttons and disclosure controls for keyboard access. Updating
  variables must not steal focus or reset a disclosure the user is operating.
  Keep the debugger private and its existing transport and native teardown.

## Alternatives

- Eagerly requesting all scopes and children would issue unbounded DAP calls
  on every stop. Use pause-scoped, bounded requests for visible content.
- Keep executable build and launch in a separate slice: its build context,
  working directory, environment, argument handling and native teardown need
  their own design and real `go.work` evidence.

## Acceptance

- In a disposable Go fixture, stop in a nested function with a real Delve
  session. Inspect a local scalar and expand a struct, switch to the caller
  and back, step into and out of a call, then continue. Verify the selected
  frame and source highlight at each relevant stop.
- Delay stack, scopes and variable replies independently. Resume or replace
  the session before settlement; old inspection data never changes the new
  view. At the injected-host/browser layer cover frame switches in one pause,
  a newer stop before a failed resume reply, repeated variable references,
  collapse/reopen, request and display limits, a saturated pool recovering for
  a new pause/selection, and recoverable inspection errors. A keyboard-focused
  disclosure must survive its variable update. Hold the disconnect reply and
  verify Stop clears inspection immediately and ignores further stop events.
- An unavailable source frame stays selected. Stop and switch the disposable
  project in the middle of inspection; check the actual test executable's
  process is gone and the Go lane is reusable.
- Run `npm run check`, `npm run test:ui`, and
  `npm run test:native -- --group debug --require-delve`.
  Retain the native Step Over/Continue case and existing run/debug exclusion.

## Verification

- The first Chromium regression reproduced an obsolete resume failure
  disabling Stop on a newer pause. The first native stack test stopped at
  the expected line but found no call stack (`test-results/native/1795837097715-26277`).
- `npm run check` and native Delve passed on the reviewed inspection changes
  (`test-results/native/1795837521571-31583`). Real Delve verified selected
  frames, exact execution-line decorations, local and expanded struct values,
  Step Into/Out, and exit of the actual test executable after Stop or project
  switch with a scopes reply held.
- The three focused Chromium cases passed on the reviewed diff. They cover
  early terminal notification, a stale resume and delayed disconnect,
  same-pause frame changes, saturated request replacement, late variable
  replies, truncation, retry, and keyboard focus on a disclosure. The full
  Chromium run before the last acceptance corrections passed 42 cases; its
  saturated-pool fixture needed to await the asynchronous disclosure toggle.

# Stabilize native Quit acceptance on hosted macOS

## Evidence

GitHub Actions runs 45924806509 and 45938809405 passed the browser suite
and Go/Delve groups but timed out waiting for the dirty dialog after sending
an external `NSRunningApplication.terminate()` request to a minimized
window. The latter run captured the dirty buffer and live Go process after
failure. The API returning `true` is not proof of AppKit delegate delivery;
the artifacts do not conclusively establish where the request stalled. The
earlier run additionally timed out running `swift -e` during clean Quit.
Run 45944812586 also timed out in `swift -e`. Its minimized case did see
an open confirmation, but later saw a visible, restored window without a
usable confirmation. The short test ticket and synchronous helper made it
possible to miss the usable state; this does not prove that either caused
the failure.

## Change

Compile a test-only Swift helper once per native invocation, before starting
the selected groups, and reuse it for actual external system Quit of visible
windows. Use the existing native application menu action (`terminate:`) for
the minimized-window case. This tests deminiaturizing and presenting the
real confirmation after a native Quit request without depending on external
Apple-event routing to a minimized application in a hosted login session.
Keep the separate visible dirty and clean system Quit checks, the visible
menu check, and window close. Do not retry via a fallback, remove any
confirmation/visibility/child/exit assertions, or mark failures as skips.

Capture the menu acknowledgement, native window state, and renderer request
count around the minimized scenario so that a later failure can distinguish
request delivery from presentation. The hosted minimized oracle then covers
AppKit menu Quit, not external system Quit while minimized. This is a runner
change, not a production Quit-policy change.

Allow 10 seconds on the Quit test ticket instead of 3.5 so CI can observe
and operate the restored dialog. The test still lets an unanswered ticket
expire and requires a subsequent request to work. The production timeout
does not change.

## Acceptance

- Existing hosted runs demonstrate the failure before the change. Rerun
  lifecycle and Quit locally, requiring exit, real minimized-window
  restoration, and preservation of dirty text, file bytes, and the child.
- Run full feedback. Verify that an absent helper or unsuccessful native
  request fails, rather than accepting a missing test result. The Swift
  helper must not be in the app bundle. Hosted verification requires a run
  of the updated workflow; local passes alone do not prove hosted behavior.

## Verification

Full feedback passed locally with the compiled helper and native menu path
(`test-results/native/1795756999817-85777`). The final test timeout revision
passed the lifecycle and Quit groups on the same acceptance binary
(`test-results/native/1795757136483-87518`). The minimized-case artifact
shows one fresh renderer request and a transition from minimized/invisible
to restored/visible while the real confirmation was usable. Cancel then
preserved the buffer, disk bytes, and Go child. The compiled helper rejected
an invalid PID with a nonzero exit. Hosted verification remains pending.

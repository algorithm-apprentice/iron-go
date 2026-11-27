# Keyboard navigation and Go test actions

## Scope and evidence

A disposable keyboard-only Go project passed run, save and test. In the native
workbench, `Ctrl+Tab` left the active file unchanged; Quick Open worked but
required retyping the name. The command palette could run all tests, but did
not expose an action for the test at the caret. Add both workflows without
changing layout, typing, the Go task lane, or Delve/LSP protocols.

## Navigation

- Add discoverable **Next Editor** and **Previous Editor** palette commands.
  Default to `⌘⇧]` / `⌘⇧[` on macOS and accept `Ctrl+Tab` / `Ctrl+Shift+Tab`
  when the WebView delivers those chords. Match physical bracket codes where
  available so Shift does not turn them into different key names. Shortcuts
  remain inactive inside a modal or during IME composition. Do not steal
  the key if the workbench is busy, the modifier combination is not exact,
  or there is no distinct open destination. Determine eligibility before
  preventing the native default.
- Cycle in the visible tab order and wrap. Activate the existing Monaco model
  directly, restore its view state and give the editor focus. Never load a
  file, reorder tabs, save or discard. Explicit cycling supersedes pending
  navigation in the same workspace. Apply the existing workflow busy guard.
  An earlier read can finish and add its tab but cannot activate or focus it.
- Prefer simple ordered cycling over MRU state or a transient switcher UI.
  Retain Quick Open for navigation to files that are not already open.

## Run and debug at the caret

- Expose **Go: Run Test at Cursor** and **Go: Debug Test at Cursor** in the
  command palette. Do not add a new default key chord for these actions or
  rebind existing Run/Stop. A user can invoke either solely through the
  palette. Capture the active native `_test.go` tab and current caret.
- Reuse gopls document symbols and the existing CodeLens name criteria; use
  the enclosing top-level function's full range, not a nearest name or a
  regex on potentially invalid source. The end of an LSP range is exclusive.
  No enclosing test or unavailable gopls yields a clear message without
  launching. Do not infer a test in comments or from a sibling function. Flat
  symbols do not establish declaration extents so the caret action fails
  closed on them; existing CodeLens flat-symbol behavior is unchanged.
- The lookup is asynchronous. A single generation shared by Run and Debug
  is invalidated on newer invocations, caret and active-model changes, and
  the start of a workflow reservation (even if it later cancels). Compare
  it with the captured project, model/version and gopls identity before
  publishing feedback or synchronously handing off. Check launch availability
  at handoff so an occupied lane cannot start a second task. After handoff,
  the exact-name Run/Debug path owns save, tool and exclusivity checks. Do
  not duplicate launch or breakpoint logic. Preview retains native-tool guidance.

## Acceptance

1. Reproduce the missing keyboard behavior before product changes. Browser
   coverage opens several tabs, edits one, cycles and wraps in both directions,
   and verifies dirty models, restored view state and editor focus. Confirm
   blocked keys remain unconsumed and a pending open cannot steal focus.
2. Focused symbol/async tests cover body vs. boundary/outside positions,
   sibling and non-test symbols, and delayed results invalidated by edits,
   away-and-back caret/tab movement, a canceled transition or newer command.
   Check an occupied lane at handoff. No fallback to a differently named test.
3. In a disposable native fixture, drive palette commands with keyboard
   events. Run one of two real tests with the cursor in its body immediately
   after a dirty rename (the request must flush pending changes); assert the
   sibling did not run. Explicitly require Delve and use Debug Test at Cursor
   to hit and resume a real breakpoint in a native run. On an unlocked local
   console, prove the default tab chords with actual macOS key events, not
   merely script-dispatched DOM events. Retain existing CodeLens behavior.
   Run `npm run check`, browser and native acceptance before code review.

## Verification

- The browser shortcut regression failed on the baseline and passed after
  cycling was wired; tests also verify preserved caret/dirty state and that
  a pending open can add a tab but cannot steal activation.
- `npm run test:feedback` passed (22 TS tests, 31 Rust tests, Go fixture,
  19 browser tests and 21 native cases). Native artifacts:
  `test-results/native/1795748644954-47274`. The Go group ran the renamed
  test and not its sibling; Debug Test at Cursor stopped at a real Delve
  breakpoint, stepped and continued. Existing CodeLens launch tests passed.
- On the unlocked macOS console, native HID key events moved from `main.go`
  to `main_test.go` with `⌘⇧]`, back with `⌘⇧[`, and forward again with
  `Ctrl+Tab`. On the disposable keyboard-workflow project, actual keyboard
  input opened the palette and ran `go test -v -run '^TestClamp$' .` with
  exit code 0, without any DOM action dispatch or project file injection.
- After code review, rechecked physical-code priority for conflicting key
  names, three-tab order, blocked shortcuts without consuming the event,
  and real Monaco/reservation invalidation with a late occupied lane.
  The updated full feedback passed (23 TS, 31 Rust, Go fixture,
  20 browser, 21 native; `test-results/native/1795749182893-49774`).

## Native browser shortcut follow-up

On an unlocked macOS console, real keystrokes delivered to a dirty disposable
editor confirmed that the reload family (`⌘R`, `⇧⌘R`, and `F5`) did not
replace the WebView, write the file, or discard the buffer. The guard also
blocked `⌘L` and `⌘=`. However, the physical zoom-in chord `⇧⌘=` reached
WKWebView as `key: "=", code: "Equal", shiftKey: true` and was not canceled
by the existing guard. The buffer survived this chord; no crash was observed.

Recognize that event as the zoom-in chord, in addition to the existing
`key: "+"` form. Keep the guard desktop-only and leave unrelated modified
keys and the Monaco editing shortcuts alone; keep native zoom hotkeys off
in the Tauri window configuration. No new shortcut or interception layer.
Require a native event regression with the observed fields, plus real HID
checks for reload, address-bar focus and the zoom family. Confirm that the
same WebView instance, dirty buffer and unchanged disk survive.

The new event case failed against the pre-fix native build
(`test-results/native/1795752626475-67039`). Full feedback passed after
the fix (`test-results/native/1795752717002-67434`; 23 TS, 31 Rust,
Go fixture, 25 browser, 23 native). Real macOS key events for `⌘R`,
`⇧⌘R`, `F5`, `⌘L`, `⌘=`, `⇧⌘=`, `⌘-`, and `⌘0` all reached WKWebView
and were canceled. The same WebView and unsaved content survived and
the file stayed unchanged (`test-results/keyboard-audit/native-browser-shortcuts.json`).

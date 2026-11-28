# macOS menu bar and code navigation history

Status: Implemented and independently reviewed.

## Problems and scope

Project commands exist in Welcome, Project Actions, and the command palette,
but there are no native File menu entries for creating or opening a project.
Editor cycling switches tabs; it does not restore the previous code location.
Provide a usable native menu on Welcome and in a project, and make returning
from an intentional code jump a first-class operation. Retain the existing
workbench entry points and macOS application/window behavior.

## Menu structure

| Menu | Project and editor commands |
| --- | --- |
| Iron Go | About, Settings (`⌘,`), standard macOS services and hide commands, Quit (`⌘Q`). |
| File | New Project (`⌘N`), Open Project (`⌘O`), Open Recent, Close Project; New File, Save File (`⌘S`), Save All, Reload File from Disk; native Close Window (`⌘W`). |
| Edit | Standard Undo, Redo, Cut, Copy, Paste, Select All and editor Find; Format Go File, Organize Imports, Rename Go Symbol. |
| View | Explorer (`⇧⌘E`), Search Saved Files (`⇧⌘F`), Toggle Sidebar (`⌘B`), Toggle Bottom Panel (`⌘J`), Command Palette (`⇧⌘P`); native Full Screen. |
| Go | Back (`⌃-`), Forward (`⌃⇧-`); Go to File (`⌘P`), Go to Line, Go to Symbol in File, Go to Definition (`F12`), Find References; Next Editor and Previous Editor (existing `⇧⌘]` / `⇧⌘[`). |
| Run | Run Selected Target, Build Packages, Run Tests, Run Test at Cursor, Debug Go Program, Debug Test at Cursor, Stop Task; Start Shell, Run Go Program in Terminal, Close Terminal. |
| Window | Native window management. |

Use the same action labels in menus and other command surfaces. The shortcut
column describes the workbench bindings, not a requirement to assign every
binding a native menu accelerator.
Actions that open a form, palette, or picker have an ellipsis in menu labels.
Keep secondary Explorer operations, run configuration editing, and individual
Settings preferences in their existing surfaces. Do not copy the full palette
into the system menu. Existing controls for breakpoint and debug stepping
remain; the initial Run menu can add those once its basic actions are covered.

- On Welcome, New Project, Open Project, Open Recent, Settings, and native
  app/window controls work. Commands that require a workspace or editor are
  disabled. Once a workspace is open, individual actions become enabled only
  where applicable: e.g. Close Project needs a workspace, Save File needs a
  dirty eligible tab, and definition needs an eligible Go editor and gopls.
- Use normal native items for text editing and OS functions where they already
  work; avoid swallowing those actions on WebView text fields or in Monaco.
  Close Project returns to Welcome. Close Window and Quit keep the established
  AppKit confirmation and process retirement in
  [ADR 0008](../adr/0008-appkit-quit-guard.md).
- Menu New Project goes through the existing form and location picker, not an
  implicit default path. New and Open obey the same dirty-buffer and active-task
  decisions as their buttons. Cancel returns to the original workspace or
  Welcome and does not create, retire, or replace a project.

## Ownership and dispatch

Rust constructs the native menu and transmits allowlisted action IDs to the
main window; TypeScript owns the workbench actions and computes whether they
are available. Reuse existing command handlers and guards, including
[ADR 0010](../adr/0010-workbench-workflow-ownership.md). Do not invoke filesystem
or process actions directly from menu callbacks. Preserve the AppKit responder
chain for app and standard edit/window actions.

Install one application menu through the Tauri builder, retaining the native
`terminate:` and `performClose:` actions and the registered Window submenu.
Keep one Close Window key equivalent, in File. Do not construct a fresh menu
on workspace changes.

Use a small registry limited to menu-backed workbench commands. Menu dispatch,
shared keyboard bindings, and palette entries use the same action and
enablement predicates. Recheck eligibility at execution, including after the
palette closes. An action refused while a dialog, save, run, composition, or
transition is active is not queued. Observe modal open/close state (including
programmatic changes) and composition changes, in addition to editor,
project, and execution updates; `syncControls` alone is not sufficient.

Rust applies full enablement snapshots on the AppKit main thread, checking
the renderer generation and increasing revision at the point of application.
Starting a new main WebView document invalidates the previous generation;
disable its workbench items until the replacement listener has registered and
published its first state. A late state update or action for the old document
does not mutate or dispatch in the replacement. Native app/window items are
independent of this handshake.

| Binding | Owner and focus behavior |
| --- | --- |
| AppKit Quit/Close Window and standard Edit bindings | Native responder chain, preserving macOS confirmation and focused text field behavior. |
| `⌘N`, `⌘O`, `⌘,` | Native app menu on desktop. Remove duplicate desktop handlers for `⌘O` and `⌘,`; retain preview bindings as applicable. Reject workbench action dispatch during composition or an incompatible modal/transition. |
| `⌘P`, `⇧⌘P`, `⌘S`, `⇧⌘E`, `⇧⌘F`, `⌘B`, `⌘J` | Existing renderer ownership. `⌘P` opens commands on Welcome, files in a project. Native menu clicks call the same handlers without a second accelerator. |
| `F12`, `⌘F`, `F9` | Preserve existing editor-specific ownership. F12 uses Monaco's Go definition action; Find uses Monaco when the editor has focus and does not intercept form or terminal Find behavior. The menu can invoke editor Find only for an eligible editor. F9 keeps its existing renderer handler. |
| `⌃-`, `⌃⇧-`, editor cycling | Renderer owns Back/Forward and checks the physical Minus key, modifiers, focus and `isComposing`. Do not steal terminal input or dialog text shortcuts. Retain the existing bracket bindings and Ctrl+Tab / Ctrl+Shift+Tab cycling. |

Do not install global hotkeys. Document renderer-owned shortcuts in command
hints rather than registering a second native equivalent. Verify real key
activation, not just menu item dispatch.

## Back and Forward

Keep a bounded, in-memory history per admitted workspace. Each location holds
a relative path, primary caret/selection, and viewport. The history is editor
state only; it does not write or duplicate unsaved text.

- Record a successful explicit jump as a departure and arrival: definition,
  references, symbol/line, search result, problem/task result, Quick Open, and
  explicit Explorer file open or tab selection. Capture the departure before
  any asynchronous read or modal focus change. A canceled or stale jump does
  not create an entry. Integrate both workbench and Monaco definition entry
  points without double-recording the same activation.
- Do not add history for typing, scrolling, ordinary caret movement, editor
  cycling, background editor opens, or automatic debugger source changes.
  Deduplicate consecutive identical path and primary selection; viewport-only
  changes update the live location. Keep at most 100 records. No persistence
  across app restart or committed project changes, including deliberate reopen
  of the same workspace. A canceled transition leaves history intact.
- The cursor represents the last committed history location, not the current
  focused editor. After `A → B`, an unrecorded switch to `C` (e.g. cycling,
  debugger), or no active editor, Back goes to `A` and Forward returns to `B`.
  Do not overwrite `B` with `C`. If a new explicit jump starts at `C`, record
  `C` as its departure when that jump commits. If the active file matches
  the indexed entry, refresh that entry from its live caret and viewport before
  departing; e.g. after scrolling at `B`, Forward restores the updated `B`.
- Before replay, update the indexed departure only if the active path matches
  it; otherwise leave the indexed location intact. A successful replay moves
  the history index and
  restores editor focus and the saved selection and viewport. A new successful
  jump after Back truncates the forward branch; Back/Forward themselves never
  append history. Restore a live dirty tab, or reopen a closed file via the
  existing project reader. Clamp obsolete coordinates to the current text
  and preserve valid UTF-16 boundaries; no semantic relocation after edits.
- Use an explicit navigation reservation/revision through the last async
  activation check, aligned with [ADR 0019](../adr/0019-go-navigation-snapshots.md).
  A newer jump, close, or project change must not let an older read steal the
  editor or advance the history index. Taking the project-transition
  reservation invalidates both replay and pending explicit jumps, including
  gopls replies, workspace reads, and Monaco activations. Canceling that
  transition preserves committed history without reviving older requests.
  Commit synchronously at actual editor activation, after selection and
  viewport restoration.
  A returned tab, even one that happens to be active by then, is not proof
  that this request activated it. Pin the operation identity through this
  commit point; restore the viewport after selection reveal/layout.
- Back/Forward are disabled while a replay is pending. Skip confirmed missing
  and trashed entries and remove them from history; if every candidate in one
  direction is gone that direction becomes disabled. Use typed disk inspection
  (`missing` versus `unavailable` / `retry`) when a closed-file read fails.
  Do not infer missing status from tree membership or string errors. A
  transient failure preserves the candidate and cursor and reports an error.
  Rebind verified workspace moves and invalidate confirmed trash paths. For
  an unverified partial result, do not invent a mapping to a replacement file.
- The read-only dependency viewer is an overlay, not an editable history entry.
  While it is open, enable Back even with no previous history; Back closes the
  viewer and restores its originating editor. Forward is disabled while viewing
  it and does not reopen it. Other modal dialogs block replay.
- For Monaco's opener, only a deliberate activation of a workspace location
  in the main editor commits history. Embedded Peek previews do not; clicking
  a result to leave Peek and open the main editor does. The multi-target
  workbench definition path hands off to Monaco, and the final activation
  records once. A same-file navigation that does not invoke the opener must
  still pass the intentional-jump commit boundary. Do not infer an explicit
  jump from every Monaco cursor-change event.
  The workbench definition commands capture the departure before lookup.
  For Monaco modifier-clicks and picker selections, the accepted opener
  records the live departure. The gesture invalidates older lookups without
  storing a shared departure that an unrelated opener could consume.

## Implementation order and acceptance

1. **Native menu routing.** Start with a failing native test: invoke the
   actual File menu’s New Project item while on Welcome, rather than calling
   the workbench handler. Open the form, cancel and confirm Welcome survives,
   then create a module in a disposable location and verify its disk files and
   open editor. Fixture-parent injection verifies creation but does not prove
   the real location picker. In a separate opt-in Accessibility check, cancel
   the real picker on a disposable installed app and confirm nothing is
   created. Check Open Project and Open Recent, disabled workspace-only
   items on Welcome, and one dispatch for a real keyboard shortcut. Exercise
   dirty Open/Close cancellation, retaining the buffer and any running child,
   and preserve the existing Quit regression.
2. **History state and replay.** Unit-test the bounded history, branch
   truncation, deduplication, and skipped missing entries. Test races and
   replay through live/closed models at the workbench layer. Native acceptance:
   jump to a real gopls definition in another file from unsaved Go text; Back
   and Forward via menu/shortcut restore path, caret/selection, viewport, and
   the original dirty text. Cover same-file Go to Line, a canceled project
   change, a superseded pending read, an unrecorded switch or no active editor
   after `A → B` (Back to `A`, Forward to `B`), and Back from read-only dependency
   source. Confirm no writes to the fixture occur during replay. Drive native
   menu items through AppKit traversal; verify representative native shortcuts
   and Back/Forward with the opt-in PID-targeted Accessibility runner. Keep
   these permission-dependent key tests out of the default CI gate.
3. **Menu coverage.** Register and verify the remaining menu groups against
   the existing actions. Smoke-test edit responder behavior, run/stop and
   project/modal availability. Run `npm run check` and native acceptance
   (Lifecycle, Quit, and Go with real gopls); preserve browser preview tests.

## Alternatives

- Adding native items that directly call Rust workspace operations would
  bypass the existing confirmation and save barriers.
- Tracking every cursor motion would bury deliberate code jumps in ordinary
  editing. Standalone Monaco cursor undo cannot replace cross-file history.
- Persisting history immediately would require path/identity migration and
  policy for stale projects. Use the recent editor-session store for its
  existing purpose and keep jump history session-scoped for this pass.

## Verification

The initial Lifecycle regression found no New Project entry in the File menu
(`test-results/native/1795860210156-89039`). The final native run passed
Lifecycle, Go, Quit and Accessibility (`test-results/native/1795862444334-95413`).
It verified AppKit menu creation from Welcome, real Command-N, cross-file
Go Back/Forward on a dirty buffer, an abandoned definition followed by a
successful jump, and the Control-Minus bindings. `npm run check` and Chromium
passed. The rebuilt Apple Silicon DMG passed image, icon resource and bundle
signature checks. Creation under the fixture parent was verified; the real
location picker's cancellation was not part of this run.

## Follow-up: delayed Back replay in the workbench

Exercise the normal preview workbench, including its explorer, keyboard
commands, and project transition dialog. Intercept one preview `File` read
in each isolated Chromium page so the test can stop Back after it has started
reopening a closed tab. Release that read only after a newer navigation commits
or the user cancels a dirty project transition. The old target must not open
or activate, the selected editor and any dirty state must survive, and a fresh
Back (and Forward after cancellation) must still follow the committed history.

A history-only test cannot prove that the workbench passes the current-visit
guard to the editor. A native acceptance probe could hold a disk read, but the
race is in renderer code and Chromium exercises the same replay wiring. The
test changes only the preview file-read boundary and does not add a shipped
test hook or use a timer to decide when the replay is pending.

Both focused Chromium cases passed. Temporarily omitting the replay's
`current` guard at the editor boundary made the newer-jump case reopen the
old tab in the background and the canceled-transition case activate it. Both
tests passed again when the guard was restored. `npm run check` also passed.
No product changes or native acceptance were needed for this follow-up.

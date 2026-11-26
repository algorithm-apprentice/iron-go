# macOS user-workflow acceptance plan

Status: Active. A checked build is not a claim that every possible bug is gone.

## Method and environments

Test the same workflows in focused service tests, headless workbench UI, and
the native WKWebView. Use Orbit only as a deterministic test fixture and a
disposable Git snapshot of a real Go library (Raft) for project-scale checks.
Headless UI tests serve built assets in a temporary directory, not Vite's
hot-reload server; a cold dependency optimizer must not race the browser.
Never edit a user's live project or replace a running installation as part of
testing. Test on a Retina display and a mixed-1×/2× setup when available.
Record exact SDK/tool versions, failing test names and artifacts. Add a
regression case before changing production code; re-run that case and the
relevant full gate after a fix. A skipped tool/OS case is not a pass.

## User-facing coverage

| Area | User scenarios and acceptance oracles | Gate |
| --- | --- | --- |
| Install and launch | Build normal release `.app` and `.dmg`; mount read-only and verify architecture, version, application link, and no test fixture/automation in the release. Open to welcome, with no background project or Go process besides tool probing. | Release + native |
| macOS window and project picker | Traffic lights and centered command field at default/minimum size; side/panel toggles and thin resizers; real native Open Project, focus, Cancel, and no workspace change. Compare first-open text sharpness vs a screen round trip on mixed DPI. | Browser geometry + AX picker probe |
| Project lifecycle | Open an existing module or `go.work`; create a module in a chosen parent; reopen or cancel; reject duplicates; directory and read guards; close to welcome; switching or closing with dirty buffers/running work must not discard silently. | Rust + native |
| Files and tabs | Open from Project, Quick Open, search result and definition; use multiple editors, preserve view state and undo; create a nested file, reject duplicate/traversal, edit/read UTF-8; save and block external-edit conflict; reload confirmed from disk. | Rust + UI + native |
| Editor geometry and keyboard | Verify actual code text, line number and active highlight agree when opening, scrolling and resizing a Go file; repeat with CodeLens, wrapping and Retina. Guard WebView reload/zoom/location; preserve Find, Go shortcuts, clipboard, and text navigation. | Native + UI |
| Search | Filename and text search in the active project, Unicode columns, literal strings, case-sensitive toggle, no matches, and click to exact result. Unsaved changes must not be presented as saved search results. | Focused + UI/native |
| Formatting | Real gofmt on current buffer including invalid syntax; preserve disk until Save, undo a format, and ignore stale results after later edits or tab disposal. | Rust + native |
| Go language services | Missing Delve or gopls must not block file editing. Resolve installed Go/gopls; open real project; hover a known symbol, complete it, follow a cross-file definition, publish and clear live diagnostics, open Problems, and dispose the old LSP session on switch. | Native, gopls required |
| Run and test | Discover sole/multiple/no executable targets without guessing by filename; use explicit selection for multi-target projects; build/test all/current/custom scope; inspect real output and exit state; stop the whole process group; run only one Go test via CodeLens; close/switch during a task safely. | Rust + native + Raft smoke |
| Debug tests | Mark a real executable line; missing Delve guidance; start the named test with Delve, stop exactly at the editor breakpoint, inspect current source location, step over, continue/stop, and prevent stale sessions on switch. This is a new feature, not previously covered. | Native, Delve required |
| Theme and preferences | Dark/Light switch app plus Monaco without losing buffer edits; preference survives reload; minimap and word wrapping toggle without altering content. | UI + native |

## Run order

1. `npm run check` and `npm run test:ui`: inexpensive behavioral and layout gates.
2. `npm run test:native -- --require-gopls --require-delve`: real Orbit workflows.
3. `npm run test:native -- --skip-build --project /path/to/raft --test-file raft_test.go --debug-test TestLeaderElection`:
   real project open, package detection, Go tests, language services, row geometry,
   and a real breakpoint in Raft.
4. `npm run tauri build -- --bundles app,dmg`, then `npm run test:picker`.
   On mixed displays add `-- --retina-probe --display-round-trip`. Separately
   verify the mounted disk image and any conditional macOS fix in a native run.

## Current gaps to close

- The reported active-row mismatch has not reproduced in the initial
  scroll/CodeLens measurement on the Raft snapshot. Capture the precise
  target file/interaction, then add a failing geometry or visual regression.
- Native picker first-frame sharpness in mixed-DPI setup is reproducible;
  a standalone prototype workaround is not yet a shipped fix.
- Still expand coverage for app quit with unsaved edits, current/custom Go
  scope, project switching during debugging, and unlocked mixed-DPI rendering.

## First round evidence (2026-11-27)

- Go 1.27.4, gopls 0.24.0, Delve 1.27.2: 5 TS tests, 9 Rust tests, Go fixture,
  7 built-asset UI scenarios, and 15 native scenarios passed. The native run
  includes undoing a format, cancelling/accepting reload and dirty close,
  creating a project, and pausing/stepping/continuing a real test.
- Raft disposable snapshot: 7 native scenarios passed, including a real
  breakpoint in `TestLeaderElection` and DOM row alignment with CodeLens,
  scrolling, wrapping and a 760 px-wide window. This is not a reproduction
  of the originally reported foreground paint symptom.
- Found and addressed stale Monaco viewport dimensions/model painting and a
  dev-server dependency optimization race in browser acceptance.
- Built Apple Silicon `.app` and `.dmg`; verified checksum and mounted the
  DMG read-only to confirm the binary and Applications link. This round's
  real picker AX check was blocked by the locked macOS console; it is not
  counted as a pass. Existing standalone picker evidence is from earlier
  unlocked testing.

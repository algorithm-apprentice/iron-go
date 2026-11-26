# First macOS Workbench

Date: 2026-11-26.

Status: Implemented and verified on Apple Silicon macOS.

Decision: [ADR 0001](../adr/0001-macos-go-workbench.md).

## 1. Scope and invariants

- Open a native folder without Go installed; create a minimal Go module
  in an existing parent directory without modifying an existing project.
- Navigate a tree and search saved text or filenames; edit UTF-8 files in
  Monaco with separate undo history per tab, dirty detection, and explicit
  save. Saving must not overwrite edits made on disk since the last read.
  Scope paths to the active native folder; don't follow workspace symlinks.
- Format Go buffers via `gofmt` without a disk write. Undo must restore the
  previous buffer. Late format results cannot overwrite further edits.
- Run a configurable executable package or build/test a relative package
  pattern. Save dirtied files before starting; never run if a save fails.
  Show real output and exit state. Stop the process group. Keep bounded
  stdout/stderr with a visible truncation notice, but do not claim precise
  inter-stream ordering or interactive input.
- With `gopls`, provide completion, hover, workspace definition navigation
  and diagnostics. Opening or editing must still work when gopls is absent
  or fails. Destroy the old server/model state on workspace switch.
- A browser import is a memory copy, not filesystem access; only the
  bundled sample is saved to browser storage. Preview cannot claim to
  format, run, or test real Go.

Non-goals: Windows/Linux delivery, PTY/interactive input, Delve,
extensions, Git UI, file watching/automatic reload, and workspace restore.

## 2. Layout and shortcuts

Use the VS Code workbench layout, not Iron C++'s toolbar layout. The title
bar holds Quick Open and layout controls; global Open Folder stays available
there. The editor group has tabs and breadcrumbs, with Run, Format, and Save
in its top-right action area. Explorer, Search and Go Tasks live in the left
activity bar; Problems and Output share the lower panel. Keep Iron Go colors
and macOS controls rather than copying VS Code branding. Sidebar and bottom
panel can be resized and toggled. Primary macOS shortcuts: `⌘O` open folder, `⌘P` quick open,
`⇧⌘P` commands, `⌘S` save, `⇧⌘F` workspace search, `⇧⌥F` format,
`⌘↵` run, `⌘B` sidebar, `⌘J` bottom panel.

## 3. Ownership and boundaries

One native `Session` owns a canonical root and a monotonically increasing
workspace identity. All path calls carry that identity. Rust owns native
dialogs, paths, Go tools and subprocesses. No command accepts arbitrary
executable names, shell scripts, or workspace paths from the production UI.
The IDE does not sandbox user-requested Go tasks: only run or test code the
user trusts. Finder-launched apps discover tools in macOS installation
locations and the user's Go bin as well as `PATH`.

The frontend owns Monaco models and UI orchestration. Workspace switch
disposes models, discards late results, and stops the server/task. Files,
output and diagnostics are rendered as text; LSP documentation is untrusted
Markdown. A preview project implements the same file interface without IPC.

## 4. Test-first implementation gates

| Behavior | Oracle |
| --- | --- |
| Safe paths and saves | Rust rejects traversal, symlinks, duplicate creation, external edit conflict. |
| Go tools | Rust formats real source, captures sample program output, cancels a real process. |
| Workbench | Headless tests verify VS Code-style region placement, sidebar toggle, navigation, edit → dirty → save, and search/quick-open. |
| Native bridge | macOS WebView opens a copied Orbit fixture; save changes bytes read by the test runner; gofmt fixes formatting; Go Run/Test print expected real output. |
| Semantic features | Native test with installed `gopls` reports a real undefined symbol and clears it after correction. The real Monaco actions offer `NewReport`, show its hover signature, and navigate to its definition in another file. |

Continue by feature in this order: write/extend tests, then editor tabs and
workspace, then task bindings, then language service. See the
[feedback design](test-feedback-loop.md) for the automated gate.

## 5. Verification

2026-11-26: `npm run test:feedback` passed with Go 1.25.3 and gopls
v0.20.0. All seven native acceptance cases used the real WKWebView and a
disposable Orbit module, including hover and cross-file definition navigation.
The system folder picker itself is bypassed by the native automation build.
The production bundle was built separately without the test feature, and the
frontend test adapter was absent from its assets.

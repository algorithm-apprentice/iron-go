# Iron Go architecture

Iron Go is a standalone macOS app built with Tauri and Monaco. Iron C++ is an
architecture reference; it is not required to build or test Iron Go. See the
[decision records](adr/README.md) for the reasoning and the
[design index](design/README.md) for feature invariants and test evidence.

## Ownership and boundaries

- **The Rust host** owns the current workspace identity, file operations and
  watchers, native menus and dialogs, and local child processes. Each process
  and its channels have a single owner and retire on project switch or close.
- **The TypeScript workbench** owns Monaco models and visible state, command
  eligibility, project transition decisions, and navigation history. Async
  results must still match their originating project, model, or session before
  they apply. Rust projects command eligibility into the native menu.
- **Tauri commands, channels, and events** form the production IPC boundary. Workspace
  operations carry the active identity. The browser preview implements the
  project interface over imported files without native IPC.
- **The Go toolchain** owns `go.mod` and `go.work`. Opening a project does not
  rewrite them. Missing tools disable only the features that need them.
- **Workspace names, source text, search results, and output** are rendered as
  text nodes. Language-server documentation is handled separately as untrusted
  Markdown.

## Code map

Rust files are under [`src-tauri/src`](../src-tauri/src/); TypeScript files are
under [`src`](../src/).

| Area | Rust host | TypeScript workbench |
| --- | --- | --- |
| App and project lifecycle | `main.rs`, `workspace_admission.rs`, `quit.rs`, `workbench_menu.rs`: session, native operation leases, Quit tickets, AppKit menus and command registration. | `main.ts`, `project-workflow.ts`, `quit-flow.ts`: workbench assembly, commands, reservations. |
| Workspace and editor | `workspace.rs`, `workspace_disk.rs`, `workspace_files.rs`: guarded paths, saves, file identity, watchers and moves. | `workspace.ts`, `project-model.ts`, `editor.ts`, `navigation-history.ts`, `file-commands.ts`: project bridge, tree/search, Monaco models, Back/Forward and file admission. |
| Continuity | `recent.rs`, `drafts.rs`: recent roots, editor sessions, crash snapshots, leases and retirement. | `draft-recorder.ts`, `editor-session-recorder.ts`: recovery and recent-state recording. |
| Build, run and test | `tools.rs`, `packages.rs`, `tasks.rs`, `go_launch.rs`: tool discovery, gofmt, run targets, process ownership and configured executable handoff. | `execution.ts`, `run-targets.ts`, `run-configurations.ts`, `go-test-stream.ts`, `feedback.ts`: launch admission, scopes, configurations and results. |
| Language services | `lsp.rs`, `go_source.rs`, `tool_transport.rs`: gopls stdio transport and read-only dependency source. | `lsp.ts`, `go-semantic-tokens.ts`, `go-source-view.ts`, `go-rename.ts`, `go-import-edits.ts`: Monaco providers and Go edit/navigation workflows. |
| Debug and terminal | `debug.rs`, `debug_program.rs`, `terminal.rs`: Delve DAP, executable handoff, PTY lifecycle and credits. | `debugger.ts`, `debug-inspection.ts`, `terminal-pane.ts`: breakpoints, paused state and xterm.js interaction. |

See the [testing guide](TESTING.md) for the separate acceptance build and
disposable fixture boundaries.

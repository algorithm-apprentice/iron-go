# Iron Go Architecture

Iron Go follows the macOS structure documented in `../iron-cpp/docs/ARCHITECTURE.md`.
It is a standalone application: the sibling repository is not required for
builds or tests. See [the ADR index](adr/README.md) for decisions.

```text
Iron Go.app (macOS)
├── Tauri/Rust host (src-tauri/src)
│   ├── main.rs           → workspace identity, dialogs, command registration
│   ├── workspace.rs      → tree, paths, UTF-8 files, atomic saves, project search
│   ├── workspace_disk.rs → bound directory identity, disk inspection, watch revisions
│   ├── tools.rs          → tool discovery, gofmt, process group ownership
│   ├── packages.rs       → cancellable Go module and run target discovery
│   ├── tasks.rs          → go run/build/test, bounded output and cancellation
│   ├── debug.rs          → Delve process, private DAP socket and teardown
│   ├── debug_program.rs  → executable build-to-Delve handoff and process ownership
│   ├── terminal.rs       → native PTYs, foreground retirement, output credits
│   ├── drafts.rs        → private crash snapshots, leases and retirement
│   ├── recent.rs        → recent root identities and bounded editor sessions
│   ├── workspace_files.rs → exclusive file moves and macOS Trash
│   ├── go_source.rs      → bounded offline toolchain and dependency reads
│   └── lsp.rs            → gopls stdio ⇄ Tauri IPC channels
└── TypeScript/Monaco workbench (src)
    ├── main.ts           → workbench assembly and user actions
    ├── workspace.ts      → native bridge and preview project adapter
    ├── project-model.ts  → pure tree, path, file navigation and search
    ├── run-targets.ts    → executable picker, test scope and advanced overrides
    ├── editor.ts         → theme, syntax, files and Monaco model lifetimes
    ├── feedback.ts       → bounded task output and feedback pane
    ├── debugger.ts       → gutter breakpoints and named-test DAP session
    ├── terminal-pane.ts  → xterm.js input, display and current-generation credits
    └── lsp.ts            → vscode-jsonrpc connection and Monaco providers
```

`go.mod`/`go.work` belong to Go; Iron Go does not rewrite an existing module
on open. Tauri commands and channels are the only production IPC. Untrusted
workspace names, source text, search results and output are text nodes.

The native host admits only the current workspace identity. Frontend
operations capture the current project or model and ignore stale results.
Processes and their channels have a single owner and are dropped on switch
or close. Tool absence degrades capabilities separately from file editing.

The acceptance fixture is `tests/fixtures/orbit`; automation only edits a copy.
It is not bundled into the application.
See [testing instructions](TESTING.md) for the feedback loop.

See the proposed [daily Go workbench plan](design/daily-go-workbench.md) for
the remaining workflows and their acceptance criteria.

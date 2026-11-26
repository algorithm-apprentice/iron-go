# Iron Go Architecture

Iron Go follows the macOS structure documented in `../iron-cpp/docs/ARCHITECTURE.md`.
It is a standalone application: the sibling repository is not required for
builds or tests. See [the ADR index](adr/README.md) for decisions.

```text
Iron Go.app (macOS)
├── Tauri/Rust host (src-tauri/src)
│   ├── main.rs           → workspace identity, dialogs, command registration
│   ├── workspace.rs      → tree, paths, UTF-8 files, atomic saves, project search
│   ├── tools.rs          → tool discovery, gofmt, process group ownership
│   ├── tasks.rs          → go run/build/test, bounded output and cancellation
│   └── lsp.rs            → gopls stdio ⇄ Tauri IPC channels
└── TypeScript/Monaco workbench (src)
    ├── main.ts           → workbench assembly and user actions
    ├── workspace.ts      → native bridge and preview project adapter
    ├── project-model.ts  → pure tree, path, search and run defaults
    ├── editor.ts         → theme, syntax, files and Monaco model lifetimes
    ├── feedback.ts       → bounded task output and feedback pane
    └── lsp.ts            → vscode-jsonrpc connection and Monaco providers
```

`go.mod`/`go.work` belong to Go; Iron Go does not rewrite an existing module
on open. Tauri commands and channels are the only production IPC. Untrusted
workspace names, source text, search results and output are text nodes.

The native host admits only the current workspace identity. Frontend
operations capture the current project or model and ignore stale results.
Processes and their channels have a single owner and are dropped on switch
or close. Tool absence degrades capabilities separately from file editing.

The acceptance fixture is `examples/orbit`; automation only edits a copy.
See [testing instructions](TESTING.md) for the feedback loop.

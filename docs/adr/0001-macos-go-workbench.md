# ADR 0001: macOS-first Go Workbench on Tauri and Monaco

Date: 2026-11-26.

Status: Accepted. Verification is tracked in the linked design.

Design: [First macOS Workbench](../design/macos-workbench.md).

## Context

Iron Go needs a focused VS Code-style IDE for Go. Iron C++ already has a
macOS Tauri 2 host, a Monaco workbench, and clear boundaries for workspace,
language server and execution lifetimes. CMake configuration, C++ indexing,
LLDB and breakpoint storage are not prerequisites for a Go editor.

## Decision

1. Ship for macOS only. Keep the Tauri 2 Rust host and TypeScript/Monaco UI
   pattern; share the architectural approach, not the C++ app's source tree.
2. Treat `go.mod` and `go.work` as Go's source of truth. Opening a folder
   unlocks editing independently of compiler and language-server readiness.
3. Use stock Go tools (`go`, `gofmt`, `gopls`), Tauri's native dialog and IPC,
   Monaco for editor mechanics and its built-in Go grammar, and `tempfile`
   for same-directory atomic saves. Reuse Microsoft's `vscode-jsonrpc` and
   `vscode-languageserver-types`; keep the app-specific IPC adapter and
   Monaco providers small. Use the same length-framed stdio boundary as
   Iron C++, not a local web server in production.
4. Make execution explicit with fixed `go run`, `go build`, `go test` verbs,
   relative package arguments, and a cancellable macOS process group. The
   first console is a bounded **Output** panel, not an interactive terminal.
5. The bundled Orbit sample is editable without a disk workspace. A browser
   preview demonstrates the same UI and can import a copy of a folder, but
   cannot run native tools or write back to local disk.

## Alternatives rejected

- Electron or a separate Go GUI stack: more divergence from the sibling
  app without improvement to first-version Go workflows.
- Porting all Iron C++ storage, PTY and debugger features: unrelated to the
  editing and test loop. Evaluate xterm.js, `portable-pty` and Delve/DAP when
  those features are designed, rather than inventing substitutes now.
- Monaco 0.57's bundled experimental LSP client: it initializes with a null
  root and has no public disposal method. A small public `vscode-jsonrpc`
  transport can scope a connection to one folder without monkey-patching
  Monaco or embedding the entire VS Code extension host.

## Consequences

A local Go installation is required for compilation and formatting; `gopls`
enables semantic features but is optional for editing. There is no Windows
or Linux support claim, no bundled Go toolchain, and no dependency on Iron
C++ binaries or data. The first release intentionally defers Delve, PTY input,
Git integration, and workspace persistence.

# Iron Go

Iron Go is a lightweight Go IDE for **macOS**. Its workbench takes cues from VS Code and follows Iron C++'s Tauri 2 and Monaco architecture. The Go toolchain owns module and workspace management.

## Quick start

Requirements: macOS 15 or later, Node.js 24 or later, stable Rust, Xcode Command Line Tools, and Go. Install the optional `gopls` language server for completion and other language services. Go 1.25 works with `gopls@v0.20.0`; with a newer Go toolchain, you can install `gopls@latest`.

```sh
npm ci
go install golang.org/x/tools/gopls@v0.20.0
npm run tauri dev
```

From the welcome screen, select **Open Project** to open a Go module or `go.work` workspace, or **New Project** to create a module. The editor toolbar selects the executable automatically if there is only one; otherwise, choose a run target. **Run and Test** builds or tests all local packages by default. You can also use the current package or enter a custom scope under **Advanced**. To return to the welcome screen, choose **Close Project** from the project menu or command palette.

For libraries without an executable package, the toolbar offers **Test** to run tests in the selected scope.

When launched from Finder, Iron Go also searches common tool locations, including Homebrew, the official Go installation path, and `~/go/bin`. Select the tool status in the bottom-right corner, then **Check tools**, to probe again.

## Features

- File tree, editor tabs, unsaved-change indicators, undo, save conflict protection, quick file navigation, and full-text search across saved files.
- Go syntax highlighting in Monaco. `gofmt` formats the current buffer without saving it.
- Dark and light themes, saved through **Settings → Color Theme** (`⌘,`).
- `gopls` completion, hover documentation, workspace definition navigation, and diagnostics in the Problems panel. Run a named test through its **Run Test** CodeLens or **Go: Run Test at Cursor** in the command palette.
- Go test debugging with Delve. Install it with `brew install delve` and probe for tools again in Settings. Set a breakpoint to the left of a Go line number or press `F9`, then use **Debug Test** or **Go: Debug Test at Cursor**. Continue, step over, and stop are supported.
- `go build`, `go run`, and `go test` with live output, exit status, and task cancellation. Run only trusted projects.
- Keyboard shortcuts: `⌘O` opens a project, `⌘P` opens a file, `⇧⌘P` opens the command palette, `⌘S` saves, `⇧⌘F` searches saved files, `⇧⌥F` formats, and `⌘↵` runs or stops a task. `⇧⌘[` and `⇧⌘]` cycle editors; `⌘B` and `⌘J` toggle the sidebar and bottom panel.

Delve debugging is limited to named Go tests. Iron Go does not support arbitrary process attachment, an interactive terminal, automatic file watching, or Windows. `npm run dev` starts a browser preview; it cannot run local Go tools or write back to imported folders.

## Build and test

```sh
npm run tauri build -- --bundles app  # Local .app; signing and notarization are not configured
npx playwright install chromium      # Install before the first UI test run
npm run test:feedback                # Unit, headless workbench, and native macOS acceptance tests
```

See the [testing guide](docs/TESTING.md) for individual test commands and failure artifacts. Write the design and acceptance criteria before implementation, then start with a failing regression test. See [AGENTS.md](AGENTS.md), the [architecture](docs/ARCHITECTURE.md), and the [architecture decision records](docs/adr/README.md).

## License

Iron Go source code is available under the [Apache License 2.0](LICENSE). Third-party dependencies retain their own licenses. Redistribution must comply with applicable third-party license and notice requirements.

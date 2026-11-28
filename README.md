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

**Open Recent** reopens a remembered project and restores available tabs, caret positions, and viewports. Iron Go always starts on Welcome.

For libraries without an executable package, the toolbar offers **Test** to run tests in the selected scope.

When launched from Finder, Iron Go also searches common tool locations, including Homebrew, the official Go installation path, and `~/go/bin`. The status bar shows the Go version. To probe again, open **Settings** and select **Check tools**.

## Features

- File tree, editor tabs, unsaved-change indicators, undo, save conflict protection, quick file navigation, and full-text search across saved files.
- **Save All** saves dirty tabs in order. When closing an unsaved tab, switching projects, or quitting, Iron Go offers to save or discard the edits; a failed save keeps the project open.
- Native file watching updates the project tree and reloads open files without unsaved edits. Changed, missing, or unreadable files are indicated without overwriting unsaved buffers. **Compare with Disk** shows both versions and can reload or save only against the reviewed disk file. **Refresh Project** also rechecks open files.
- **Save to a New Path** rescues a retained native buffer after deletion or another disk problem. It creates a new file without overwriting an existing destination.
- Explorer actions create folders, rename and move items without replacing destinations, and send items to the macOS Trash. **Recover Drafts** opens app-local crash snapshots as unsaved buffers; it does not write workspace files.
- Go syntax highlighting in Monaco. `gofmt` formats the current buffer without saving it. The optional **Format Go files on save** setting applies to explicit Save File and Save All; **Save Without Formatting** is available for a buffer that cannot be formatted.
- Dark and light themes, saved through **Settings → Color Theme** (`⌘,`).
- `gopls` completion, hover documentation, and diagnostics in Problems. **Go to Definition** (`F12`) opens editable workspace source or a read-only Go standard-library or cached dependency file. Run a named test through **Run Test** CodeLens or **Go: Run Test at Cursor**.
- **Go to Line** works without `gopls`. With `gopls`, **Go to Symbol in File** searches the current Go buffer, and **Find References** lists workspace locations using open unsaved buffers.
- **Go: Organize Imports** applies a `gopls` import edit to the current buffer as one undoable change. It does not save the file.
- Debug a Go test or **Debug Go Program** with Delve. Install it with `brew install delve` and probe again in Settings. Set a breakpoint in the gutter or with `F9`. Inspect the paused stack and variables, then continue, step over, step into, or step out.
- `go build`, `go run`, and `go test` with live output, exit status, and task cancellation. Run only trusted projects.
- **Run Configurations** saves a Go package, arguments, working directory, and optional environment overrides per native project. Use session-only overrides for values you do not want persisted.
- **Test Results** groups Go test outcomes and build failures, links to recognized failure locations, and can **Rerun Matching Name** using Go's test-name filter. Human-readable Go output remains in **Output**.
- **Start Shell** and **Run Go Program in Terminal** open an interactive PTY. The shell runs with your normal local permissions. Terminal I/O is separate from task Output.
- `⇧⌘E` focuses Explorer from the editor, and the visible feedback tabs support arrow navigation.
- Keyboard shortcuts: `⌘O` opens a project, `⌘P` opens a file, `⇧⌘P` opens the command palette, `⌘S` saves, `⇧⌘F` searches saved files, `⇧⌥F` formats, and `⌘↵` runs or stops a task. `⇧⌘[` and `⇧⌘]` cycle editors; `⌘B` and `⌘J` toggle the sidebar and bottom panel.

Iron Go supports macOS and local Delve launches. `npm run dev` starts a browser preview; it cannot run native tools, start a terminal, watch the filesystem, or write back to imported folders.

## Build and test

```sh
npm run tauri build -- --bundles app  # Local .app; signing and notarization are not configured
npx playwright install chromium      # Install before the first UI test run
npm run test:feedback                # Unit, headless workbench, and native macOS acceptance tests
```

See the [testing guide](docs/TESTING.md) for individual test commands and failure artifacts. Write the design and acceptance criteria before implementation, then start with a failing regression test. See [AGENTS.md](AGENTS.md), the [architecture](docs/ARCHITECTURE.md), and the [architecture decision records](docs/adr/README.md).

## License

Iron Go source code is available under the [Apache License 2.0](LICENSE). Third-party dependencies retain their own licenses. Redistribution must comply with applicable third-party license and notice requirements.

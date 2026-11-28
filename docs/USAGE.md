# Use Iron Go

## Open or create a project

Iron Go starts on Welcome. Select **Open Project** to open a Go module or
`go.work` workspace, or **New Project** to create a module. Both commands are
also in the macOS **File** menu. **File → Open Recent** reopens a remembered
project and restores available tabs, caret positions, and viewports.
**File → Close Project** returns to Welcome.

The status bar shows the Go version. Finder-launched builds search common
locations such as Homebrew, the official Go installation path, and `~/go/bin`
in addition to `PATH`. After adding or upgrading a tool, select **Check tools**
in **Settings**. See [Go tools](BUILDING.md#go-tools) for installation.

## Navigate and edit

- Use Explorer, **Go to File**, or **Search Saved Files** to open files. Search
  uses saved contents. **Go to Line** is available without `gopls`.
- After a jump, use **Go → Back** or **Go → Forward** to restore the previous
  caret, selection, and viewport. Cycling editors instead selects an open tab.
- With `gopls`, completion, hover, Problems, and semantic colors reflect the
  current Go buffer, including unsaved edits. **Go to Definition** can open
  editable workspace source or read-only Go standard-library or cached
  dependency source. **Go to Symbol in File** searches the current buffer;
  **Find References** lists workspace locations.
- **Organize Imports** applies one undoable edit to the current Go buffer.
  **Rename Go Symbol** previews changes before applying them to buffers.
- Use **Settings → Color Theme** to choose Dark or Light.

## Save, recover, and manage files

**Save All** saves dirty tabs in order. When closing an unsaved tab, switching
projects, or quitting, choose whether to save, discard, or cancel. A failed
save keeps the project open. **Format Go File** formats the buffer without
writing it. **Format Go files on save** applies to explicit Save File and
Save All; use **Save Without Formatting** if needed.

Native file watching updates the tree and reloads clean buffers. It flags
changed, missing, or unreadable files without overwriting unsaved edits. **Refresh Project**
rechecks open files. **Compare with Disk** shows the two versions and lets you
reload or save against the reviewed disk contents. **Save to a New Path**
rescues a retained buffer without replacing an existing destination.

Use Explorer to create folders, rename or move items without replacing
destinations, or send items to macOS Trash. **Recover Drafts** opens app-local
crash snapshots as unsaved buffers without writing to workspace files.

## Run, test, and debug Go

- The toolbar selects a sole executable automatically. If there are multiple
  targets, choose one. If there is no executable, the toolbar offers **Test**.
  In **Run and Test**, **Build and test** defaults to **All packages**. Choose
  **Current package**, or choose **Custom scope…** and enter the pattern in
  **Advanced → Custom build / test scope**.
- **Run Configurations** saves a package, arguments, working directory, and
  optional environment overrides per native project. Use session-only
  overrides for values you do not want persisted.
- Run a named test from **Run Test** above its declaration or use **Go: Run
  Test at Cursor** from the command palette. **Test Results** groups outcomes
  and build failures, links to recognized failure locations, and offers
  **Rerun Matching Name**. **Output** retains human-readable Go output and exit
  status. Stop a running Go task from the toolbar or the **Run** menu.
- With Delve, debug a named test or use **Debug Go Program** for the selected
  executable. Set a breakpoint in the gutter, inspect the paused stack and
  variables, and continue, step over, step into, or step out. Iron Go supports
  local Delve launches.
- **Start Shell** and **Run Go Program in Terminal** open an interactive
  terminal separate from task Output. Go tasks and the shell run with your
  normal local permissions. Run only trusted projects.

## Keyboard shortcuts

| Workbench action | macOS shortcut |
| --- | --- |
| New Project / Open Project | `⌘N` / `⌘O` |
| Settings | `⌘,` |
| Go to File / Command Palette | `⌘P` / `⇧⌘P` |
| Back / Forward | `⌃-` / `⌃⇧-` |
| Previous / Next Editor | `⇧⌘[` / `⇧⌘]` |
| Go to Definition / Toggle Breakpoint | `F12` / `F9` |
| Save File / Format Go File | `⌘S` / `⇧⌥F` |
| Focus Explorer / Search Saved Files | `⇧⌘E` / `⇧⌘F` |
| Toggle Side Bar / Toggle Bottom Panel | `⌘B` / `⌘J` |
| Run or stop a task | `⌘↵` |

Use the arrow keys to navigate visible Explorer items and feedback tabs.

## Browser preview

The [development preview](BUILDING.md#run-from-source) imports a copy of a
folder. It cannot write back to that folder, watch native filesystem changes,
or launch Go tools, Delve, or a terminal. Use the macOS app for those workflows.

# GoLand-inspired Run and Test

Status: Implemented and verified on macOS.

## Scope and invariants

Keep the VS Code workbench layout. Follow GoLand for common Go actions:
choose a runnable target, then run it; launch tests from the editor or the
workspace without first learning Go CLI arguments.

- Ask the Go toolchain for saved workspace metadata using `go list -m -json`
  and `go list -e -find -json`. Use the active module/workspace context and
  ignore packages outside the selected folder. Discovery must not compile
  or execute workspace code, and must not block editing or starting gopls.
- Auto-select a sole executable package. For multiple executables, offer a
  picker and do not silently run the first. Preserve an explicit selection on
  refresh when it still exists. Display a name with the package path as detail.
- After a successful scan that finds no executable, make **Test** the primary
  toolbar action. Do not send library learners to an empty Run picker. A
  failed/pending scan is not evidence that the project is a library, and
  choosing a custom run target keeps the primary action as Run.
- Build and Test offer **All packages** and **Current package**. An explicit
  custom scope preserves relative CLI patterns. Discovery failure leaves a
  manual package-path fallback under Advanced; even advanced paths are validated
  before calling Go. All packages in a Go workspace uses the local module scopes.
- In a `_test.go` editor, show a Run Test action above Go test functions when
  `gopls` provides their document symbols. Use Monaco's public CodeLens API,
  not line-matching or a new parser. Start the existing process lifecycle with
  an exact `go test -run` filter; save dirty files before execution as before.
  Package-level testing still works without `gopls`.

Non-goals: cloning GoLand's layout, Delve, persisted launch configurations,
program arguments/environment overrides, and a structured test result tree.

## Acceptance

- Native disposable module: the only executable is detected without typing.
  After adding another `package main` in a file not named `main.go`, reopening
  shows both targets and no default. Select the second, run it and stop it.
- Native: Build and Run Tests use the All packages default. Open a file with
  two test functions, click one CodeLens, and verify only that test executed.
- Rust: discover runnable packages with arbitrary Go filenames in a module and
  in an on-disk `go.work`. Package arguments remain relative to the open folder.
- Native regression: a library-shaped fixture has a Test toolbar action and
  runs its real package tests. An opt-in external project smoke opens a clean
  Git snapshot, exercises the module and toolchain through the same app, and
  never executes tests in the original checkout.
- Browser: the preview renders the selector and doesn't run native commands.

`npm run test:feedback` passed, including nine native acceptance scenarios.
The focused Go metadata tests include a multi-module workspace with an
out-of-folder module. Native acceptance opens a real two-target module,
stops the selected program, and verifies a CodeLens click runs only the
named test. The normal `.app` bundle also built.

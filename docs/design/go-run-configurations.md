# Named Go run configurations

Status: Implemented first slice of [Run configurations and test results](daily-go-workbench.md#3-run-configurations-and-test-results).

## Scope and user workflow

- Add **Run Configurations** to Run and Test and expose saved configurations in
  the existing Run Target picker. A named configuration specifies an executable
  package, ordered program arguments, a workspace-relative working directory,
  and environment overrides. Selecting an ordinary package keeps the current
  Run behavior. Selecting a configuration launches its package regardless of
  the active file. Build and Test scopes are unchanged.
- The settings dialog can create, edit, select, and delete configurations for
  the current native project. Use a JSON string array for arguments so spaces,
  empty strings, quotes, and leading flags are representable without shell
  syntax. Use separate fields for persistent and session-only environment
  overrides, one `NAME=value` assignment per line; preserve `=` and whitespace
  in values. A session-only entry wins over a persistent entry with the same
  name. Never include override values or program arguments in application
  status, command summaries, or validation errors. The launched program may
  print its own environment or arguments.
- Store bounded, versioned configurations in WKWebView local preferences,
  under an `irongo.runConfigurations` project key derived from the canonical
  path. Persist the ID, name, package, argv, directory, persistent overrides,
  and selection. Label saved argv and persistent overrides as ordinary local
  preferences and direct secrets to the session-only field. Nothing is written
  into the workspace. Session-only overrides are held separately in memory
  by canonical project path and configuration ID; deleting a configuration
  drops them, and app restart clears them. A saved configuration does
  not run on open. Deleting the selected configuration returns to the
  ordinary package selector. Malformed stored values are ignored. If a local
  preference write fails, report it and keep the previous configuration and
  session overrides rather than presenting a save that will not survive reload.

## Native launch and ownership

- Revalidate package, working-directory path, argument and environment sizes
  and syntax in Rust. Accept only one executable relative package and a real
  directory inside the admitted workspace, with no symlink traversal. No
  user-provided executable or shell command is accepted. Pass argument strings
  to the program directly and environment values only to that program.
- A configured launch builds the package from the workspace root with
  `go build -o` into an app-owned private temporary directory. If successful,
  run that binary with the configured directory, argv, and environment.
  Verify the build product is a regular executable Mach-O binary before
  attempting to launch it; a package archive is not executable. Reopen the
  working directory through the admitted RootAnchor immediately before
  launching and bind the child to that directory descriptor via `fchdir`,
  without relying on a path previously verified during the build. The
  program's directory and overrides must not change the Go build context.
  Unconfigured Run keeps `go run` and existing output. A build/spawn failure
  emits one terminal result and the executable directory is retired.
- The build and executable share one native task ID, one cancellation signal
  and one bounded output budget. Emit **Started** at build admission and one
  **Finished** for the whole admitted task. The Stop latch remains effective
  after a phase's leader exits, including while its output is drained. Hold
  the session mutex across workspace/task identity checks, the latched Stop
  check, executable spawn, and publication of its live group. If Stop or
  cutover wins, no executable can spawn; if admission wins, Stop can signal
  the newly published group immediately. When the executable leader exits
  first, retire its same-group descendants while the unreaped leader still
  reserves the identity, and observe their disappearance before completion.
  The worker retires the temporary
  directory on success, failure, cancellation and cutover while the app is
  alive. Keep an independent cleanup registry until each worker retires its
  directory. Ordinary app exit synchronously signals the live group and
  attempts to remove registered directories, including ones whose task slots
  were already retired; forced exit cannot guarantee cleanup.
  Keep the renderer save barrier and lane ownership from
  [ADR 0010](../adr/0010-workbench-workflow-ownership.md).
- Structured test results, terminal input, and executable debugging follow
  in separate slices. This slice keeps stdout/stderr and the current Stop
  button as the normal interface; the binary launch is reusable by Debug later.

## Alternatives

- `go run` with argv works for simple overrides but couples both phases to
  the same environment and directory. `go run -exec` with a shell wrapper
  introduces quoting/process ownership; build and run explicitly instead.
- Do not add a repository configuration format before the local workflow is
  proven. Local presets prevent an opened repository from supplying a command.

## Acceptance

- In a disposable `go.work` workspace, save a configuration for a nested
  main package and run it with its working directory elsewhere in the root.
  Verify exact argv (including empty and whitespace-bearing strings) and env
  values in the real program without exposing them in the launcher summary.
  Set a runtime `GOWORK` value that would break package resolution if it were
  inherited by the build. Launch through the ordinary Run button with a
  different editor file active.
- Reopen the same fixture in a new native app process with the same disposable
  profile. The configuration and selection return, session-only overrides
  do not. Inspect the preference record for a synthetic session-only sentinel
  and verify it was never persisted. The `go` group owns both sequential
  processes; only its second phase reuses the first phase's workspace and home,
  after the first app's cleanup has been verified. Open a different project
  and verify settings remain scoped.
- At an acceptance-only successful-build barrier, separately exercise Stop
  and project cutover. Assert no executable start marker, no old results in
  the new project, and the temporary directory's removal. During live binary
  Stop, verify that the binary and a same-group child have both exited.
- Check a build failure, a library archive, and a working directory replaced
  with a symlink during the build. None may launch an executable, and each
  admitted task emits exactly one terminal result. Invalid host arguments
  and a preexisting symlink working directory do not acquire a task.

## Verification

- The first native Go regression failed because Run Configurations was
  missing. The final full feedback run passed all 39 browser cases and every
  native group, including two distinct Go app processes sharing one disposable
  workspace and preference profile (`test-results/native/1795808472981-93004`).
- The native cases verify argument preservation, build/runtime environment
  isolation, live process-group cancellation, Stop and project cutover during
  the build-to-run handoff, launch markers, shutdown cleanup, invalid settings,
  and persistent versus session-only preferences across restart. The Rust
  unit regression covers Stop after a reaped leader leaves pipes open.

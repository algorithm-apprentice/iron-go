# Debug the selected executable package

Status: Implemented second slice of [debug inspection and executable launch](../archive/daily-go-workbench.md#4-debug-inspection-and-executable-launch).

## Scope and invariants

- Add **Debug Go Program** for the selected executable target. Snapshot the
  applicable run configuration at admission and use the same save barrier and
  execution lane as Run and Debug Test. Require an unambiguous executable
  package and validate its literal selector, directory, arguments, and
  environment with the existing native Run validation.
- Compile a debuggable binary (`go build -gcflags=all=-N -l`, passing the
  flags as one argument) from the admitted workspace root. Use the same
  workspace and Go tool environment as Run; the program-only environment
  never reaches package discovery, compilation, or the Delve server start.
  Debug without a preset has the same program context as default Run: the
  workspace root, no extra arguments, and inherited environment.
- Keep the working directory, binary, and package separate. Native code
  builds into the private Delve directory. At admission retain an anchored
  handle to the program directory; at handoff reopen via the root anchor and
  compare device and inode. Refuse replacement even by a real directory.
  Spawn Delve using `fchdir` on the bound handle, use the absolute private
  binary path and `cwd: "."` in DAP `launch` in `exec` mode, and omit `dlvCwd`.
  Do not let a second resolution of the original path select the inferior's
  directory. Verify the actual inferior's working directory and relative I/O.
- Reuse Rust's bounded task supervision during the build. The native task
  slot holds a debug-specific launch identity until a successful atomic
  transfer to the Delve slot. Each phase's process group has one native
  owner. Stop uses that launch identity and can cancel the build, the
  handoff, or the active Delve session without hitting a replacement launch.
  Retain a native reservation independent of the two phase slots until the
  worker has reaped its process and closed the registered temporary directory.
  Reject new native execution while that reservation remains, even if a new
  workspace is already visible. For a live adapter, the native transport asks
  Delve to disconnect and terminate the debuggee; bound the grace interval and
  fall back to killing the owned group. Switch signals retirement and ordinary
  Quit waits asynchronously for retirement before asking AppKit to terminate.
  A timed-out cleanup leaves the worker tracked and the app open, with a
  visible failure. Keep watching for the observed inferior/backend exit and
  retry private-directory removal after they exit. A later Stop or Quit can
  wait again. Never signal a bare PID obtained from an old DAP event. Release
  the reservation only when the owned group, observed inferior, and private
  directory have retired. Existing named-test ownership is separate from the
  executable startup reservation.
- Keep the private Unix-socket DAP session and ordinary frame inspection,
  breakpoint, Step, Continue, and Stop behaviors. Named-test launch is
  unchanged. Build and launch failures provide bounded diagnostics without
  launching or leaving a stale inferior behind.
- Capture the same merged preset as Run before saving. Supply program
  overrides only after the Delve server is started; Delve applies DAP `env`
  to its backend for inferior startup. Preserve the app's inherited PATH
  rather than leaking temporary tool-discovery augmentation. Default `go run`
  inherits the augmented Go tool PATH; no-preset parity covers cwd, argv, and
  ordinary program environment rather than this PATH difference or Delve's
  debugger-specific settings (for example `GODEBUG` adjustments).
  Use `outputMode: "remote"` to carry program stdio to Feedback. Diagnostic
  rows must not echo config arguments or environment override values.

## Alternatives

- Do not pass the program environment to Delve's `debug` build mode. The
  debugger's own build would combine the package-resolution and program
  environments. Building in Rust keeps parity with configured Go Run.
- Do not implement the build as a separate user task followed by an
  unreserved asynchronous launch. It would leave a gap where another task
  could start or the workspace could change.

## Acceptance

- In a disposable real `go.work` workspace, select a main package from a
  nested module and a different program working directory. Reuse a named
  preset with args (including spaces and an empty argument) and a
  session-only environment override that would break package resolution if
  applied to the build. Keep a different file active. Have the actual Go
  program report argv, selected env, cwd and PID, and write a relative marker.
  Run and Debug must emit equivalent program context. Also cover no preset.
- Set a breakpoint in the main package, inspect a local on pause, continue
  to exit, then prove the debugger and temporary binary are gone.
- Hold the build-to-debug handoff deterministically. Exercise Stop and
  project switch around handoff; reject a new real directory at the same path,
  prove no
  obsolete launch or stale feedback, and admit a fresh task. A compile
  failure must leave no debugger or temporary binary. After handoff, exercise
  Stop and ordinary Quit; check the real adapter and inferior PIDs and removal
  of the private directory. Withhold graceful native disconnect in one live
  Stop acceptance case, verify forced fallback and that the actual inferior
  and backend are gone before fresh execution is admitted. Keep existing
  native named-test coverage.
- Run `npm run check`, relevant Chromium launch-state tests, and
  `npm run test:native -- --group debug --require-delve`.

## Verification

- The first native executable fixture reached the program through Run and
  failed at the missing Debug command (`test-results/native/1795837587218-32643`).
- The final native Debug run passed preset and no-preset context parity,
  breakpoint and locals, compile failure, Stop and switch at handoff, real
  inode replacement refusal, natural exit with a same-group descendant,
  forced Stop, and ordinary Quit (`test-results/native/1795838560365-39328`).
  macOS debugserver puts the inferior in a separate process group; binding a
  native child to that group keeps its identity reserved through cleanup.
- The Rust gate exercised framing with Stop during a partial write and a late
  inferior event. The Chromium suite passed 44 cases, including no adapter
  launch or lane release on a build Stop with readiness still in flight.
  Independent re-review approved the final executable-debug teardown.

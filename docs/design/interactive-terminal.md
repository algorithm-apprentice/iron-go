# Interactive terminal and Go Run

Status: Implemented slice of [the daily workbench](../archive/daily-go-workbench.md#6-interactive-terminal).

## Scope and invariants

- Provide one explicit **Terminal** pane per workbench with **Start Shell**,
  **Run Go Program in Terminal**, and **Close Terminal**. A shell starts in
  the workspace by default and has the user's ordinary local permissions.
  It is not sandboxed. A shell can coexist with an ordinary Go task; an
  interactive Go Run uses the same exclusive Go lane and save barrier as Run.
  Reuse configured package, arguments, working directory and environment.
  Use the renderer execution token during save, then one native launch ID
  and cancellation latch for both slots through build, PTY publication, and
  cleanup. A shell owns only the terminal slot. Bind cwd by descriptor at
  admission and recheck device/inode at handoff; the final Stop/workspace
  check, child spawn, and publication are one serialized operation. Keep both reservations
  until the program, PTY, and private binary directory retire.
- Use xterm.js for VT parsing, input, and resize. Keep read-only Task Output
  as its own pane. Native macOS owns the PTY and foreground job; open a PTY,
  bind the child to its admitted working directory, start it in a new
  controlling-terminal session, and connect stdin/out/err to the slave.
  Start only explicit user-selected commands; browser preview exposes no PTY.
- Keep bounded input, output credits, and scrollback: at most 64 KiB pending
  input and unacknowledged output per terminal and 2000 scrollback lines.
  Count raw bytes across the native buffer, IPC and pending `xterm.write`
  under one credit budget. A write completion callback returns its chunk's
  credit once, scoped to the terminal generation; abandon old-generation
  credit on renderer teardown. Stop and resize are independent of stream
  backpressure.
- Ctrl-C is terminal input to the live foreground process. On Close, switch
  or Quit retire the existing terminal before starting a replacement. Rust
  uses Darwin `TIOCSIG` on the owned master to signal its currently bound
  foreground job, rather than looking up and signaling a numeric PGID.
  Observe the foreground group before signaling, and track positively
  identified processes by PID and birth identity for observation only. The
  observation and signal are not atomic. Use SIGHUP and bounded grace, then SIGKILL through the
  still-owned PTY if necessary. Observe subsequent foreground changes and
  retain unresolved identities if the leader exits first. Signaling alone
  does not prove exit. Retire the leader's own group while its child handle
  still reserves that identity, then reap it and close the PTY. Keep a
  cleanup record until the observed foreground identities and native
  handles are gone. If observation is incomplete or ambiguous, keep the
  cleanup record and report that retirement could not be confirmed; do not
  free the slot or send a real signal to a bare observed PID.
  The disposable probe confirmed `TIOCSIG` targets the current foreground
  even when it differs from the term leader. Background jobs and detached
  descendants are outside the foreground teardown guarantee.
- Confirm project switch or Close Terminal when a shell or interactive
  program is still active. A cancelled chooser or rejected save preserves
  the terminal. After a successful selection, fence new native admissions
  while waiting for retirement; recheck the selected workspace's anchor at
  cutover. A failed cleanup stays tracked and visibly blocks reuse of the
  slot and project cutover. App Quit rechecks its ticket before teardown,
  fences new admissions until the AppKit retry, and rechecks the ticket
  before approval. It waits boundedly off the main thread. Refusal releases
  the admission fence while unresolved cleanup stays tracked.

## Alternatives

- Keep the standard xterm renderer and native `openpty` rather than implementing
  escape parsing or a terminal within Monaco. Use a standard PTY crate instead
  if it exposes ownership, resize and native foreground signaling without
  hiding the process reaping policy.
- Keep the configured Go build outside program-only environment overrides,
  and hand the built executable off to an already reserved PTY. Do not pipe
  an ordinary Task Output command through a fake stdin field.

## Acceptance

- Use real disposable shell and Go fixtures to send text, read ANSI and
  UTF-8 output, resize a live PTY, and send Ctrl-C to a foreground job.
  Verify that ordinary Task Output is still independent.
- Stop, switch and Quit with a live foreground job; identify the fixture
  leader and actual foreground process, and verify they exit before reuse.
  Change foreground or exit the leader before cleanup and verify unresolved
  foreground observations keep the slot reserved.
  Hold the renderer's acknowledgement until its full byte budget is occupied;
  exercise resize and Stop, then release a late acknowledgement after opening
  a different terminal. The retired callback cannot credit the new terminal.
  Cover shell/Go-task coexistence, native Go exclusion during both phases,
  and cleanup timeout leaving the workbench open and the slot still tracked.
- Compare Run and Run in Terminal in a disposable `go.work` workspace with
  a different configured cwd, literal args and a program-only environment.
  Hold and cancel the build before the PTY handoff; reject a replaced
  working directory and never publish stale output to a later pane.

## Verification

- The first native terminal regression failed at the missing Start Shell
  command (`test-results/native/1795841848246-48631`). The Terminal group
  later passed real shell I/O, UTF-8, kernel resize, Ctrl-C, ordinary Go Run
  alongside a shell, full raw-output credit, stale acknowledgement rejection,
  and a surviving foreground process after leader exit. It also verified a
  held Go build, real stdin and configured runtime, canceled and committed
  project switch, and actual AppKit Quit (`test-results/native/1795843623671-53749`,
  Terminal group).

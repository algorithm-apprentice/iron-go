# Delve test debugging on macOS

Status: Implemented for named Go tests; see the native acceptance gate.

The first debug workflow targets learning Go libraries such as Raft. Provide
gutter breakpoints and a **Debug Test** action alongside Run Test. Ship no
debug marker that cannot be exercised by the real debugger in acceptance.

- Discover the separately installed `dlv` tool as for `go` and `gopls`.
  Tell the user when Delve is missing. Do not install it or change macOS
  developer permissions automatically.
- Run Delve DAP through a private, session-owned Unix socket; no
  arbitrary attach target or public listener. Validate the selected Go
  package under the open workspace. Save dirty tabs before debugging; never
  start if a save fails. A debug session and a Go tool task share one lane.
- Synchronize editor breakpoints through DAP, distinguish pending from
  verified stops, and show the actual stopped frame. Minimum session
  controls: Continue, Step Over, Stop. Closing/switching project tears down
  Delve and the debuggee. Breakpoints are project-session state, not persistent
  settings in the first version.
- Verify a named test really pauses on an executable line in the native
  workbench, then step or continue. Use a disposable fixture with Delve and
  the user's Raft checkout only via an isolated snapshot.

Not in scope: attach to arbitrary processes, remote debugging, watch
expressions, debug console input, and persistence or shareable configurations.

Verification: the native gate stopped at line 9 of the Orbit fixture, stepped
over and continued to exit. The real-project gate stopped inside Raft's
`TestLeaderElection` and continued the test. The developer acceptance used
Delve 1.27.2 against Go 1.27.4.

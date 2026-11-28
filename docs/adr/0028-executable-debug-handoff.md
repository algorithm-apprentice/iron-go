# ADR 0028: Give executable debug one native launch identity

Status: Accepted. This extends [ADR 0007](0007-delve-test-debugging.md). See the
[executable debug design](../design/debug-go-program.md).

Build the selected target in Rust's Go task lane from the workspace root.
Hold the native reservation during handoff to private Delve and through
cleanup. Bind Delve to the verified program directory; pass program-only
arguments and overrides to its `exec` launch after the Go build. Stop and
Quit keep process identity reserved until the adapter, inferior groups,
and private directory retire. Never send a real signal to a bare DAP PID.

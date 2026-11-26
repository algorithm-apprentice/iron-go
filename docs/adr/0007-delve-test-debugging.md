# ADR 0007: Delve DAP for Named Go Tests

Status: Accepted.

Design: [Delve test debugging on macOS](../design/delve-test-debugging.md).

Go language services and debugging are separate. Continue using gopls for
editor intelligence and use the separately installed Delve debugger for
named Go tests. Reuse the app's length-framed JSON transport and process
ownership. Delve dials a private Unix socket, with its compiled test binary
stored alongside that socket in a disposable directory. No information is
written back into the repository during debug launch.

Start with gutter breakpoints and a real stop, step over, continue, and stop
workflow. Do not expose arbitrary process attach, an evaluation console, or
an unauthenticated network listener. Keep the Go task lane exclusive while
debugging. Validate the first release with real child debugging on macOS,
including a project-scale test rather than only a mock DAP endpoint.

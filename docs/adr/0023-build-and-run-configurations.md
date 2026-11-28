# ADR 0023: Build and run configured Go executables under one task owner

Status: Independently reviewed design. See [named Go run configurations](../design/go-run-configurations.md).

Persist named configurations by workspace in app-local preferences, separate
from session-only environment overrides. Build configured programs in the Go
workspace context and execute only a verified native binary. Apply program
arguments, environment, and working directory only to that executable, with
its directory bound to a native descriptor.

Keep one task ID and cancellation latch through the build-to-run handoff.
Check ownership and Stop, spawn, and publish the new group under one session
lock. Keep temporary executable cleanup reachable after task retirement.

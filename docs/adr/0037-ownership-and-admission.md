# ADR 0037: Put admission and completion under one operation owner

Status: Accepted design.

Design: [Architecture review follow-up](../design/architecture-follow-up.md).

Keep the Rust/TypeScript boundary from [ADR 0010](0010-workbench-workflow-ownership.md).
Rust reservations keep native ownership across slow I/O without holding the
shared session mutex during that work. Revalidate identities and cancellation
at commit, and keep child spawn and publication atomic. Retain the existing
cross-process Save lock for cooperative filesystem operations.

Record irreversible effects separately from successful cutover. Terminal
retirement is bounded and explicitly reports unresolved cleanup; absence of
proof cannot release the old slot under [ADR 0031](0031-native-terminal-ownership.md).
Share configured launch validation before handoff while leaving each runtime
responsible for its own teardown.

The workbench derives action eligibility from one policy across surfaces.
Each asynchronous result belongs to the narrowest owner that can still apply
it. Native acceptance verifies critical case identities per execution phase,
before merging, following [ADR 0036](0036-native-acceptance-report-completeness.md).

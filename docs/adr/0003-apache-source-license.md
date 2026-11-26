# ADR 0003: Retain Apache-2.0 for Iron Go Source

Date: 2026-11-26.

Status: Accepted.

## Context

The initial repository already contains Apache License 2.0. Iron Go uses
established open-source tooling and should remain easy to use, modify, and
integrate in educational, personal, and commercial settings.

## Decision

Retain the existing [Apache-2.0 license](../../LICENSE). This permissive
license also includes an explicit contributor patent grant. Declare its SPDX
identifier in the npm and Cargo manifests. MIT would be simpler but would
not add the same explicit patent grant; strong copyleft is not a goal here.

## Consequences

This governs Iron Go's code, not its dependencies. Preserve each third-party
component's applicable license and notices when redistributing a bundled
application. Dependency notice review is separate from selecting the source
license; this ADR does not certify a future binary distribution.

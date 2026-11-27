# ADR 0014: Bundle JetBrains Mono as the editor default

Date: 2026-11-28.

Status: Accepted.

Design: [Editor typography](../design/editor-typography.md).

## Decision

Bundle JetBrains Mono and its SIL Open Font License with the frontend. Use it
as Monaco's default with the system monospace stack as a fallback and a user
option. Store font and size as app-wide preferences and apply them to Monaco.

## Rationale and consequences

A local webfont makes the default consistent and available offline in the
native app and browser preview. Keeping user preferences in the workbench
allows independent code sizing without changing the rest of the interface.
Font upgrades must retain the upstream license and verify Monaco's metrics
after the replacement face loads.

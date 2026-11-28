# ADR 0036: Verify critical native case results by phase

Status: Accepted design.

Design: [Focused regression coverage](../design/focused-regression-coverage.md).

The native acceptance runner validates named critical Go cases for the initial
app and relaunch independently. A worker exit and a passing case alone cannot
prove that a phase exercised its critical scenarios. Optional tool coverage
must be recorded as explicit skips consistent with the worker's independent
capability probe. When a tool is present or required, the dependent cases must
pass. Preserve the existing failure and cleanup evidence.

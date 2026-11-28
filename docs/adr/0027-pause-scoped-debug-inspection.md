# ADR 0027: Bind debug inspection to a pause and frame selection

Status: Accepted. See [the inspection design](../design/debug-inspection.md).

Keep the Delve session and native ownership from ADR 0007. Scope stack frames
to a single stop, and scope variables and source reveals to the selected
frame in that stop. Pause controls are available without waiting for
inspection. Bound and load the inspection tree incrementally; clear it when
execution resumes or shutdown begins, before releasing the process lane.

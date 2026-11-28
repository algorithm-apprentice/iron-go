# ADR 0009: Make saves conditional on the observed file

Status: Independently approved design. Implementation verification is tracked in
[remediation batch 2](../archive/review-remediation-plan.md#2-define-and-harden-savereload-transactions).

Keep same-directory atomic replacement from [ADR 0001](0001-macos-go-workbench.md).
Stage, validate and replace under one stable OS advisory lock in the app-local
data directory. The reserved staging path is not a user file; verify that it
still names the opened temporary file before committing and only remove the
name on failure if it still names that owned file. Every save
in that app profile uses the lock. Never truncate, replace, or delete its
inode; deny saves targeting the lock by identity even when a workspace
contains it. Lock or validation failure refuses the save.

This coordinates cooperating Iron Go writers. It is not a filesystem
compare-and-swap against external writers, nor a power-loss durability
promise. Process-local mutexes cannot provide the cross-process guarantee;
maintaining backups or exchanging files would need a separate recovery design.

The editor applies asynchronous file results only to their captured live
document. A save advances its disk baseline without rolling back newer typing;
superseded reload/format results and their errors cannot affect the current UI.

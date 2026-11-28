# ADR 0029: Persist recovery and recent editor state separately

Status: Accepted. See [crash drafts](../design/crash-drafts.md) and
[recent projects](../design/recent-projects.md).

Keep immutable recovery payloads behind a private per-writer index and lease.
A recovery buffer retains its expected disk identity until explicit review
or a guarded Save. Recent editor views store no source bytes and update only
the current incarnation of a remembered project. Neither store implicitly
opens a project at startup.

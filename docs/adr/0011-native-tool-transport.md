# ADR 0011: Share the native Go tool transport

Status: Independently approved design. Verification is tracked in
[remediation batch 4](../archive/review-remediation-plan.md#4-share-native-process-plumbing-not-protocols).

Use one native worker for bounded framing, child/group ownership and session
retirement. gopls remains on stdio; Delve still connects to a socket in an
owner-only directory. LSP initialization and DAP semantics stay independent.

Serialize group signaling with leader reaping. Explicit Stop, workspace
cutover and app exit can signal a still-live group synchronously. After
natural leader exit, do not signal the old numeric group ID; any remaining
descendants are outside that guarantee. Retirement uses the tool kind and
server ID and reports once to the original channel.

Drain readable final frames within one bounded interval after leader exit or
writer closure, preserving partially read state. Cancellation and the drain
deadline take priority over subsequent messages.

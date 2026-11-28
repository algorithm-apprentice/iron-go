# ADR 0008: Guard ordinary macOS Quit before termination

Status: Revised after code review and independently approved for implementation.

Design and acceptance: [Code review remediation, batch 1](../archive/review-remediation-plan.md#1-protect-ordinary-application-exit).

macOS menu and system Quit use AppKit `terminate:`. On the pinned Tauri/Tao
runtime, the resulting `RunEvent::Exit` is too late to protect unsaved edits.
Add the missing public `applicationShouldTerminate:` to the existing Tao
delegate rather than replacing that delegate or an existing method. Route
native main-window close through the same AppKit path before destruction.

Cancel the first native Quit synchronously and ask through an app-owned
confirmation dialog, not Wry's unavailable `window.confirm`. The renderer
owns the dirty check and choice to discard; the host owns an expiring decision
ticket and one-shot approval for an immediate native retry. No AppKit modal
termination loop waits for renderer input. Defer the retry out of Tao's
dispatcher. Declining a quit preserves the window, edits and running children.
Forced termination or an OS crash remains outside this guarantee.

Only a pending dirty Quit can request that AppKit present the confirmation
window. Restore a minimized window or unhide the application for that choice;
clean Quit and refused busy Quit do not bring the workbench forward.

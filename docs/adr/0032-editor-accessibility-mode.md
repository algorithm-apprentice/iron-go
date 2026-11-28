# ADR 0032: Use Monaco screen-reader modes in the native editor

Status: Deferred. The decision below records the earlier design; the current
[personal-use scope](../design/workbench-accessibility.md) retains keyboard
navigation and the existing Monaco input configuration.

Default to Monaco Auto and allow an explicit mode choice. Keep WKWebView
input on Monaco's textarea path, and preserve the model when the mode
changes. Use the existing Explorer shortcut for keyboard exit from Monaco.
Keep native keyboard and AX evidence distinct from real VoiceOver output.

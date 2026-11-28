# ADR 0031: Own terminal sessions and output credit in Rust

Status: Accepted. See [interactive terminal](../design/interactive-terminal.md).

Use a macOS PTY and xterm.js in the workbench. A shell reserves one terminal
slot; a terminal Go program also reserves the exclusive Go execution lane
through build, spawn, and cleanup. Bound native and renderer input and
output. Only the matching terminal generation can return output credit.
Signal the kernel-bound foreground group through the owned PTY and require
proof of observed foreground and leader retirement before reusing the slot.

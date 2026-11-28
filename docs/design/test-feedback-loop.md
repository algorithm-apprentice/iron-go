# Autonomous Testing Feedback Loop

Date: 2026-11-26.

Status: Implemented and verified locally on Apple Silicon macOS.

Decision: [ADR 0002](../adr/0002-test-feedback-loop.md).

See the [testing guide](../TESTING.md) for current commands, required tools,
and failure artifacts. The initial design separated three layers so that a
failure can be investigated at the lowest layer that exercises the boundary:

1. **Focused:** verify file, process, and workbench state rules without a GUI.
2. **Headless UI:** exercise accessible controls and workbench wiring in an
   isolated browser context with built assets.
3. **Native:** drive the real WKWebView and Tauri bridge with embedded macOS
   WebDriver. Route Open Folder to a disposable workspace and use a test-only
   Monaco adapter for deterministic editing and inspection.

Later changes added [parallel execution and teardown rules](feedback-test-efficiency.md)
and [case-level verification of Go reports](focused-regression-coverage.md).

## Test-only isolation

The separate Tauri config has a distinct identifier, binary name, and frontend output.
The WebDriver library is an optional Rust dependency restricted to debug
builds, and only starts upon explicit fixture and port configuration. The
tiny frontend Monaco adapter is compiled only with `VITE_IRON_E2E=1`.
Production build invocations set neither. No development server or
automation listener is necessary to use a shipped app.

## Initial verification

2026-11-26: the initial headless suite exposed the missing workbench; the
native runner retained a build log when the main entry point was not yet
implemented. During acceptance, a missing native test command trigger was isolated
from working gopls hover via the screenshot and report. After switching the
test adapter to Monaco's public `trigger`, `npm run test:feedback` passed
all focused checks, three Playwright cases, and seven real native cases
with no LSP skip.

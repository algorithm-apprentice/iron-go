# Autonomous Testing Feedback Loop

Date: 2026-11-26.

Status: Implemented and verified locally on Apple Silicon macOS.

Decision: [ADR 0002](../adr/0002-test-feedback-loop.md).

## 1. Layers and completion criteria

1. Focused: TypeScript checks, pure project/tree/search behavior, Rust file and
   process tests, and `go test` in `tests/fixtures/orbit`. Runs without a GUI.
2. Headless UI: launch a private Vite server on an ephemeral port and exercise
   accessible workbench controls in Playwright. Each test uses fresh browser
   storage. Store a screenshot, trace and browser log on failure.
3. Native: use a debug-only Tauri config and embedded macOS WebDriver, not a
   mock invoke layer. Copy the real Go fixture to a unique temporary directory,
   route Open Folder to that copy, and drive the same workbench. The test only
   substitutes the system picker and exposes a minimal Monaco adapter for
   deterministic editing/inspection in the native automation build.

Never target the original fixture or a user's project for writes. Report Go
and gopls checks separately. A run without gopls can exercise all other
native paths but cannot prove LSP functionality. A full feedback run
requires gopls and must fail if it is missing.

## 2. Operator and agent interface

- `npm run check` — formatting check, typecheck, focused tests.
- `npm run test:ui` — no separate server needed; Playwright installs its
  browser once with `npx playwright install chromium`.
- `npm run test:native` — native debug build and acceptance; pass
  `-- --skip-build` for a previously built, matching test binary only.
- `npm run test:feedback` — focused, headless, native with mandatory gopls.

Tests exit nonzero on any failed assertion or infrastructure fault; failure
data live below `test-results/`. Inspect the failed test's report before
retrying. Never leave a running test application or driver.

## 3. Test-only isolation

The separate Tauri config has a distinct identifier, binary name, and frontend output.
The WebDriver library is an optional Rust dependency restricted to debug
builds, and only starts upon explicit fixture and port configuration. The
tiny frontend Monaco adapter is compiled only with `VITE_IRON_E2E=1`.
Production build invocations set neither. No development server or
automation listener is necessary to use a shipped app.

## 4. Verification

2026-11-26: the initial headless suite exposed the missing workbench; the
native runner retained a build log when the main entry point was not yet
implemented. During acceptance, a missing native test command trigger was isolated
from working gopls hover via the screenshot and report. After switching the
test adapter to Monaco's public `trigger`, `npm run test:feedback` passed
all focused checks, three Playwright cases, and seven real native cases
with no LSP skip. GitHub Actions uses the same full-loop command on macOS.

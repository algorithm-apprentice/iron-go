# Testing Iron Go on macOS

Run once after cloning:

```sh
npm ci
npx playwright install chromium
```

Install Go, Rust, and Xcode Command Line Tools. For native LSP acceptance,
install `gopls` using `go install golang.org/x/tools/gopls@latest` and put it
on `PATH` or in `~/go/bin`. Select a compatible gopls version (for example,
`v0.20.0` with Go 1.25) if you can't use the latest Go toolchain.

| Command | What it proves |
| --- | --- |
| `npm run check` | TS types, focused TS tests, Rust formatting and services, real fixture tests. |
| `npm run test:ui` | Workbench behavior in headless Chromium with isolated browser storage. |
| `npm run test:native` | Real WKWebView, IPC, local files, and Go tools. Runs the LSP case if gopls is installed. |
| `npm run test:feedback` | All three layers; fails if gopls is missing. |
| `npm run test:picker` | Checks native title-bar placement at the default and minimum widths, then opens and cancels the real macOS project picker. Requires a built `.app` and Accessibility permission for the calling terminal. |

The native suite builds `iron-go-acceptance` and opens a temporary
copy of `tests/fixtures/orbit`. No existing IDE instance or manual folder
selection is needed. It requires a working macOS app session. For repeat
runs with an unchanged test build, use `npm run test:native -- --skip-build`.

To check a real Git project without using or modifying its working tree:

```sh
npm run test:native -- --project /path/to/checkout --test-file raft_test.go
```

The optional `--test-file` checks gopls actions for the requested test file.
This mode opens the committed `HEAD` snapshot in a temporary directory,
runs the module's actual tests, and reuses the host Go toolchain caches. It
can download the Go SDK or dependencies specified by the selected project.
It also honors an explicit `GOTOOLCHAIN` for testing against a matching SDK
while the project's suggested version is unavailable.

On headless UI failure, inspect `test-results/ui/<case>/browser.log`,
`workbench.png`, and open `trace.zip` with `npx playwright show-trace`.
Native runs print a `test-results/native/<run>/` path containing the per-case
`report.json` and the build/app logs; on native failure the runner also
attempts to capture a screenshot and a workbench snapshot. Start with the
first failed assertion, not a blind retry. Save fixture changes as tests
when they explain a regression.

GitHub Actions runs the full feedback loop for pushes to `main` and pull
requests on a macOS runner and attaches available diagnostics to the run.
The optional picker smoke runs locally after `npm run tauri build -- --bundles app`;
its disposable process is independent of any currently open Iron Go window.

See [ADR 0002](adr/0002-test-feedback-loop.md) and [the acceptance design](design/test-feedback-loop.md).

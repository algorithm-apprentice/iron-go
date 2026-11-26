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
Install Delve (`brew install delve` or `go install github.com/go-delve/delve/cmd/dlv@v1.27.2`)
to run the debug acceptance. macOS must allow debugging a local Go child process.

| Command | What it proves |
| --- | --- |
| `npm run check` | TS types, focused TS tests, Rust formatting and services, real fixture tests. |
| `npm run test:ui` | Workbench behavior in headless Chromium with isolated browser storage. |
| `npm run test:native` | Real WKWebView, IPC, local files, and Go tools. Runs the LSP case if gopls is installed. |
| `npm run test:feedback` | All three layers; requires gopls and real Delve debug acceptance. |
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
With Delve installed, add `--debug-test TestLeaderElection` to hit a real
breakpoint in that named test before continuing.
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
For a mixed-DPI setup, use `npm run test:picker -- --retina-probe` to put the
disposable editor on a Retina display and report the picker screen and capture
dimensions. Bitmap measurement requires Screen Recording permission; it
captures only the disposable app's picker and does not retain the image.
Add `--display-round-trip` to move that test picker to a 1× display and
back, reporting bitmap dimensions and a title-edge sharpness sample at
each step. This is diagnostic, not a portable pixel threshold: an initial
and a restored 2× bitmap can have different underlying text detail.

See [ADR 0002](adr/0002-test-feedback-loop.md) and [the acceptance design](design/test-feedback-loop.md).

# Test Iron Go on macOS

## Set up

Install the [build dependencies](BUILDING.md#install-build-dependencies) and
[Go tools](BUILDING.md#go-tools) for the layer you plan to run. For Chromium
tests, install the Playwright browser once:

```sh
npx playwright install chromium
```

Native tests need a working macOS app session. Debug acceptance also needs
permission to debug a local Go child process. The optional Accessibility and
picker tests need permission to send native input from the terminal or test
host; the default CI gate does not request this permission.

## Choose a test layer

| Command | What it verifies |
| --- | --- |
| `npm test` | Focused TypeScript and test-runner behavior using Node. |
| `npm run test:rust` | Rust workspace, process, and service behavior. |
| `npm run check` | TypeScript types and focused tests, Rust formatting and tests, and tests for the Go fixture. |
| `npm run test:ui` | Workbench behavior in headless Chromium with isolated browser storage. |
| `npm run test:native` | Real WKWebView, AppKit, Tauri IPC, filesystem, and Go tools. |
| `npm run test:feedback` | Checks, Chromium, and native acceptance with required gopls and Delve. |

Start with the cheapest relevant case. Follow the [contribution rules](../AGENTS.md)
for the required gates and review evidence before publishing. Examples:

```sh
node --test --test-name-pattern='editor typography' tests/ui/workbench.test.mjs
npm run test:native -- --group files
```

The full feedback command runs checks, Chromium, and native acceptance in
parallel and records all results and timings. On interruption, the native runner
verifies its process cleanup while the other stages finish normally.
`npm run check` owns the static TypeScript gate in this loop; the native test
build alone checks runtime behavior. The [feedback design](design/feedback-test-efficiency.md)
explains the scheduling and test build choices.

### Native groups

One native build of `iron-go-acceptance` serves all selected groups. Each group
owns a disposable app, worker, workspace copied from [Orbit](../tests/fixtures/orbit/README.md),
and home directory. For an unchanged test build, add `--skip-build`. The runner
continues to later independent groups after a group failure.

| `--group` | Scope |
| --- | --- |
| `lifecycle`, `files` | Welcome, project transitions, editing, geometry, disk conflict handling, and workspace changes. |
| `go`, `debug` | Go tasks, gopls, navigation, and Debug with real Delve. The Go group also relaunches to check restored run configurations. |
| `quit`, `quit-save` | Real AppKit/system Quit and native Close, preservation on cancellation, ticket expiry, partial saves, and Save and Quit. |
| `recovery`, `recent` | Relaunch with the same profile to verify draft recovery and restored editor sessions. Recovery exercises abrupt process termination and concurrent writers. |
| `trash`, `terminal` | macOS Trash on an isolated APFS image, and real PTY input, resize, credits, and cleanup. |
| `accessibility` | Permission-dependent native keyboard input, focus, and the WKWebView accessibility tree. |

- Repeat `--group` to select more than one group. The default excludes `debug`
  and `accessibility`. Add `--require-delve` to the default run to include Debug.
  Explicit Debug requires both gopls and Delve.
- The Go group's language-service cases skip only when the capability probe
  confirms gopls is absent and it was optional. Use `--require-gopls` to require
  it. A skip does not demonstrate coverage. The [report completeness ADR](adr/0036-native-acceptance-report-completeness.md)
  describes how the initial and relaunch results are checked.
- Use `npm run test:native -- --quit-only` to run just `quit`. This group
  exercises a minimized window, unanswered-dialog retry, cancellation while
  preserving dirty text and child processes, refusal during a save, and
  approved discard without writing the buffer. The full feedback gate includes
  Quit and Quit Save as part of the native run.
- Run `npm run test:native -- --group accessibility` explicitly for real native
  keystrokes and AX inspection. This does not run VoiceOver.

### Real project snapshots and cleanup diagnostics

To exercise a Git project with a root `go.mod` without using or modifying its
working tree:

```sh
npm run test:native -- --project /path/to/checkout
```

The runner archives committed `HEAD` into a temporary directory, runs the
module's tests, and reuses the host Go toolchain caches. It can download the
project's Go SDK or dependencies; use `GOTOOLCHAIN` to choose another compatible
SDK when needed. Add `--test-file raft_test.go` to exercise language services;
this requires working gopls. With `--test-file`, add
`--debug-test TestLeaderElection` to hit a real breakpoint (requires Delve), or
`--gutter-line 28` to diagnose the editor's gutter geometry and line selection.
Do not combine `--project`, explicit groups, `--quit-only`, or the crash probe.

For a teardown diagnostic, `npm run test:native -- --skip-build --probe-runner-crash`
intentionally kills a group worker with a disposable Go child running. Expect
a nonzero exit. In the native run directory, inspect `crash/cleanup.json` and
`report.json` to verify that the app and observed Go child disappeared and the
later `files` group ran. Unverified cleanup fails the run and preserves the
disposable paths named in the report. Never point the runner at an installed app
or use a live checkout as its fixture.

### Picker and display diagnostics

After [building a normal `.app`](BUILDING.md#build-local-bundles), run
`npm run test:picker`. Its disposable process checks window geometry at the
default and minimum widths, then opens and cancels the real macOS folder picker.

- Add `-- --retina-probe` to put the disposable editor on a Retina display and
  report the picker screen and capture dimensions. Bitmap measurement requires
  Screen Recording permission; it captures only the picker and keeps no image.
- Add `--display-round-trip` to the Retina probe to move to a 1× display and
  back and compare the title-edge sharpness. Treat the scores as diagnostic:
  an initial and a restored 2× bitmap can have different underlying detail.

## Investigate a failure

| Layer | Where to look |
| --- | --- |
| Chromium | `test-results/ui/<case>/browser.log`, `workbench.png`, and `trace.zip`. Open the trace with `npx playwright show-trace <path-to-trace.zip>`. |
| Native | `test-results/native/<run>/report.json`, build/app logs, and per-group artifacts. On failure the runner attempts to capture a screenshot and workbench snapshot. Quit cases capture the last live snapshot before checking process exit and disk state. |

Start with the first failed assertion rather than retrying blindly. Successful
live native cases check for uncaught WebView errors and unhandled rejections.
When a fixture change explains a regression, keep it with the test.

For geometry changes, test the interactive target and the thing inside it:
a correctly sized button can contain a misaligned SVG. Include native WKWebView
assertions for rendering that can differ from Chromium. Use compact rendering
fixtures and pass larger boundary values to layout calculations directly.

## CI

[The macOS feedback workflow](../.github/workflows/feedback.yml) runs the full
feedback loop and builds a normal bundle for pushes to `main` and pull requests.
It uploads diagnostics when available. The [Go 1.27.x smoke workflow](../.github/workflows/go-127-smoke.yml)
runs the Go and Debug groups weekly or on manual dispatch, outside the PR gate.

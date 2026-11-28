# Shorten the macOS feedback loop

## Baseline and scope

The feedback command runs checks, Chromium, and native acceptance in series.
Chromium took about 20 seconds in the recorded full run; native setup, build,
and acceptance took about 77 seconds, including about 24 seconds to build the
acceptance app (`test-results/native/1795804775525-72770`). The two native Quit
groups intentionally exercise real deadlines. They account for about 24
seconds of case time and are not redundant waits to remove.

Improve scheduling and avoid repeating static TypeScript validation while
building acceptance assets. Keep the existing cases, native app isolation,
required `gopls` and Delve, and failure evidence. There is useful overlap:
Chromium exercises browser interaction and imported copies; WKWebView covers
native rendering, AppKit, Tauri IPC and subprocess cleanup. Keep native
groups sequential because they manipulate the frontmost macOS window.

## Behavior and invariants

- Launch the existing `check`, Chromium, and native acceptance layers
  concurrently from one feedback coordinator. Report each layer's result and
  wall time, wait for all layers even after a failure, and exit nonzero if any
  layer fails. Do not retry or hide failures. Cargo may serialize builds that
  share a target directory; do not introduce a second Rust build cache.
- The headless browser builds into its existing disposable output directory;
  native uses the separate `dist-e2e` frontend. The normal application build
  still runs TypeScript validation. For the test-only Tauri config, build the
  runtime frontend with Vite directly; `npm run check` owns the static type
  gate in the full feedback command. Running native acceptance on its own
  exercises runtime behavior; invoke `npm run check` for static validation.
- Start stages in separate process groups so terminal interruption reaches
  the feedback coordinator first. Signal only the native coordinator PID,
  not its group: it must close the app's stdin and verify cleanup itself.
  If a native build is already in progress, let the build subtree finish and
  report interruption before launching any acceptance app. Check the latched
  interrupt after asynchronous setup and immediately before each spawn, so
  an interruption never admits a new build, app, or worker. An active app and
  worker keep the existing coordinated teardown. Let Chromium and checks
  finish normally on interrupt so their hooks and fixture-owned process
  cleanup are not bypassed. Wait for every stage, reporting interruption as
  nonzero even when the interrupted native coordinator exits successfully.

## Alternatives

- Do not run native groups concurrently or replace them with Chromium.
- Do not skip builds based on timestamps. For explicit unchanged native reruns,
  retain the existing `--skip-build` option.
- Leave isolated Go caches in place for this change. A persistent native test
  cache may improve repeat runs further, but needs separate cold/warm evidence.

## Acceptance

- Use a focused test with disposable subprocesses to prove that stages overlap,
  that a failed stage does not skip independent stages, and that failures are
  reported. Use disposable subprocesses to verify native-only interrupt
  delivery, descendant cleanup, natural completion of independent checks,
  and nonzero exit. Exercise the interrupted native build path with a
  disposable build subprocess that must finish before the runner returns;
  also hold log opening and verify an interrupt prevents build admission.
- Run `npm run check` and the full feedback command. Verify equivalent case
  counts and native requirements, and that both acceptance and production
  frontend paths use their intended Vite output. Compare the recorded stage
  and total wall times; distinguish measured improvement from expectations.

## Verification

- Compared the sequential and parallel commands in the same disposable
  snapshot of `5590cf1`, with the same dependencies and machine. Both
  completed successfully. Wall time fell from 103.97 s to 56.42 s (about
  46%). Parallel stage times were 15.7 s for checks, 22.0 s for Chromium, and
  56.2 s for native. The earlier failed baseline was excluded from this
  comparison. Cache state and machine load affect subsequent timings.
- After adding the final interrupt-admission guard and its test, the optimized
  snapshot passed again in 78.02 s, with all three stages and all six native
  groups green. This observed slower rerun is included rather than treating
  the 56.42 s run as a fixed speed guarantee.
- The comparison retained all 39 browser cases and the same six native
  groups, including the required `gopls` and Delve cases. The new focused
  coordinator cases passed: overlap and error aggregation, live interruption
  cleanup, build drain, and interrupt before build admission.

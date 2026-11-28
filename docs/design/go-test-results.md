# Structured Go test results

Status: Result streaming, full-path navigation, and verified name-filter
rerun implemented. This follows [named run configurations](go-run-configurations.md).

Implement result streaming and source navigation first. Add rerun only after
the package-identity preflight is implemented; the first slice exposes no
unverified retry action.

## Scope and user-visible behavior

- Run Go tests with `go test -json -fullpath`. Keep human-readable test output in
  **Output** and add a **Test Results** tab for the active workspace's latest
  admitted test run. Group results by package and full test name, including
  subtests, passes, skips, failures, durations, and incomplete execution.
  Build and Run remain ordinary stdout/stderr tasks.
- Offer **Rerun Matching Name** on failed `Test…` functions and their subtests
  (not examples, benchmarks, or fuzz seeds) and navigation for
  recognized source locations. Resolve Go package import paths through the
  existing `go list` discovery output extended to include non-main packages;
  capture that map at test submission and keep it with the result view. Use
  only workspace-relative package paths verified again by Rust. Link
  only full source paths under the admitted root. Leave ambiguous bare
  filenames and unassociated sources as text.
- Pass the exact full test name into the existing execution lane. Rust bounds
  and validates the root Go test name, then escapes Go regexp metacharacters
  and anchors each slash-separated component for `-run`. Reruns use `-count=1`
  to bypass the successful-test cache. Go can execute parents and descendants
  of a match and cannot distinguish certain names containing slashes from
  actual nested names. Label this as Go name-filter behavior, not an exact
  execution promise. Highlight if the selected test never reports running,
  even on package success.
- After the ordinary save barrier, verify the expected import path and package
  directory through bounded `go env -json GOWORK GOFLAGS` and
  `go list -find -json=ImportPath,Dir,Module` phases under the native task
  owner. If Go uses a workfile or the package's module manifest outside the
  admitted root, refuse the rerun. Resolve relative manifest paths against
  the Go command's working directory. Refuse nonstandard manifest basenames
  instead of accepting inputs outside the native source signature, including
  excluded directories and workfiles not named `go.work`. Refuse symlinked
  manifest paths, including aliases into tracked locations. Refuse `-modfile`,
  `-overlay`, and quoted flags during rerun verification; normal Test still
  supports them. Pin the verified workfile (or `GOWORK=off`) and effective
  `GOFLAGS` for listing and execution. Represent an empty effective `GOFLAGS`
  with nonempty whitespace so the tool does not fall back to a later GOENV
  preference.
  Both package commands use the same validated relative
  directory selector, never an import pattern. Reject `...` and require that
  preflight resolve exactly one package with the captured import and directory.
  Check the native workspace source signature across preflight and again at
  handoff. Workspace/task identity, Stop, spawn, and publication of the new
  process group use the same native lock as configured Run. A `go.mod` or
  `go.work` remap observed before launch refuses the rerun. After the last
  signature check this is not an atomic guarantee against unrelated disk
  writers; the execution selector still names the admitted directory, not
  an import path that could be remapped to a different directory.
  Preflight failure shows one terminal result without starting Go Test.
  Check the selected test's `run` event within its package. If the event
  stream is incomplete, report that it was not received, rather than claiming
  that Go did not execute it.

## Ownership and stream rules

- Rust starts the command and tags its `Started` event as structured. Keep
  the existing process owner and use separate limits: a 4 MiB JSON transport
  budget and the existing 512 KiB visible output budget. Continue processing
  structured events after visible output
  clipping. A wire-budget cutoff marks the run incomplete. The renderer accepts only
  events from the current workspace and task token, and resets test state
  on the next admitted test or a workspace switch. A Run or Build need not
  erase the latest test results for the same project.
- Decode stdout incrementally so split UTF-8 bytes and JSON lines are
  assembled once. Parse Go test `Action`, `Package`, `Test`, `Elapsed`, and
  `Output` fields, including build events where available. Print the human
  `Output` text and ordinary stderr; keep malformed or unknown wire lines
  inspectable as output. Do not equate an omitted event with a pass.
- Key build diagnostics by `BuildEvent.ImportPath` (including bracketed test
  variants). Link a test package failure's `FailedBuild` ID to that diagnostic
  bucket, while displaying which package or variant actually produced each
  diagnostic. Keep dependency build failures attributed to the dependency.
  Plain stderr remains visible even when structured build events are absent.
- Bound line buffering to 64 KiB of decoded code units and the result shape
  to 2,000 rows, with at most one retained location per row. Mark
  output truncation, overlong/malformed events, cancelled runs, and missing
  terminal results visibly. Terminal pass/fail/skip events only describe the
  matching node; unfinished nodes become incomplete on task settlement.
- Render paths, names and messages as text. Validate source paths and still
  use normal workspace admission when opening a location. Resolving a row to
  a package may fail if discovery is unavailable or stale; keep the result
  visible without offering an unverified action.

## Alternatives

- Parsing the `-v` transcript alone loses explicit package/test association,
  ambiguous subtest names and interleaved output. Use the supported JSON
  protocol while retaining its printable `Output` strings.
- Do not launch a new `go list` subprocess per displayed result. Reuse bounded
  discovery data for row availability and perform effective workspace and
  package validation only at native rerun admission.

## Acceptance

- With real Go in a disposable project, observe a passing test, skipped test,
  failed subtest, package build failure, and interrupted test. Verify matching
  Output text, package grouping, durations, and no false green incomplete
  results. Cover build failures for a test-package variant and a dependency.
  Click a full-path failure location. Rerun a subtest whose name has regexp
  punctuation, show Go's nested-name matching semantics, and report a
  selected name that no longer runs. Modify a package's module path without
  moving its directory and verify a stale rerun is refused. Hold the handoff
  after preflight, apply a workspace remap, and verify no test runs. Check
  that an unsupported test root and pattern selector are not offered or
  admitted. Open a subdirectory below a module to verify that an external
  ancestor manifest is refused even when the expected import path matches.
- At the cheapest layer, inject split UTF-8 and JSON chunks, missing or broken
  final lines, unknown fields, build events, cancellation, and row limits.
  Verify scope changes cannot mix test streams or trigger a stale rerun.
- Generate real output beyond the display budget and verify later terminal
  events still appear in the results. Separately truncate the wire input and
  verify the run is marked incomplete.

## First-slice verification

- The initial focused test failed before the event decoder existed. Focused
  tests now cover split UTF-8 bytes, build correlation, repeated attempts,
  error-source preference, bounded rows, and wire truncation by itself.
- The native Go case passed with real Go in
  `test-results/native/1795810919615-98032`: visible output clipping left
  terminal pass, skip, and failure results intact, the failure opened the
  source line, build variants and dependencies stayed correctly attributed,
  and stopping an active test marked it incomplete. That full run had a
  separate existing typography rendering failure in the Files group.
- The targeted Files and Go rerun (`test-results/native/1795811347154-3335`)
  passed all Go cases, including both native processes used for run
  configurations. A separate Files-only rerun passed after the disk-preview
  lifecycle fix (`test-results/native/1795812053873-5918`).
- The final `npm run test:feedback` passed all 40 Chromium cases and all six
  native groups, with the Go group's separate reopen phase
  (`test-results/native/1795812597296-7292`).

## Rerun verification

- The first native Go regression failed because the failed subtest had no
  rerun action. `npm run check` and the final native Go group passed after
  the launch guards (`test-results/native/1795835036961-18781`). Real Go ran
  the punctuation-bearing name with `-count=1` without running the similarly
  named sibling. A workspace change at the held preflight handoff refused
  the rerun before a test started.
- Rust cases cover literal selectors, Unicode test roots, excluded or
  symlinked manifests, pinning empty flags with a real GOENV file, and
  refusing a module above the opened root. The full feedback suite also
  passed before the final manifest guards were tightened
  (`test-results/native/1795834558008-14584`).

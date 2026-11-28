# Focused regression coverage

## Scope and invariants

1. A successful native Go report must contain the real build/run/test case,
   every gopls-dependent case, and the persisted configuration on relaunch.
   Validate each phase independently. The initial worker records the gopls
   capability probe separately from case results. All 11 dependent cases must
   pass if available; all 11 must explicitly report the missing-tool reason if
   absent and optional. A missing probe or mixed pass/skip results fail. The
   relaunch has no language-service requirement. Missing or duplicate case
   records fail the corresponding phase. Preserve worker,
   assertion, Quit and cleanup diagnostics ahead of completeness failures.
2. Test the native menu's current-document and increasing-revision checks
   without starting AppKit. Exercise the same projection methods the IPC
   handler and menu event dispatcher use. Keep AppKit item membership and
   dispatch on their existing paths.
3. Use in-memory native terminal owners and channels to test that stale stop
   and acknowledgement requests cannot affect the current owner, and that
   teardown waits for cleanup confirmation. Keep real PTY coverage native.
4. Add focused tests for batch-save interruption and committed writes, and
   for Back/Forward after recorded paths move or disappear. This batch tests
   history state; delayed WebView file activation is a separate integration
   concern.

## Alternatives

Use named critical Go cases rather than a minimum count: duplicate or unrelated
records can satisfy a count. A catalog of every native case is unnecessary for
the observed failure. Keep the existing Node and Rust runners and use focused
assertions rather than a global coverage threshold or a mock AppKit runtime.

## Acceptance

- An otherwise green Go report fails if a critical case is missing, duplicated,
  or forbidden to skip. An optional missing gopls is reported explicitly, and
  a successful initial phase cannot compensate for a missing relaunch case.
- Menu tests reject obsolete generations and stale/equal revisions, including
  an old event after the new page has published state.
- Terminal tests avoid launching real processes and verify owner identity and
  cleanup completion through the channels used by the renderer commands.
- TS tests verify remaining history entries after a move/trash and confirm
  partial batch writes are reported while later files are not admitted.
- Run `npm run check` and native acceptance. Record actual verification here.

## Verification

Before changing the native report validator, both the missing gopls cases and
the missing relaunch case incorrectly returned `pass` in focused tests. After
the change, all 17 targeted Node tests and all five new Rust tests passed.

Node coverage over the 12 TypeScript modules loaded by the fast runner rose
from 94.72% to 95.86% for lines and from 85.87% to 86.55% for branches. The
Rust coverage command ran 63 passing tests (plus the ignored child-process
helper) and exercised menu and terminal paths that had no coverage in the
previous Rust run. These figures do not include browser or native acceptance.

`npm run check` passed with 58 Node and 63 Rust tests. Independent review
confirmed that validation runs before phase reports are merged and that
existing cleanup failures retain priority.

`npm run test:feedback` passed all three stages: checks, 50 Chromium cases,
and 65 native cases across 10 groups. See
`test-results/native/1795863663160-6472/report.json`. The initial Go worker
recorded `goplsAvailable: true` and 16 passing cases; the relaunch separately
recorded the configuration-restoration pass. The optional missing-gopls
policy was verified with focused Node tests.

## Follow-up: execution, drafts, and saved configurations

Add Node unit tests for three existing invariants:

- An execution retired during a pending save never dispatches, even if a
  replacement now owns the lane. A failed Stop restores the active task so
  it can be stopped again.
- Superseded draft writes and retirements do not mark a newer revision as
  saved or remove it. Hold and release storage promises in the test to
  control ordering; pass immediate work so no wall-clock waits are needed.
- Invalid stored run configurations are ignored individually. Duplicate IDs
  keep the first valid record, and a selected ID must resolve to a valid record.

Reuse the Node test runner. For the draft and run-configuration modules, use
Vite's existing TypeScript compilation in memory and stub only the draft
storage and Monaco text-read boundaries. Export the existing pure parser
without changing its callers or format. This avoids launching a browser,
faking the workbench, or adding another test toolchain. Verify with the focused
Node tests, the Node suite, and TypeScript checking.

The focused tests exercised both explicit and automatic draft retirement. The
three parser tests required the existing parser to be exported; its runtime
logic and caller stayed the same. `npm test` passed all 66 Node tests, including
the eight additions. `npm run typecheck` and `git diff --check` passed.
No browser or native acceptance was needed for this test-only follow-up.

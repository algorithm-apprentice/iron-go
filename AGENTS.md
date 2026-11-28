# Working on Iron Go

Iron Go ships for **macOS only**. `../iron-cpp` is a read-only architecture,
ADR, and native-acceptance reference, not a build dependency.

Write source comments, user-facing strings, documentation, and commit
messages in clear technical English. Keep intentional Unicode test data
when it is needed to exercise editor behavior.

## Design and test first

1. Read [the architecture](docs/ARCHITECTURE.md) and relevant [ADRs](docs/adr/README.md).
   For a new feature or behavior change, first update or add `docs/design/` with
   scope, invariants, alternatives, and concrete acceptance checks. Record durable
   decisions under `docs/adr/NNNN-*.md`; don't rewrite accepted history silently.
   Get an independent design review before starting implementation.
2. Add a focused regression test at the cheapest meaningful layer. Observe it
   fail for the intended reason before changing product code. Use a disposable
   fixture when tests touch disk or launch processes.
3. Implement the smallest change that passes. Reuse established libraries and
   native tools before adding infrastructure. Keep workspace and process
   ownership in Rust and workbench state in TypeScript.
4. For code or test-runner changes, run `npm run check` and the relevant
   acceptance suite. Native/WebView/IPC changes require `npm run test:native`;
   a browser run alone does not prove them. Run `npm run test:feedback` as the
   full gate before publishing code or test-runner changes. See the
   [testing instructions](docs/TESTING.md) for failure artifacts and setup.
   For documentation-only changes, validate links and check instructions
   against the current commands and behavior.
5. Update the design with actual verification and any remaining gaps. Never
   require a user to click through a scenario an agent can exercise itself.
6. Get independent code review of the exact diff and evidence before committing
   or pushing. The implementer owns test execution and supplies commands,
   results, and artifact paths. The reviewer inspects the diff, test coverage,
   and existing evidence. The reviewer may run a focused test to reproduce a
   finding or verify a specific fix, but must not rerun the full suite. If a
   broader check is needed, ask the implementer. After a fix, rerun affected
   checks and any required gate, reuse applicable evidence for unchanged
   areas, and re-review affected changes before publishing.

Keep runner code and fixture routing out of shipped builds. Do not use an
existing user workspace, modify the sibling repository, or report a skipped
test as passing.

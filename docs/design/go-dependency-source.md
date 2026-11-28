# Read-only Go toolchain and dependency source

Status: Implemented slice of [Go navigation and refactoring](daily-go-workbench.md#2-go-navigation-and-refactoring).

## Scope and invariants

- Go to Definition keeps ordinary workspace navigation, and can open a
  read-only snapshot of a Go source file in the effective toolchain or module
  cache. Use a disposable workbench source viewer with the actual path and
  selected line; it is not a workspace tab and has no Save, format, run,
  breakpoint, or language-server synchronization actions.
- Rust resolves `GOROOT` and `GOMODCACHE` using `go env -json` in the admitted
  workspace. Bound time, stdout, and stderr. Disable proxy and checksum
  network access, including direct GOPRIVATE bypass, without forcing a
  different toolchain than the project uses. A toolchain Go cannot resolve
  offline, or a target from a different SDK than Go reports, is unavailable.
  Canonicalize configured root aliases (such as Homebrew links) before
  anchoring them and use no-follow traversal below the anchor. Only regular,
  bounded Go text under `GOROOT/src` or a versioned extracted module directory
  is readable. Require the module's download metadata and zip hash, and no
  `.partial` extraction marker before and after the read. Do not fetch a
  missing module or broaden ordinary workspace file commands.
- The workbench Go to Definition action (F12, command palette, and editor
  context menu) owns the request and opens the viewer directly. It validates
  local file URI syntax and retains the complete LSP range. It invalidates
  a result when the workspace, language service, origin tab, version or
  caret changes, or a later navigation begins. Revalidate after the read and
  reject out-of-bounds UTF-16 ranges. Rust receives the path and separately
  enforces workspace identity and Go root containment.
- The workbench prefers workspace definitions. One local target opens in
  an editable tab; multiple local targets keep Monaco's existing behavior.
  With only external definitions, open the first valid Go source target.
  Monaco's definition provider remains workspace-only, including Peek and
  modifier-click. It exposes no external URI to preview or activation.
- Keep the source viewer and its Monaco model read-only and independently
  disposable. Cancel pending view creation when the project or originating
  model changes. Closing the reader restores the active editor's focus.

## Alternatives

- Do not allow arbitrary absolute reads through the normal editor adapter.
  Keep the native capability specific to Go toolchain and cache roots.
- A synthetic URI in the Monaco definition provider would also be sent to
  Peek. Its preview can activate the same opener as a direct jump, so use
  a workbench action for external source instead.
- Start with a read-only viewer rather than extending the lifetimes of
  editable tabs, save conflict tracking, or project scope settings.

## Acceptance

- Jump to a real standard-library definition and an offline dependency from
  a disposable module. Use a local module proxy fixture or prepared module
  cache rather than relying on internet access. Check exact source and its
  selected range, then close and verify focus returns.
- Reject a same-named source outside the approved roots, a cache path without
  a versioned module directory, and a symlink substitution. Delay a source
  read and switch projects; the old result must not open a viewer. Verify
  ordinary workspace definition navigation remains editable.
- Cover origin invalidation, malformed URI, external Peek and full-range
  validation. Verify alias rooting, incomplete extraction, and
  initial multiple-definition selection at the cheapest meaningful layer.

## Verification

- The first native regression failed because the standard-library viewer did
  not open (`test-results/native/1795836424489-22095`).
- `npm run check` passed with URI, root-alias, replaced-workspace, cache
  completion, and offline discovery regressions. The final
  `npm run test:native -- --group go --require-gopls` passed, including cleanup
  (`test-results/native/1795837174733-27658`). Native coverage verified exact
  bytes and selection for a real standard-library and prepared offline cache
  file, a collapsed editable jump, no external Peek, skipping an unavailable
  earlier target, focus restoration, and a delayed read after reopening the
  project. Independent review approved the final source navigation changes.

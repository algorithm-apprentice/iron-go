# Go symbol navigation

Status: Implemented first navigation slice of the [daily Go workbench plan](daily-go-workbench.md).

## Scope and invariants

- Add **Go to Line** for any open buffer, without `gopls`. Validate a one-based
  line number against the captured model; never silently clamp an invalid
  input. Open the chosen location in the existing editor and preserve the tab.
- Add **Go to Symbol in File** for Go. Request `textDocument/documentSymbol`
  through the existing `gopls` client and show names, kinds, qualified scope,
  and line numbers in a searchable workbench dialog. Use symbol selection ranges to navigate.
  A cancelled, switched, closed, or edited model cannot present or use an
  earlier symbol result. Show a meaningful empty or unavailable state.
- Add **Find References** for Go using `textDocument/references`. Display a
  bottom panel with references grouped by file, including the
  declaration. A result opens the file through the normal workspace reader,
  using an existing model if it is open and loading a fresh one otherwise.
  No preview-only Monaco models or new path-reading capabilities are needed.
- Admit only local `file:` URIs with no authority, query, or fragment and a
  validated relative path inside the current workspace. Reject malformed or
  traversal-like forms and invalid UTF-16 ranges, and deduplicate by validated
  relative path and range before rendering. External dependencies are a
  separate read-only source slice.
- Flush the relevant open Go buffers before requesting navigation so recent
  unsaved changes are included: all tracked Go buffers for workspace references,
  the captured model for document symbols. Keep syntax highlighting and local
  Go to Line independent of language-server availability. Navigation never
  saves or alters a source buffer.
- One symbol/reference request belongs to the originating project, language
  service, active model and version. References also capture the document-set
  edit revision and the identities of tracked Go models. Opening, closing, or
  replacing a tracked Go model invalidates the reference snapshot, including
  a dirty target closed with Discard. Cancel on dismissal, replacement, project switch, origin
  change, or an applicable edit while waiting. Pass a real cancellation token
  through JSON-RPC so an outstanding request sends `$/cancelRequest`. Keep the
  same validity check after display and immediately before navigation; an
  invalid selection closes its result UI without opening a file. A superseded
  response cannot replace a different palette or result dialog.

## Alternatives

- Use a workbench result list and a searchable symbol dialog over Monaco Peek in
  this slice. Peek needs a separate model resolver for closed files and a
  lifecycle for preview-only models. Use structured LSP symbols and references
  over lexical search; full-text search remains useful outside Go.
- Ship in-workspace navigation first rather than broadening workspace IPC to
  arbitrary absolute files. Definition jumps into GOROOT and dependency sources
  require a separate native read-only policy and acceptance cases.

## Acceptance

- In native WKWebView with real `gopls`, navigate to an internal package
  declaration, find its uses in multiple files, and open a result whose file
  had never been opened. In a separate request, add an unsaved use in a second
  open Go file and request references before the sync debounce fires. Verify
  the declaration and the new use after a supplementary-plane character,
  exact UTF-16 navigation, grouping, and unchanged disk bytes. Rename a
  declaration in an unsaved buffer and verify document symbol search sees
  the new name. Require `gopls` for this acceptance run.
- Use Go to Line in a plain-text file without `gopls`; reject zero, fractions,
  exponent notation and lines past the end. Cancel keeps the caret in place.
- Delay results and edit or close the originating model before they return.
  Verify no stale workbench navigation or result presentation follows, a
  displayed selection invalidated before activation cannot open a file, and
  the cancellation is observable in the JSON-RPC transport. Exercise malformed,
  traversal-like, external, and non-file URIs. Discard a dirty target after
  references are displayed and verify activation cannot reopen it at the old
  unsaved range.

## Verification

- The first Chromium Go to Line regression failed because its command was
  absent. The final `npm run test:feedback` passed all 38 browser cases and
  six native groups (`test-results/native/1795802149543-52665`).
- The native Go case used real `gopls` to select an unopened declaration, an
  unsaved cross-file reference at its UTF-16 location, and a filtered unsaved
  symbol. It held a live reply while editing the origin and observed the
  cancel message. Discarding an unsaved target invalidated its displayed row.
- The browser regressions exercised invalid lines, strict URI syntax,
  surrogate and range bounds, rejection before tab registration, and the
  matching JSON-RPC cancellation ID. An earlier production build contained
  no navigation-probe marker.

# Format Go files during explicit saves

Status: Implemented follow-up under [Go navigation and refactoring](daily-go-workbench.md#2-go-navigation-and-refactoring).

## Scope and invariants

- Add an app-local **Format Go files on save** preference, off by default.
  Apply it to the explicit Save File and Save All commands for dirty native
  Go buffers. The preview has no native formatter. Keep existing Format Go
  File as an independent undoable edit. Save-before-task, Save and Close,
  project/Quit decisions, and reviewed disk saves retain their existing byte
  and revision contracts. Explain the scope beside the setting.
- Reserve the save from snapshot capture through settlement. Capture the disk
  expectation, Monaco model version, EOL convention, and whether the document
  contains a BOM (mixed input endings already normalize in Monaco). Run the
  existing native `gofmt` command on BOM-free text, restore the captured EOL
  and exactly one BOM if present when writing the disk bytes, and never insert
  the BOM into editable text. Do not edit the buffer before the ordinary
  conditional save succeeds. If the formatter or
  save fails, preserve the buffer and baseline, report the error, and provide
  a separate **Save Without Formatting** command for the active file.
- When the formatted save succeeds, the saved baseline is the exact bytes
  written. Apply formatting to the live model as one Undo unit only if its
  model version still matches the submitted snapshot. Later typing during
  formatting or writing remains untouched and dirty against the newly saved
  baseline; commit only the captured snapshot while its target remains live.
  An inactive but unchanged open tab still receives the formatting without
  taking focus. Do not apply a late result to a closed or replaced model or
  a different workspace. Already formatted snapshots add no Undo step. Save All still reports
  which writes committed and stops on failure or newer edits; the application's
  own format changes in already clean tabs do not count as newer unsaved work.

## Alternatives

- Formatting the live model before saving makes a conflict or formatter
  error unexpectedly change the editor. Format a submitted snapshot instead.
- Do not silently save unformatted bytes when format-on-save is enabled.
  Make the exception an explicit user action.
- Do not format during a reviewed overwrite or implicit Go save barrier;
  their approval and revision checks intentionally describe existing bytes.

## Acceptance

- Native Save File and Save All format real Go source, including unchanged
  inactive tabs, and keep the live buffer clean. Use BOM and CRLF and compare
  exact disk and buffer bytes. One Undo restores pre-format bytes as dirty;
  Redo restores the clean saved buffer. Neither touches disk. An already
  formatted save creates no undo step. Verify the default-off behavior and
  that a native non-Go file and browser import still save normally.
- With invalid Go, Save File fails without writing; Save Without Formatting
  writes the exact original edit. A disk change between formatting and save
  still raises the ordinary conflict.
- Exercise edits during both formatting and writing, and verify only the
  submitted formatted snapshot reaches disk while newer edits remain dirty.
  During a three-tab Save All, re-edit the first tab while the second write
  is held. Report both committed paths and do not start the third write.
- With the preference on, verify unchanged byte semantics for reviewed
  overwrite, save-before-task, Save and Close, and save-before-project/Quit.
  Save Without Formatting still observes ordinary disk conflicts.

## Verification

- The first native Files regression failed because the preference was absent.
  The final `npm run check` and native Files group passed
  (`test-results/native/1795835778860-21205`). Native coverage verified the
  default-off behavior, exact BOM/CRLF bytes, Undo/Redo, a formatter error
  after switching tabs, the explicit bypass, and format-enabled Save All
  with an inactive formatted tab and an interrupted third write.
- The focused Chromium case verified that edits during both the formatter
  wait and the save wait remain dirty against the captured formatted bytes.
  The final review approved the error reporting and exact application path.

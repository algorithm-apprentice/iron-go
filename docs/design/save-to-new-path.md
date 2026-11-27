# Save a retained buffer to a new path

Status: Implemented follow-up under the [daily Go workbench plan](daily-go-workbench.md).

## Behavior

- Offer **Save to a New Path** for native tabs, including visibly missing or
  unreadable files. Ask for a workspace-relative destination in an existing
  directory. The operation retains the existing source file, if any. Cancel,
  validation failure, or a destination collision leaves the original tab and
  buffer intact. Never overwrite an existing destination or a path currently
  open in a different tab, even if its file was deleted externally.
- Use one file-activity reservation through the path form and admitted write.
  Capture the source tab identity when opening the form and its current
  buffer when submitting. Revalidate the tab and destination immediately
  before requesting native creation. No Go launch, project switch, or ordinary
  Quit may overlap. Reserve the destination in `Documents.open` through
  rebinding, including calls from Monaco and Debug; refuse if an alias is
  already being opened. Apply full Unicode case folding and normalization
  to document keys even on case-sensitive
  volumes. Treat equivalent source, open and opening paths as collisions
  regardless of whether they currently exist on disk.
- Rust creates the destination using the admitted root and a held directory
  descriptor. Hold the stable profile save lock through validation and
  publication. Stage the complete bytes in the destination directory, then
  use macOS exclusive rename so no observer sees an empty or partially written
  file. Revalidate root, parent and staging ownership before replacement;
  this does not detect a non-cooperating swap between final validation and
  the syscall. Existing paths, including symlinks, fail the exclusive
  operation; do not fall back to overwrite if exclusive rename is unsupported.
  A new file keeps the private staging mode. A missing parent is an error,
  not a request to create directories.
- Refuse the profile directory, or its nearest existing ancestor if it has
  yet to be provisioned, by filesystem identity before opening or
  creating the stable lock. Return the committed path's disk spelling, so
  an aliased parent path cannot create a second editor entry in Quick Open.
- After success, rebind the source tab to the new path and set its disk
  baseline to the committed bytes. Preserve live buffer text, cursor, selection,
  and scroll. Later edits remain dirty against the new baseline. Monaco model
  URIs are immutable: create a model for the new path, which resets the undo
  stack. Invalidate reconciliation at submission and use a new tab identity so
  late results from the old path cannot match it even if model version numbers
  repeat. Close the old model's `gopls` document and open the new one; existing
  breakpoints remain associated with the old source path because the disk
  operation creates a separate file rather than moving the original.
- Refresh the tree, Quick Open, and Go package discovery after a successful
  creation. Errors in metadata refresh cannot undo a successful disk commit.

## Alternatives

- An exclusive open followed by streaming writes prevents overwrite but can
  expose partial bytes on failure and requires ownership-aware cleanup of the
  public pathname. Same-directory staging and exclusive rename avoid both.
- Adding a second tab would leave ambiguity over which buffer owns the unsaved
  changes. Rebind the existing tab after successful exclusive creation.

## Acceptance

- Native WKWebView: remove the active file after editing and save the retained
  text to another path. Verify exact bytes, new tab identity, clean state,
  updated tree and Quick Open, and no recreation of the old path.
- Cancel, choose a case or Unicode alias of an already open missing tab or
  pending open, and introduce an external
  destination before exclusive rename. Verify the original tab and its bytes
  are preserved and no conflicting destination is overwritten.
- Hold an admitted creation while a newer edit is injected. The created file
  contains only submitted bytes; the rebound tab preserves the newer edit as
  dirty. Release an old-path observation after rebinding; it has no effect.
  An ordinary Save writes the newer text against the new baseline.
- Rust regression: replacement ancestor or staging names before final
  validation cannot redirect the new file or cause cleanup of someone else's
  file; a destination collision is enforced atomically by exclusive rename.

## Verification

- The first browser case failed before `Documents.saveToNew` existed. The
  final `npm run test:feedback` passed 36 browser cases and all six native
  groups (`test-results/native/1795801280331-47650`).
- The browser document test covers full case folding, a pending open, a newer
  buffer edit and an old-path observation released after rebinding. Native
  Files verifies cancellation, missing-tab aliases, an existing destination,
  a held write, on-disk spelling and Quick Open reuse, and ordinary Save
  against the new baseline. Rust verifies publication-time collisions and
  refusal to provision the profile directory or lock at the requested path.

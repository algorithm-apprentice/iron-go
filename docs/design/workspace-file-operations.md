# Move and manage workspace files safely

Status: Implemented slice of [project continuity](daily-go-workbench.md#5-project-continuity-and-file-management).

## Scope and invariants

- Add **New Folder**, **Rename**, **Move**, and **Move to Trash** to the
  Explorer and workbench commands. Offer the action for the selected file
  or directory and show its workspace-relative path before committing.
  New Folder never replaces anything. Rename changes the leaf name; Move
  can change the parent within the admitted workspace. There is no package
  import-path rewrite or permanent-delete operation.
- Rust validates both endpoints, excludes aliased or nonregular sources,
  rejects self/descendant moves, and protects the app-local data directory
  (including its descendants and any source ancestor that contains it).
  Check the app profile by canonical pathname and directory identity, not
  by its visible spelling alone. Use anchored parents, verify the workspace
  and endpoint identities, and take the same stable advisory lock as Save
  for each disk mutation. Capture a native source version before confirmation.
  Recheck the admitted workspace ID, source version, root and both parent
  identities under the lock immediately before mutation. The lock coordinates
  Iron Go writers; unrelated tools can still race after the final check.
- Use macOS `renameatx_np` with `RENAME_EXCL` for the one disk rename.
  Successful case-only rename changes the actual directory spelling as
  approved; confirm that spelling in the returned mapping. The preliminary
  native APFS probe changed `Mixed.go` to `mixed.go` with that flag and
  without an intermediate file. Destination collisions fail atomically.
- For Move to Trash, stage the verified item into an owner-only sibling
  directory with an exclusive rename and ask macOS `NSFileManager` to trash
  that staged item. Keep the original leaf name. On platform failure, move
  it back exclusively. If the original name is no longer available, leave
  the staged bytes recoverable and report the exact staged path. This avoids
  applying a path-only platform call to a later file at the original name.
  Recheck staged file and parent identities before invoking Foundation or
  restoring the original name. Report the resulting macOS Trash URL on success.
  Do not model Finder's Put Back behavior as an Iron Go undo guarantee.
- A structural operation reserves file/editor actions and invalidates old
  watcher, navigation, and Go results. Refuse admission while a Save or
  reload is active or a Go task owns the lane. Freeze editing through the
  confirmed operation. After a successful move, rebind descendant tabs and
  breakpoints to the native result without replacing dirty text; preserve
  tab order, selection, cursor and viewport. Monaco models are rebound by
  creating a new URI; the old URI must leave gopls before the new one opens.
  Reserve both path subtrees and reject open or opening destination collisions
  before native commit, including a missing target occupied by a dirty tab.
  A case-only mapping of the same tab is allowed.
- Rebind owned drafts at the native cutover, under the workspace Save lock.
  Acquire native locks in order: workspace state, Save lock, recovery writer,
  then recovery profile. Stage the replacement draft index before mutation.
  Use the renderer's captured writer revision to fence all earlier writes
  and retirements for both subtrees after filesystem commit, even if index
  publication does not complete. Rebind only this writer's records. Preserve
  the old baseline unless its exact pre-move version and the moved file's
  identity can be verified; retaining a token that requires review later is
  preferable to silently authorizing a replacement. If file mutation
  fails, keep the old draft index and editor mapping. If draft publication
  fails after disk commit, report that partial effect, retain the original
  recovery payload, and rebind from the native disk result. Do not lose a
  dirty draft if its path or recorded baseline cannot be confirmed after
  the disk move. For Trash, obtain an explicit discard decision for dirty
  descendants and retire those owned drafts only after confirmed platform
  success. If Trash fails partway, keep their dirty buffers available.
  A stranded Trash stage is a distinct partial result and names the exact
  recovery path. Require explicit disk review or Save to a New Path before
  writing an affected dirty buffer back to a replaced or unverified path,
  including a byte-identical replacement after rollback fails. Apply the same
  rule to a moved buffer whose original disk expectation cannot be verified.
- After a committed move or partial Trash result, retire pending recorder
  work for the affected old tabs before thawing the writer. A failed
  in-flight snapshot may have requested a retry while frozen, but neither
  that retry nor a later old completion can run after cutover. Schedule
  the current surviving buffers from the native path result as new work.
- Refresh Explorer, task discovery, and watched source state after the
  native result. Preserve case-renamed views and breakpoints. Late results
  captured before the mutation cannot apply to the renamed path.

## Alternatives

- Do not use an unrestricted path write command or an overriding rename.
  Keep the existing relative workspace boundary and use the exclusive native
  primitive for files and directories, including case-only changes.
- Do not implement Trash as recursive deletion or a guessed `~/.Trash`
  destination. Use the actual macOS API and surface its failure.

## Acceptance

- Move a disposable directory containing a clean and a dirty open Go file.
  Verify exact disk names, text, original dirty baseline, active selection,
  view state, breakpoints, and owned recovery data at the new paths. Prove a
  pending Save prevents admission and a stale watcher reply cannot replay.
- Exercise an actual macOS case-only rename, destination collision, New
  Folder in a nested location, source substitution, and refusal to move or
  trash an ancestor of the profile lock. Reproduce substitution after source
  confirmation and a stale workspace ID at cutover. Hold queued old-path
  draft writes across successful and failed recovery-index publication.
  Test a rejection that schedules an old-path recorder retry while frozen,
  and show it never dispatches under a new revision. Compare the old and new
  LSP document events. Check the original user bytes.
- Confirm dirty Trash, exercise cancellation, platform failure and rollback,
  and verify no permanent deletion. For the real API acceptance, first
  verify the resolved Trash belongs to a mounted disposable APFS volume.
  Mocked HOME and CFFIXED_USER_HOME still resolved to the real home Trash
  in the probe, whereas the disk image resolved to its own `.Trashes`.
  Fail before calling Trash if isolation cannot be verified. Test failure
  rollback separately, including an original name occupied by a byte-identical
  replacement. Save on the stranded buffer must leave that replacement intact.
- Run `npm run check` and native file acceptance; target deterministic
  concurrency and partial-effect failures at the cheapest meaningful layer.

## Verification

- The native regression initially failed at the missing Move command
  (`test-results/native/1795840775118-46246`, Files group). Native Files later
  passed directory rebind with a breakpoint and dirty draft, nested folder
  creation, exact case-only rename, and exclusive collision rejection
  (`test-results/native/1795843106710-51873`, Files group).
- macOS Trash was exercised on an isolated mounted APFS disk image. The
  native case verified cancellation and matching original bytes at the
  actual Trash destination (`test-results/native/1795842564618-49722`, Trash
  group). Rust covers failed rollback with a byte-identical replacement,
  post-rename identity checks, and protected profile identity. Chromium
  verifies an unverified moved or stranded buffer cannot save normally.

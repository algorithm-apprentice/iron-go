# Consolidate project and Settings entry points

## Scope

Finish three confirmed duplicates from the [workbench audit](workbench-size-audit.md#economy-of-controls),
following the [bottom panel pass](output-panel-controls.md). Keep the Go
toolchain status as information, reduce duplicate project entry points, and
give Refresh Project one visible home. Do not change theme colors, Go
launch/stop controls, breadcrumbs, document ownership, or native IPC.

## Interaction invariants

- **Settings:** keep the activity-rail Settings button, `⌘,`, and the palette
  command. Turn the Go toolchain status into non-interactive text with the
  existing version, status indicator, and tooltip. The status is not a
  focus stop or styled as a button. **Check tools** remains in Settings.
- **Open Project:** welcome provides the visible Open button while no project
  is open; the title bar provides it while an existing project is open. Do
  not display both in the same state. Keep the existing workflow, cancellation,
  browser import, palette command, and `⌘O` in both states. Remove a hidden
  button from tab order, not from its shared workflow. Keep the title layout.
- **Refresh Project:** remove the independent icon. Leave the action in
  **Project Actions** and the command palette. Both use the same guarded
  callback, refreshing the tree and Go package targets just as the old icon
  did. Do not refresh without an open project or during its transition.

Do not delete the toolchain status because it conveys information no Settings
button does. A hidden welcome button cannot switch an open project, and the
persistent header button is unnecessary in an already actionable welcome view.
An extra refresh icon is not needed once the visible project menu can reach
the full refresh behavior. Retain the old contexts and commands rather than
removing functionality along with the redundant controls.

## Acceptance

1. Browser: one Open Project button is visible and keyboard reachable in each
   state. Import still opens a project and enables the header action; closing
   returns to the welcome action. The status is visible but not a button or
   tab stop. The Settings gear opens the existing settings. Project Actions
   exposes Refresh Project without a separate button, and layout tests still
   check the remaining controls and gaps.
2. Native: open the disposable fixture from welcome and switch from the title
   bar once a project is open. Add a Go package on disk and refresh through
   the visible Project Actions menu; its file appears in the tree and its
   executable becomes a run target. Check the real toolchain version remains
   visible and native Settings still allows **Check tools**. Retain all other
   native acceptance and do not use the installed app or a live workspace.

## Verification

The focused Chromium test failed before implementation because welcome
exposed two Open Project buttons. It now verifies one entry per state,
keyboard activation of welcome import, the non-interactive status, and
the retained project commands in Project Actions. The complete feedback
loop passed (23 TS, 31 Rust, Go fixture, 27 browser, 26 native;
`test-results/native/1795754445514-72540`). Native acceptance confirmed
that refresh through Project Actions added both a newly created source file
to the expanded tree and its executable to the picker. It also checked the
visible Go version, probe button in Settings, and title-bar project switch.

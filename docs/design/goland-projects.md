# Project-first onboarding and opening on macOS

Status: Implemented and verified on macOS.

## Reference

- [GoLand Quick Start](https://www.jetbrains.com/help/go/quick-start-guide-goland.html#start-a-go-project): first launch shows project onboarding, then opens the workbench for a selected project.
- [Create and manage projects](https://www.jetbrains.com/help/go/creating-and-managing-projects.html): the project is the top-level unit; directory selection is an implementation detail.
- [Create a new project](https://www.jetbrains.com/help/go/create-new-go-project.html): Go modules are the default, with optional example code.

## Decision

Use the GoLand model for project entry, keeping the existing workbench layout.
Launch to a welcome state with **New Project** and **Open Project**. There is
no default project or example behind the welcome screen.
Keep welcome artwork monochrome so project actions are the visual focus;
this does not alter the colored Dock icon or favicon.
Open Project selects a project root using the macOS picker; it accepts folders
independently of Go tool readiness. Do not write `.idea` files. Close Project
returns to welcome; switching and closing retain existing dirty-file and running
task guards. No VCS cloning, recent-project store, or multi-window logic in
this pass.

Orbit lives only in `tests/fixtures/orbit`: native tests open a disposable
copy and browser tests import it explicitly. No production code imports or
copies the fixture. Browser preview opens only a user-selected in-memory copy
and cannot launch local tools. Existing user files and old browser storage
are not removed as part of this change.

The reported low-contrast chooser currently opens as an AppKit sheet attached
to the WebView window. Use a separate native `NSOpenPanel` via the synchronous
macOS RFD picker on a blocking worker, so the picker does not visually overlay
the editor. Do not change global macOS appearance or invent a browser file picker
for the desktop. Native appearance remains controlled by macOS.

## Acceptance

- Native automation: welcome has no active editor or Run target. Open Project
  selects a disposable Orbit fixture; Run works in that project. Close Project
  returns to welcome without editing the fixture.
- Native desktop smoke: open the real standalone folder chooser and cancel;
  no project is selected. Verify the panel is not attached as a sheet.
- Browser: compact geometry and the no-project welcome are verified. Orbit is
  imported by the tests, not present by default.

## Verification

The headless and native suites check startup with no project, opening the
disposable fixture, running Go normally, and closing back to welcome. The
production `.app` and its frontend assets were checked for the absence of
Orbit. `npm run test:picker` verifies the native title bar at the initial and
760 px minimum widths, plus focused standalone panel and Cancel behavior.

An independent macOS UX review recommended keeping welcome free of disabled
editor controls and describing the command center as commands rather than files
before a project opens. These changes are included.

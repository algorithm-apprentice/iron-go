# Editor typography

## Scope and invariants

- Use JetBrains Mono by default in Monaco. Bundle the upstream v2.304 regular
  WOFF2 and its SIL Open Font License so the app and browser preview work offline
  without a system font install. Retain the existing system monospace stack
  for uncovered characters and as a separate user-selectable option.
- Add **Editor Font** and **Editor Font Size** in Workbench Settings. Keep the
  default size at 13 px. Commit size edits on Enter or blur, accept integer
  sizes from 8 to 40 px, and restore the last applied size after an invalid edit.
  Scale the line height with size while keeping a minimum line height of 18 px
  for folding and breakpoint hit targets.
- Apply committed changes to the existing Monaco editor and remember them
  as app-wide preferences using the same storage as other workbench settings.
  Missing, invalid or unavailable storage falls back to defaults on startup.
  Keep workbench chrome and ligature behavior unchanged.
- Refresh Monaco's font measurements when the bundled face loads so cursor
  and selection geometry do not retain fallback metrics.

## Alternatives

- Using only a system-installed JetBrains Mono or a hosted font would make the
  default depend on the machine or network. A bundled face avoids both.
- Whole-window zoom changes controls and other chrome. Monaco options let
  users change just the code. A font preset keeps a usable fallback available
  without asking users to enter CSS font names.

## Acceptance

- In a fresh profile, Monaco renders with the bundled JetBrains Mono face at
  13 px and 18 px line height. Verify the face actually loads.
- In the browser, switch to System Monospace and 16 px in Settings and verify
  the current code updates, line height grows, invalid sizes preserve the last
  valid value, and reloading preserves the font and size. Verify invalid stored
  values fall back to defaults and folding can still be clicked at 8 px.
- Delay the font asset in the browser and verify that Monaco remeasures the
  character width after the font becomes available.
- In native WKWebView, verify the bundled face loads from the built frontend
  and settings update the rendered editor font, size and line height.

## Font source

- [JetBrains Mono Regular WOFF2, v2.304](https://github.com/JetBrains/JetBrainsMono/blob/v2.304/fonts/webfonts/JetBrainsMono-Regular.woff2)
- [SIL Open Font License](../../public/licenses/JetBrains-Mono-OFL.txt)

## Verification

- The first browser regression run found the previous SF Mono default.
  `npm run test:ui` now passes all 30 cases, including font loading, settings
  persistence across reloads, invalid values, folding at the minimum size,
  and refreshed character widths after a delayed font response.
- `npm run check` passed. `npm run build` emitted the byte-identical upstream
  font and license into the production frontend.
- `npm run test:native -- --require-gopls --require-delve` passed all five
  groups. The files group verified the bundled face loaded in WKWebView and
  that changing to System Monospace at 16 px updated the rendered rows to
  22 px. The delayed-font and preference reload cases run in Chromium.

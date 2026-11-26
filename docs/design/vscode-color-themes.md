# VS Code Color Themes

Status: Implemented and verified on macOS.

## Scope

Use the VS Code 2026 Light/Dark colors referenced by Iron C++ as the palette
for Iron Go. Match the editor canvas, workbench surfaces, accents and selection
states. Keep the existing layout and Iron Go icon. Monaco's built-in `vs` and
`vs-dark` themes still supply syntax highlighting and editor defaults; this is
not a VS Code extension theme or a complete import of its token rules.

## Implementation plan

- Share semantic CSS tokens across both workbench palettes. Map the editor's
  principal colors from those same tokens onto Monaco's public theme API.
- Display the names `Dark` (default) and `Light` in Workbench Settings and the
  command palette, without a VS Code prefix. Persist the choice locally. An invalid
  or inaccessible preference falls back to Dark. Do not bind the theme to a
  workspace or change native system dialogs.
- Update the editor theme in place. Switching must not replace the editor or
  its models, alter saved or unsaved content, or restart Go processes.

## Acceptance

- Headless: verify both backgrounds on the editor and surrounding workbench,
  switch with a dirty file without losing text, then verify the choice after
  reload and switch back through the command palette.
- Native: use Settings to switch both ways in real macOS WKWebView and verify
  the editor and workbench both changed. Then run the normal acceptance suite.

## Production CSS

The first native acceptance run caught a production-only failure: CSS
minification shortened `#ffffff` to `#fff`, which Monaco rejected when used
as a syntax token background. Expand short hex colors before passing them
to Monaco. The native test checks both surfaces and captures event errors,
so a partly applied theme cannot pass.

`npm run test:feedback` passed all four headless workbench cases and all
eight native acceptance cases with gopls. The normal `.app` bundle also built.

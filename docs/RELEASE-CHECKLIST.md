# macOS Release Checklist

1. Run `npm run test:feedback` with real Go and gopls. Check the CI report
   and confirm the native suite did not skip language services.
2. Verify a normal `npm run tauri build -- --bundles app` without
   `VITE_IRON_E2E` or the Cargo `e2e` feature. The acceptance binary and
   WebDriver listener are never distributed.
3. Before redistribution, review the dependency licenses and include
   applicable third-party license texts, copyright notices and notices
   files. The repository's Apache-2.0 license covers Iron Go, not its
   dependencies. See [ADR 0003](adr/0003-apache-source-license.md).
4. Configure Apple Developer signing and notarization for a public `.app`
   or `.dmg`. A developer build is not a signed, notarized public release.

## App icon

`assets/icon.png` is the canonical 1024 px icon. The artwork is the central
rounded square of the supplied GO image; background outside the frame is
transparent. Use the same image in the workbench, favicon, and app bundle.
When replacing it, generate macOS assets with
`npm run tauri icon -- assets/icon.png --output <temporary-directory>` and
copy the generated `icon.icns` and `icon.png` into `src-tauri/icons/`. Copy
the 64×64 and 128×128 variants to `assets/icon-64.png` and
`assets/icon-128.png` for the workbench.
Inspect the alpha edges and verify the built bundle's icon resource.

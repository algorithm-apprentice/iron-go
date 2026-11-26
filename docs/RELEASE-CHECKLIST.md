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

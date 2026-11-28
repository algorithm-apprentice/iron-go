# Build and package Iron Go

## Install build dependencies

Build on macOS 15 or later with Node.js 24 or later, stable Rust, and Xcode
Command Line Tools. Install Go to create modules and use Go tooling. From the
repository root:

```sh
npm ci
```

## Run from source

After [installing build dependencies](#install-build-dependencies), run:

```sh
npm run tauri dev
```

For UI development without a native app, use `npm run dev`. See the
[browser preview limits](USAGE.md#browser-preview).

## Go tools

- **Go** provides module creation, formatting, build, run, and test. CI runs
  its main gate with Go 1.25.x.
- **gopls** adds language services. With Go 1.25, install the version used in
  CI: `go install golang.org/x/tools/gopls@v0.20.0`. With a sufficiently
  recent Go toolchain, you can install `gopls@latest` instead.
- **Delve** enables debugging. Install with `brew install delve` or use the
  CI version: `go install github.com/go-delve/delve/cmd/dlv@v1.27.2`.

Put installed tools on `PATH` or in `~/go/bin`. See
[tool discovery in the workbench](USAGE.md#open-or-create-a-project).

## Build local bundles

```sh
npm run tauri build -- --bundles app       # .app only
npm run tauri build -- --bundles app,dmg   # .app and installer disk image
```

The default output is `src-tauri/target/release/bundle/`. Use the normal
Tauri configuration for these builds. Local builds do not configure Apple
Developer signing or notarization.

## Release checklist

1. Run the [full feedback gate](TESTING.md#choose-a-test-layer) and check the
   native report for successful language-service and Delve cases.
2. Verify the [normal bundle](#build-local-bundles) without `VITE_IRON_E2E`
   or the Cargo `e2e` feature. The acceptance binary and WebDriver listener
   are never distributed.
3. If producing a DMG, verify its checksum, mount it read-only, and check
   the bundled app's version, architecture, minimum macOS version, icon,
   and Applications link. Launch the normal app to Welcome and check it does
   not open a fixture. See the [real picker smoke](TESTING.md#picker-and-display-diagnostics)
   for window geometry and picker cancellation.
4. Before redistribution, review the dependency licenses and include
   applicable third-party license texts, copyright notices and notices
   files. The repository's Apache-2.0 license covers Iron Go, not its
   dependencies. See [ADR 0003](adr/0003-apache-source-license.md).
5. Configure Apple Developer signing and notarization for a public `.app`
   or `.dmg`.

## App icon

`assets/icon.png` is the canonical 1024 px icon. The artwork is the central
rounded square of the supplied GO image; background outside the frame is
transparent. Use the same image in the workbench, favicon, and app bundle.
When replacing it, generate macOS assets with
`npm run tauri icon -- assets/icon.png --output <temporary-directory>` and
copy the generated `icon.icns` and `icon.png` into `src-tauri/icons/`. Copy
the 64×64 variant to `assets/icon-64.png` for the favicon and the 128×128
variant to `assets/icon-128.png` for the welcome screen. Do not duplicate
the Dock icon in the native title bar.
Inspect the alpha edges and verify the built bundle's icon resource.

## Troubleshoot release builds

### Release proc-macro loading on macOS 27

With macOS 27.2.1 / Xcode 27.2 and Rust 1.97.1, the default Cargo release
profile compiled proc-macro libraries that `dyld` later rejected as
`mis-aligned LINKEDIT string pool`. Rust also reported secondary E0463
errors for `phf_macros` and other proc-macro crates. Debug builds were
unaffected. The issue occurred through Tauri and in direct Cargo builds.

The explicit `strip = "none"` in the Cargo release profile opts out of the
inferred stripping that triggered the problem. Keep the workaround local to
this project and retest a clean [.app build](#build-local-bundles) before
removing it. Check this setting before changing registry dependency versions
in response to E0463.

On 2026-11-26, the normal Tauri command produced a 14.88 MiB Apple Silicon
`.app` with this manifest setting and no environment override.

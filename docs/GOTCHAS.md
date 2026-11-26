# macOS Build Gotchas

## Release proc-macro loading on macOS 27

With macOS 27.2.1 / Xcode 27.2 and Rust 1.97.1, the default Cargo release
profile compiled proc-macro libraries that `dyld` later rejected as
`mis-aligned LINKEDIT string pool`. Rust also reported secondary E0463
errors for `phf_macros` and other proc-macro crates. Debug builds were
unaffected. The issue occurred both through Tauri and in direct Cargo builds.

The release command is the reproduction and acceptance check:

```sh
npm run tauri build -- --bundles app
```

An explicit `strip = "none"` in the Cargo release profile opts out of the
inferred stripping that triggered the problem. Keep the workaround local to
this project and retest a clean release build before removing it. Do not patch
or downgrade registry dependencies as a first response to the E0463 errors.

Verified 2026-11-26: with the manifest setting and no environment override,
the normal Tauri command produced a 14.88 MiB Apple Silicon `.app`.

# Go syntax colors with clearer visual roles

These rules provide baseline lexical colors. See
[Go semantic highlighting](go-semantic-highlighting.md) for the gopls overlay.
The role table below records the original custom palette; it is superseded by
the [Modern color alignment](go-modern-color-alignment.md).

## Scope and evidence

On the same disposable Go source, Iron Go's inherited Monaco colors rendered
`func`, `if`, `return`, `int`, and `true` in the same blue. VS Code 1.148.0
Modern separates declaration blue, control-flow violet, and type teal.
Baseline native captures: `test-results/theme-audit/iron-go-syntax.json`
and `test-results/theme-audit/vscode-modern-syntax.json`.

Upstream source at the measured commit:
[Dark Modern](https://github.com/microsoft/vscode/blob/661626d0e72f97806550790a98fb87116c9db825/extensions/theme-defaults/themes/dark_modern.json),
[Light Modern](https://github.com/microsoft/vscode/blob/661626d0e72f97806550790a98fb87116c9db825/extensions/theme-defaults/themes/light_modern.json),
and the inherited [Dark+](https://github.com/microsoft/vscode/blob/661626d0e72f97806550790a98fb87116c9db825/extensions/theme-defaults/themes/dark_plus.json)
and [Light+](https://github.com/microsoft/vscode/blob/661626d0e72f97806550790a98fb87116c9db825/extensions/theme-defaults/themes/light_plus.json)
syntax definitions. VS Code assigns these colors to TextMate scopes, including
Go-specific type scopes. Iron Go uses Monaco's different token names rather
than importing those scope rules verbatim.

Use the reference's role separation as a baseline, not a promise of exact
TextMate highlighting. Keep the separately matched Modern UI surfaces, both
existing themes, their saved preference, Monaco's Go tokenizer, and the
editor model. Do not change fonts, add theme options, install external
grammars, or implement LSP semantic tokens. User-defined types, calls and
variables that Monaco reports as identifiers stay neutral. Retain the
existing bracket pairing and invalid-token behavior.

## Color rules

| Go token role | Dark | Light | Design intent |
| --- | --- | --- | --- |
| Declaration and constants | `#569cd6` | `#245da8` | Clear moderate blue instead of the electric inherited light blue |
| Control flow and imports | `#c586c0` | `#862d94` | Distinct violet without changing token weight |
| Recognized built-in types | `#4ec9b0` | `#087569` | Teal to separate types from declarations |
| String and rune literals | `#d6a085` | `#a23c2b` | Warm copper, distinct from punctuation |
| Escape sequences | `#d7ba7d` | `#8b4e17` | A readable accent inside string literals |
| Numbers | `#b5cea8` | `#176b44` | A clearer green reserved for literals |
| Comments | `#7a9f6b` | `#34744f` | Quieter green, but readable against the editor canvas |

Apply `.go`-scoped rules for tokens the current grammar actually emits:
individual `keyword.<word>.go`, `string.go`, `string.escape.go`, `comment.go`,
`comment.doc.go`, `number.go`, and `number.{float,hex,octal,binary}.go` in
Monaco 0.57.0. Inherit invalid-token styling; unclassified words such as
`any`, `error` and `iota` remain neutral. Keep tokens in the existing CSS
palettes and feed them to Monaco's public API as full hex values. Do not
use global keyword rules. Embedded Go in fenced Markdown takes the Go
colors, while ordinary Markdown and other tokens retain their base styling.
Aim for at least 4.5:1 contrast on each theme's normal, unselected editor
background. Selected text uses the separately existing Modern background
and does not carry the same contrast claim. Neither highlight changes nor
audit results imply a universal aesthetic preference.

## Acceptance

- Start with a failing built-asset test on a short Go example: control flow,
  declaration, builtin type, string, escape, decimal and hex number, and both
  comment forms show expected rendered colors in both themes. Check the real
  canvas, neutral identifiers, embedded Go versus ordinary Markdown, and a
  switch without losing a dirty edit. No large files.
- Native WKWebView checks Go token colors through Settings and keeps the
  Modern workbench, completion readability, and existing native flow tests.
- Document measured token roles, not exact parity with VS Code or coverage
  for unclassified identifiers.

## Verification

The focused browser regression failed before implementation: control flow and
builtin types were the same blue as declarations, documentation comments used
the dimmer inherited color, and escapes had no distinct color. It passed
after the change in both themes and in an embedded Go fence while ordinary
Markdown stayed neutral. All measured unselected Go role colors passed the
4.5:1 contrast check on the actual canvas. Updated native sample:
`test-results/theme-audit/iron-go-syntax-after.json`.

The final feedback loop passed 23 TS, 31 Rust, Go fixture, 28 browser, and
27 native cases (`test-results/native/1795755989996-80402`). The native
color test switched both palettes on the same unsaved Go buffer and verified
that the original disk contents were unchanged.

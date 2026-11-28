# Go semantic highlighting

Use full-document UTF-16 relative semantic tokens from the current `gopls`
session for open native Go buffers. Advertise the standard token types and
modifiers used for styling, plus gopls's `format` modifier for format string
directives, and enable `semanticTokens` in gopls configuration. Register Monaco's
document semantic provider only when full tokens and a valid server legend are
available. Use that legend to decode the result; classify types, namespaces,
functions, methods, members, parameters, variables, and constants, including readonly
variables and built-in functions. Keep lexical styling
for other spans and for preview, missing gopls, and unsupported servers.

Flush pending edits before requesting tokens. Use the existing request
cancellation and version checks, and reject results for closed or retired
models. Validate and bound relative ranges before handing data to Monaco.
Themes use Go-specific semantic styles in both palettes. Use full requests
first rather than maintaining a separate server delta cache; Monaco schedules
updates and manages the displayed token state.

The lean Monaco 0.57 entry point needs the document semantic feature and
explicit semantic highlighting activation. Its standalone theme matches
semantic token names through normal theme rules, so emit a dedicated legend
and re-encode offsets after omitting unstyled spans. Older gopls versions
such as 0.20 classify fields as variables; use that classification when the
server does not distinguish fields.

The [Modern color alignment](go-modern-color-alignment.md) gives ordinary
variables, fields, and parameters the same upstream foreground color.

Acceptance: a real gopls-backed dirty Go buffer renders distinct roles for
user-defined types, methods, fields and parameters in both themes. Verify
ordinary lexical styling without a language provider. Exercise malformed
ranges, UTF-16 and stale results at the cheapest meaningful layer. Run the
local checks and native Go acceptance with gopls required.

## Verification

The initial native regression showed the unsaved identifiers in the neutral
foreground (`test-results/native/1795848822053-72482`). `npm run check` and
the native Go and Files groups passed after implementation
(`test-results/native/1795849300097-75224`). The native check verified exact
colors in both palettes, including fields when the server advertises them
and a parameter reference following an astral character. Focused Chromium
checks passed for obsolete responses and lexical colors without gopls.

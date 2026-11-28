# Align Go colors with VS Code Modern

Use the Go colors resolved from VS Code 1.148.0 Dark Modern and Light Modern
(commit `661626d0e72f97806550790a98fb87116c9db825`) as the baseline. Modern
inherits Dark+/Light+ and their Visual Studio base rules. Use the upstream
semantic-token scope defaults for types, namespaces, functions, properties,
parameters, ordinary variables, and readonly variables. Use Go's placeholder
scope for format directives. Lexical colors apply when no styled semantic span
is available; predeclared literal constants retain whatever Monaco supplies.

Keep the existing theme picker, workbench, and tokenizer. Importing the complete
VS Code TextMate and theme engine would change token coverage and is outside
this alignment. No intentional palette deviations in the mapped Go roles yet.
Tokenizer coverage still differs: Monaco leaves `iota` neutral and styles
rune escapes separately. The exact escape-color check uses interpreted
strings. Placeholder coloring in Iron Go covers directives returned by gopls,
whereas VS Code's lexer also recognizes placeholders such as `%%`.

| Go role | Dark Modern | Light Modern |
| --- | --- | --- |
| Declaration keywords and predeclared literals | `#569CD6` | `#0000FF` |
| Control flow and imports | `#C586C0` | `#AF00DB` |
| Types and semantic namespaces | `#4EC9B0` | `#267F99` |
| Strings and runes | `#CE9178` | `#A31515` |
| Interpreted string escapes | `#D7BA7D` | `#EE0000` |
| Numbers | `#B5CEA8` | `#098658` |
| Comments | `#6A9955` | `#008000` |
| Functions, methods, and builtins | `#DCDCAA` | `#795E26` |
| Variables, fields, parameters, and format placeholders | `#9CDCFE` | `#001080` |
| User-defined constants | `#4FC1FF` | `#0070C1` |

Acceptance: verify the exact upstream colors in both themes for lexical tokens
without gopls and for real gopls semantic tokens in a dirty buffer, including
ordinary variables and parameters. Check that the palette switch retains the
edit and that lexical colors pass the existing contrast check.
Check the production assets as well: the CSS optimizer can serialize
`#008000` as `green`, which the Monaco token theme adapter must convert to
six-digit hex before use.

## Verification

The focused decoder test initially failed because ordinary variables were
omitted. `npm run check`, the focused Chromium lexical and contrast case,
and the native Go and Files groups passed. The native run samples the focused
editor's rendered colors in both themes for types, methods, fields,
parameters, variables, constants, namespaces, builtins, and a gopls format
placeholder (`test-results/native/1795852118428-82347`).

# Keyboard access on macOS

## Personal-use scope

Defer VoiceOver and the proposed screen-reader preference. Keep Monaco's
existing `accessibilitySupport: "off"` and `editContext: false` configuration.
Retain keyboard navigation, visible focus, and accessible control names.

- Shift–Command–E moves focus from the editor to Explorer. Explorer arrows,
  Home, and End navigate the visible tree; activating a file returns to the
  editor. Tab indentation and editor cycling keep their existing behavior.
- The selected visible feedback tab is the group's single Tab stop. When a
  conditional pane closes, select the fallback without reopening a collapsed
  panel or taking focus from another area.
- Closing Settings or a file confirmation restores the initiator or a
  surviving fallback without overriding newer focus.

Keeping the separate screen-reader setting without accepting VoiceOver would
introduce an unneeded mode. The native keyboard acceptance still exercises
Unicode typing, caret movement, selection and deletion, exact saved bytes,
dialog focus, and the WKWebView accessibility tree. It does not launch or
query VoiceOver. Earlier Forced On runs are historical evidence only.

## Verification

The native regression initially found the removed preference in the previous
build (`test-results/native/1795846517724-68252`). The final explicit run
passed with the restored options, named workbench buttons and confirmation
actions in the AX tree, native keyboard input, and focus restoration
(`test-results/native/1795846886360-71711`). The integrated feedback run also
passed (`test-results/native/1795846668738-68435`).

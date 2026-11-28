# ADR 0035: Native menu commands and editor-owned navigation history

Status: Independently reviewed design. See [the menu and history design](../design/native-menu-and-navigation-history.md).

Keep native menu construction and AppKit responders in Rust. Reuse existing
workbench command guards in TypeScript. Keep jump history bounded and local
to the admitted workspace, recording only committed intentional editor
activations. Back and Forward restore editor locations through the ordinary
workspace reader without writing buffers or persisting history.

import { byId } from "./dialogs";
import { exactModelRange, monaco } from "./editor";

export async function showGoSource(source: { path: string; text: string }, range: monaco.IRange) {
  const dialog = byId<HTMLDialogElement>("go-source-dialog");
  const model = monaco.editor.createModel(source.text, "go");
  let editor: monaco.editor.IStandaloneCodeEditor | undefined;
  try {
    if (!exactModelRange(model, range)) throw new Error("This definition range no longer matches the Go source.");
    byId("go-source-path").textContent = source.path;
    byId("go-source-location").textContent = `Line ${range.startLineNumber}, column ${range.startColumn}`;
    dialog.showModal();
    editor = monaco.editor.create(byId("go-source-editor"), {
      model, readOnly: true, domReadOnly: true, automaticLayout: true, editContext: false,
      minimap: { enabled: false }, ariaLabel: "Read-only Go source",
    });
    editor.layout();
    editor.setSelection(range);
    editor.revealLineInCenter(range.startLineNumber, monaco.editor.ScrollType.Immediate);
    editor.render(true);
    editor.focus();
    await new Promise<void>(resolve => dialog.addEventListener("close", () => resolve(), { once: true }));
  } finally {
    if (dialog.open) dialog.close();
    editor?.dispose();
    model.dispose();
  }
}

import { byId } from "./dialogs";
import { monaco } from "./editor";
import type { DiskObservation, ReadableDisk } from "./workspace";

function describeText(text: string) {
  const endings = new Set(text.match(/\r\n|\n|\r/g));
  const names: Record<string, string> = { "\r\n": "CRLF", "\n": "LF", "\r": "CR" };
  const lineEndings = [...endings].map(ending => names[ending]).join(" / ") || "no line endings";
  return { detail: `${text.startsWith("\ufeff") ? "UTF-8 BOM" : "No BOM"} · ${lineEndings}`, mixed: endings.size > 1 };
}

export async function showDiskComparison(details: {
  path: string;
  language: string;
  buffer: string;
  dirty: boolean;
  current(): boolean;
  load(): Promise<DiskObservation>;
}): Promise<{ action: "save" | "reload"; observed: ReadableDisk } | undefined> {
  const dialog = byId<HTMLDialogElement>("disk-compare-dialog");
  const viewport = byId("disk-compare-view");
  const headings = byId("disk-compare-headings");
  const status = byId("disk-compare-status");
  const save = byId<HTMLButtonElement>("disk-compare-save");
  const reload = byId<HTMLButtonElement>("disk-compare-reload");
  const models: monaco.editor.ITextModel[] = [];
  let editor: monaco.editor.IStandaloneDiffEditor | undefined;
  let close: () => void = () => {};
  const decision = new Promise<string>(resolve => { close = () => resolve(dialog.returnValue); });
  dialog.returnValue = "cancel";
  byId("disk-compare-path").textContent = details.path;
  status.textContent = "Reading the disk version…";
  headings.hidden = true;
  viewport.hidden = true;
  save.hidden = !details.dirty;
  save.disabled = true;
  reload.disabled = true;
  dialog.addEventListener("close", close, { once: true });
  try {
    dialog.showModal();
    const observed = await Promise.race([details.load(), decision.then(() => undefined)]);
    if (!observed || !dialog.open) return;
    if (!details.current()) throw new Error("This editor has changed. Compare again to review the current buffer.");
    if (observed.kind !== "text") {
      status.textContent = observed.kind === "missing" ? "The file is missing on disk." :
        observed.kind === "retry" ? "The file changed while reading. Compare again." : "The disk version cannot be read.";
      await decision;
      return;
    }

    const disk = describeText(observed.text);
    const buffer = describeText(details.buffer);
    byId("disk-compare-original").textContent = `Disk · ${disk.detail}`;
    byId("disk-compare-modified").textContent = `Editor · ${buffer.detail}`;
    const mixed = disk.mixed || buffer.mixed;
    status.textContent = mixed ? "Mixed line endings cannot be fully shown. Save and reload are unavailable from this review." :
      "Only the disk version shown here can be replaced or reloaded.";
    headings.hidden = false;
    viewport.hidden = false;
    const original = monaco.editor.createModel(observed.text, details.language);
    models.push(original);
    const modified = monaco.editor.createModel(details.buffer, details.language);
    models.push(modified);
    editor = monaco.editor.createDiffEditor(viewport, {
      automaticLayout: true, readOnly: true, originalEditable: false,
      useInlineViewWhenSpaceIsLimited: false, ignoreTrimWhitespace: false,
      renderWhitespace: "all", minimap: { enabled: false }, scrollBeyondLastLine: false,
      originalAriaLabel: "Reviewed disk version", modifiedAriaLabel: "Captured editor version",
    });
    const reveal = editor.onDidUpdateDiff(() => {
      if (editor?.getLineChanges()?.length) editor.revealFirstDiff();
      reveal.dispose();
    });
    editor.setModel({ original, modified });
    save.disabled = mixed || !details.dirty;
    reload.disabled = mixed;
    const action = await decision;
    if (!mixed && (action === "reload" || (action === "save" && details.dirty))) return { action, observed };
  } finally {
    dialog.removeEventListener("close", close);
    if (dialog.open) dialog.close("cancel");
    editor?.dispose();
    for (const model of models) model.dispose();
  }
}

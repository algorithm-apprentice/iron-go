import { byId, element } from "./dialogs";
import { monaco } from "./editor";
import { changedLineRegion } from "./comparison-region";
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
  readOnly?: { original: string; modified: string };
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
  const editors: monaco.editor.IStandaloneCodeEditor[] = [];
  let close: () => void = () => {};
  const decision = new Promise<string>(resolve => { close = () => resolve(dialog.returnValue); });
  dialog.returnValue = "cancel";
  byId("disk-compare-path").textContent = details.path;
  status.textContent = "Reading the disk version…";
  headings.hidden = true;
  viewport.hidden = true;
  save.hidden = !details.dirty || !!details.readOnly;
  reload.hidden = !!details.readOnly;
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
    byId("disk-compare-original").textContent = `${details.readOnly?.original ?? "Disk"} · ${disk.detail}`;
    byId("disk-compare-modified").textContent = `${details.readOnly?.modified ?? "Editor"} · ${buffer.detail}`;
    const mixed = disk.mixed || buffer.mixed;
    status.textContent = details.readOnly ? "This comparison does not change the open buffer or recovery draft." : mixed ? "Mixed line endings cannot be fully shown. Save and reload are unavailable from this review." :
      "Only the disk version shown here can be replaced or reloaded.";
    headings.hidden = false;
    viewport.hidden = false;
    const original = monaco.editor.createModel(observed.text, details.language);
    models.push(original);
    const modified = monaco.editor.createModel(details.buffer, details.language);
    models.push(modified);
    const region = changedLineRegion(original.getLinesContent(), modified.getLinesContent());
    const left = element("div", "editor original");
    const right = element("div", "editor modified");
    viewport.replaceChildren(left, right);
    const show = (pane: HTMLElement, model: monaco.editor.ITextModel, label: string, last?: number) => {
      if (region && last !== undefined && region.first <= last) {
        model.deltaDecorations([], [{ range: new monaco.Range(region.first, 1, last, 1),
          options: { isWholeLine: true, className: "disk-compare-changed-line" } }]);
      }
      const editor = monaco.editor.create(pane, {
        model, automaticLayout: true, readOnly: true, domReadOnly: true,
        renderWhitespace: "all", minimap: { enabled: false }, scrollBeyondLastLine: false, ariaLabel: label,
      });
      editors.push(editor);
      editor.layout();
      if (region) editor.revealLineInCenter(Math.min(region.first, model.getLineCount()), monaco.editor.ScrollType.Immediate);
      editor.render(true);
    };
    show(left, original, "Reviewed disk version", region?.beforeEnd);
    show(right, modified, "Captured editor version", region?.afterEnd);
    save.disabled = mixed || !details.dirty;
    reload.disabled = mixed;
    const action = await decision;
    if (!details.readOnly && !mixed && (action === "reload" || (action === "save" && details.dirty))) return { action, observed };
  } finally {
    dialog.removeEventListener("close", close);
    if (dialog.open) dialog.close("cancel");
    for (const editor of editors) editor.dispose();
    for (const model of models) model.dispose();
    viewport.replaceChildren();
  }
}

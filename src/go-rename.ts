import { byId, element } from "./dialogs";
import { applyPreparedTextEdits, monaco, prepareExactTextEdits, type Documents, type DocumentTab } from "./editor";
import type { GoLanguage } from "./lsp";
import { host, type Project, type ReadableDisk } from "./workspace";

type Participant = { tab: DocumentTab; disk: ReadableDisk };
type Change = Participant & { prepared: ReturnType<typeof prepareExactTextEdits> };
const changed = () => new Error("The workspace or editor changed since preparing the rename. Open a new preview.");

export async function prepareGoRename(options: {
  project: Project; docs: Documents; origin: DocumentTab; position: monaco.Position; name: string;
  start(): Promise<GoLanguage>; current(): boolean; token: monaco.CancellationToken;
}) {
  const { project, docs, origin, position, name, token } = options;
  const folder = project.native;
  const inspect = project.inspect;
  if (!folder || !inspect) throw new Error("Open a native Go project first.");
  const goTabs = () => [...docs.tabs.values()].filter(tab => tab.model.getLanguageId() === "go");
  const tracked = new Map(goTabs().map(tab => [tab, tab.model.getVersionId()]));
  const verifyEditors = () => {
    if (!options.current() || token.isCancellationRequested || docs.active !== origin) throw changed();
    const tabs = goTabs();
    if (tabs.length !== tracked.size || tabs.some(tab => tracked.get(tab) !== tab.model.getVersionId())) throw changed();
  };
  const readSignature = () => host.goSourceRevision(folder.id);
  const signature = await readSignature();
  verifyEditors();
  // didOpen replays editor overlays into the fresh server. Verify even the
  // files gopls might otherwise omit from the rename because of an old overlay.
  for (const tab of tracked.keys()) {
    const disk = await inspect(tab.path);
    verifyEditors();
    if (disk.kind !== "text" || disk.text !== tab.disk) {
      throw new Error(`${tab.path} changed on disk. Resolve the file change before renaming.`);
    }
  }
  const service = await options.start();
  verifyEditors();
  const verifyWorkspace = async () => {
    if (await readSignature() !== signature) throw changed();
    verifyEditors();
  };
  await verifyWorkspace();
  if (!await service.prepareRename(origin.model, position, token)) throw new Error("This Go symbol cannot be renamed.");
  verifyEditors();

  const participants = new Map<string, Participant>();
  async function load(paths: Iterable<string>) {
    for (const path of paths) {
      if (participants.has(path)) continue;
      if (participants.size >= 128) throw new Error("The rename affects too many files to review.");
      const disk = await inspect!(path);
      verifyEditors();
      if (disk.kind !== "text") throw new Error(`Could not verify the disk version of ${path}.`);
      const tab = await docs.open(path, { activate: false, observedDisk: disk, current: options.current });
      if (!tab || tab.disk !== disk.text || tab.model.getLanguageId() !== "go") throw changed();
      if (!tracked.has(tab)) tracked.set(tab, tab.model.getVersionId());
      verifyEditors();
      participants.set(path, { tab, disk });
    }
  }

  const references = await service.references(origin.model, position, token);
  verifyEditors();
  await load([origin.path, ...references.map(result => result.path)]);
  for (let attempt = 0; attempt < 3; attempt++) {
    const edits = await service.rename(origin.model, position, name, token);
    verifyEditors();
    const missing = edits.filter(edit => !participants.has(edit.path));
    if (missing.length) {
      if (attempt === 2) throw new Error("gopls kept adding new files to the rename. Try again.");
      await load(missing.map(edit => edit.path));
      continue;
    }
    const changes: Change[] = edits.map(edit => {
      const participant = participants.get(edit.path)!;
      if (edit.version !== null && edit.version !== participant.tab.model.getVersionId()) throw changed();
      return { ...participant, prepared: prepareExactTextEdits(participant.tab.model, edit.edits) };
    }).filter(change => change.prepared.original !== change.prepared.updated);
    await verifyWorkspace();
    if (!changes.length) throw new Error("The rename does not change any files.");
    return {
      changes,
      async apply() {
        for (const { tab, disk } of participants.values()) {
          const current = await inspect!(tab.path);
          if (current.kind !== "text" || current.version !== disk.version || current.text !== disk.text) throw changed();
        }
        await verifyWorkspace();
        const applied: string[] = [];
        try {
          for (const change of changes) {
            applied.push(change.tab.path);
            applyPreparedTextEdits(change.tab.model, change.prepared);
          }
        } catch (error) {
          throw new Error(`Could not finish the rename. Check ${applied.join(", ")} and use Undo if needed.`, { cause: error });
        }
        return changes.length;
      },
    };
  }
  throw new Error("Could not prepare the rename.");
}

export async function reviewGoRename(load: Promise<Awaited<ReturnType<typeof prepareGoRename>>>) {
  const dialog = byId<HTMLDialogElement>("rename-preview-dialog");
  const picker = byId<HTMLSelectElement>("rename-preview-file");
  const view = byId("rename-preview-view");
  const note = byId("rename-preview-status");
  const apply = byId<HTMLButtonElement>("rename-preview-apply");
  apply.disabled = true;
  picker.replaceChildren();
  picker.hidden = true;
  view.hidden = true;
  note.textContent = "Preparing the rename with gopls…";
  dialog.returnValue = "cancel";
  const editors: monaco.editor.IStandaloneCodeEditor[] = [];
  let models: monaco.editor.ITextModel[] = [];
  const clearModels = () => {
    editors.forEach(editor => editor.setModel(null));
    models.forEach(model => model.dispose());
    models = [];
  };
  let close = () => {};
  const decision = new Promise<string>(resolve => { close = () => resolve(dialog.returnValue); });
  dialog.addEventListener("close", close, { once: true });
  try {
    dialog.showModal();
    const plan = await Promise.race([load, decision.then(() => undefined)]);
    if (!plan || !dialog.open) return;
    for (const { tab } of plan.changes) {
      const option = element("option", "", tab.path);
      option.value = tab.path;
      picker.append(option);
    }
    picker.hidden = false;
    view.hidden = false;
    note.textContent = "Review the changes. Applying will edit the open buffers without saving them.";
    for (const [pane, label] of [["original", "Current Go buffer"], ["modified", "Proposed Go buffer"]]) {
      editors.push(monaco.editor.create(byId(`rename-preview-${pane}`), {
        automaticLayout: true, readOnly: true, domReadOnly: true, minimap: { enabled: false },
        scrollBeyondLastLine: false, ariaLabel: label,
      }));
    }
    const select = () => {
      const change = plan.changes[picker.selectedIndex];
      if (!change) return;
      clearModels();
      const original = monaco.editor.createModel(change.prepared.original, "go");
      models.push(original);
      const modified = monaco.editor.createModel(change.prepared.updated, "go");
      models.push(modified);
      const currentRanges: monaco.IRange[] = [];
      const proposedRanges: monaco.IRange[] = [];
      let offset = 0;
      for (const { range, text } of change.prepared.operations) {
        const start = original.getOffsetAt(monaco.Range.getStartPosition(range));
        const end = original.getOffsetAt(monaco.Range.getEndPosition(range));
        currentRanges.push(range);
        proposedRanges.push(monaco.Range.fromPositions(modified.getPositionAt(start + offset), modified.getPositionAt(start + offset + text.length)));
        offset += text.length - (end - start);
      }
      const highlight = (editor: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel, ranges: monaco.IRange[]) => {
        model.deltaDecorations([], ranges.map(range => ({ range, options: { isWholeLine: true, className: "rename-preview-change" } })));
        editor.setModel(model);
        editor.layout();
        if (ranges.length) editor.revealLineInCenter(ranges[0].startLineNumber);
        editor.render(true);
      };
      highlight(editors[0], original, currentRanges);
      highlight(editors[1], modified, proposedRanges);
    };
    picker.onchange = select;
    select();
    apply.disabled = false;
    if (await decision === "apply") return plan;
  } finally {
    picker.onchange = null;
    dialog.removeEventListener("close", close);
    if (dialog.open) dialog.close("cancel");
    clearModels();
    editors.forEach(editor => editor.dispose());
  }
}

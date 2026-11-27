import type { monaco } from "./editor";
import { CursorTestLookup } from "./go-test-target";
import { ProjectWorkflow } from "./project-workflow";

export function createCursorTestWorkflow(editor: Pick<monaco.editor.IStandaloneCodeEditor, "onDidChangeCursorPosition" | "onDidChangeModel">,
  reservationChanged: (reserved: boolean) => void) {
  const lookup = new CursorTestLookup();
  editor.onDidChangeCursorPosition(() => lookup.invalidate());
  editor.onDidChangeModel(() => lookup.invalidate());
  const projectWorkflow = new ProjectWorkflow(reserved => {
    if (reserved) lookup.invalidate();
    reservationChanged(reserved);
  });
  return { lookup, projectWorkflow };
}

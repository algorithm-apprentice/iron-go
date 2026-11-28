import type { DebugFrame, DebugInspectionState, DebugScope } from "./debug-inspection";
import { element, message } from "./dialogs";

const rowLimit = 400;
const depthLimit = 6;
const textLimit = 512;
const label = (value: string) => value.length <= textLimit ? value : `${value.slice(0, textLimit - 1)}…`;
const note = (text: string) => element("p", "view-note", text);

export class DebugInspectionView {
  private frames?: readonly DebugFrame[];
  private scopes?: readonly DebugScope[];
  private stackNote?: string;
  private scopesNote?: string;
  private readonly stackButtons = new Map<DebugFrame, HTMLButtonElement>();

  constructor(private readonly stack: HTMLElement, private readonly variables: HTMLElement) {}

  render(state?: DebugInspectionState) {
    if (!state) {
      this.frames = this.scopes = undefined;
      this.stackNote = this.scopesNote = undefined;
      this.stackButtons.clear();
      this.stack.replaceChildren();
      this.variables.replaceChildren();
      return;
    }
    if (this.frames !== state.frames || this.stackNote !== state.stackNote) {
      this.frames = state.frames;
      this.stackNote = state.stackNote;
      this.stackButtons.clear();
      this.stack.replaceChildren(...state.frames.map(frame => {
        const button = element("button", "button quiet debug-frame", label(frame.name));
        button.type = "button";
        button.addEventListener("click", () => state.select(frame));
        this.stackButtons.set(frame, button);
        return button;
      }), ...(state.stackNote ? [note(state.stackNote)] : []));
    }
    for (const [frame, button] of this.stackButtons) button.setAttribute("aria-pressed", String(frame === state.selected));
    if (this.scopes !== state.scopes || this.scopesNote !== state.scopesNote) {
      this.scopes = state.scopes;
      this.scopesNote = state.scopesNote;
      const budget = { remaining: rowLimit };
      this.variables.replaceChildren(...state.scopes.map(scope => this.branch(label(scope.name), scope.variablesReference, 1, state, budget)),
        ...(state.scopesNote ? [note(state.scopesNote)] : []));
    }
  }

  private branch(title: string, reference: number, depth: number, state: DebugInspectionState, budget: { remaining: number }): HTMLElement {
    if (!reference) return element("div", "debug-variable", title);
    if (depth > depthLimit) return element("div", "debug-variable", `${title} (maximum expansion depth)`);
    const details = element("details", "debug-scope");
    const summary = element("summary", "debug-variable", title);
    const body = element("div", "debug-variable-children");
    details.append(summary, body);
    let requested = false;
    const load = async () => {
      if (requested || !state.current()) return;
      requested = true;
      if (budget.remaining === 0) { body.replaceChildren(note("Variable display limit reached.")); return; }
      body.replaceChildren(note("Loading variables…"));
      try {
        const result = await state.load(reference);
        if (!result || !state.current()) return;
        const count = Math.min(result.variables.length, budget.remaining);
        budget.remaining -= count;
        body.replaceChildren(...result.variables.slice(0, count).map(variable => this.branch(
          `${label(variable.name)}: ${label(variable.value)}`, variable.variablesReference, depth + 1, state, budget,
        )));
        if (!count && !result.variables.length) body.append(note("No variables."));
        if (result.truncated || count < result.variables.length) body.append(note("More variables are available; display limited."));
      } catch (error) {
        if (!state.current()) return;
        const retry = element("button", "button quiet", "Retry");
        retry.type = "button";
        retry.addEventListener("click", () => { summary.focus(); requested = false; void load(); });
        body.replaceChildren(note(message(error)), retry);
      }
    };
    details.addEventListener("toggle", () => { if (details.open) void load(); });
    return details;
  }
}

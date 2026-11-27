import { byId, element } from "./dialogs";
import { icon, type Icon } from "./icons";
import type { TaskEvent } from "./workspace";

type Pane = "output" | "problems" | "references";
type Tone = "quiet" | "success" | "error" | "command";

export class Feedback {
  private readonly log = byId("output-log");
  private readonly output = byId("output-pane");
  private readonly decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  private tail: Text | undefined;

  constructor(private readonly layoutChanged: () => void) {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-panel]")) {
      button.addEventListener("click", () => this.show(button.dataset.panel as Pane));
    }
    byId("clear-output").addEventListener("click", () => this.clear());
    byId("toggle-panel").addEventListener("click", () => this.toggle());
    byId("status-problems").addEventListener("click", () => this.show("problems"));
  }

  toggle(visible = byId("panel").hidden) {
    const panel = byId("panel");
    const divider = byId("panel-resize");
    const toggle = byId("toggle-panel");
    const focused = document.activeElement;
    const restoreFocus = !visible && (panel.contains(focused) || focused === divider);
    panel.hidden = !visible;
    divider.hidden = !visible;
    toggle.setAttribute("aria-pressed", String(visible));
    if (restoreFocus) toggle.focus();
    this.layoutChanged();
  }

  show(pane: Pane) {
    this.toggle(true);
    for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-panel]")) {
      const active = tab.dataset.panel === pane;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
      byId(`${tab.dataset.panel}-pane`).hidden = !active;
    }
  }

  clear() {
    this.log.replaceChildren();
    this.tail = undefined;
  }

  row(text: string, tone: Tone = "quiet", mark?: Icon) {
    this.tail = undefined;
    const row = element("div", `log-row log-${tone}`);
    if (mark) {
      const glyph = element("span", "log-mark");
      glyph.innerHTML = icon(mark);
      row.append(glyph);
    }
    row.append(element("span", "", text));
    this.append(row);
  }

  private append(node: Node) {
    const atBottom = this.output.scrollHeight - this.output.scrollTop - this.output.clientHeight < 25;
    this.log.append(node);
    if (atBottom) this.output.scrollTop = this.output.scrollHeight;
  }

  private write(text: string) {
    if (!text) return;
    if (!this.tail) {
      this.tail = document.createTextNode("");
      this.append(this.tail);
    }
    const atBottom = this.output.scrollHeight - this.output.scrollTop - this.output.clientHeight < 25;
    this.tail.appendData(text);
    if (atBottom) this.output.scrollTop = this.output.scrollHeight;
  }

  task(event: TaskEvent): string | undefined {
    if (event.type === "started") {
      this.clear();
      this.decoders.stdout = new TextDecoder();
      this.decoders.stderr = new TextDecoder();
      this.row(`$ ${event.command}`, "command", "command");
    } else if (event.type === "output") {
      this.write(this.decoders[event.stream].decode(Uint8Array.from(event.bytes), { stream: true }));
    } else if (event.type === "notice") {
      this.row(event.message, "quiet", "info");
    } else {
      this.write(this.decoders.stdout.decode());
      this.write(this.decoders.stderr.decode());
      const result = event.cancelled ? "Task stopped" : event.code === null ? "Task ended without an exit code" : `Process exited with exit code ${event.code}`;
      this.row(result, event.success ? "success" : event.cancelled ? "quiet" : "error", event.success ? "check" : "info");
      return result;
    }
  }
}

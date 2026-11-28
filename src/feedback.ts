import { byId, element } from "./dialogs";
import { icon, type Icon } from "./icons";
import type { TaskEvent } from "./workspace";
import { GoTestStream, type TestResult, type TestSourceLocation } from "./go-test-stream";

type Pane = "output" | "problems" | "references" | "test-results" | "debug" | "terminal";
type Tone = "quiet" | "success" | "error" | "command";

export interface GoTestContext {
  expected?: { package: string; name: string };
  rerun(packageName: string, testName: string): (() => void) | undefined;
}

export class Feedback {
  private readonly log = byId("output-log");
  private readonly output = byId("output-pane");
  private readonly decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  private tail: Text | undefined;
  private tests?: GoTestStream;
  private testContext?: GoTestContext;
  private testing = false;
  private testRender?: number;
  private testOutputBudget = 0;
  private clipped = false;
  private readonly encoder = new TextEncoder();

  constructor(private readonly layoutChanged: () => void, private readonly resolveTestLocation: (location: TestSourceLocation) => (() => void) | undefined) {
    const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-panel]")];
    for (const button of tabs) {
      button.tabIndex = button.getAttribute("aria-selected") === "true" && !button.hidden ? 0 : -1;
      button.addEventListener("click", () => this.show(button.dataset.panel as Pane));
    }
    byId("output-tab").parentElement?.addEventListener("keydown", event => {
      if (!event.target || !(event.target instanceof HTMLButtonElement) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const visible = tabs.filter(button => !button.hidden);
      const current = visible.indexOf(event.target);
      if (current < 0 || !visible.length) return;
      let next: number;
      switch (event.key) {
        case "ArrowLeft": next = (current + visible.length - 1) % visible.length; break;
        case "ArrowRight": next = (current + 1) % visible.length; break;
        case "Home": next = 0; break;
        case "End": next = visible.length - 1; break;
        default: return;
      }
      event.preventDefault();
      const tab = visible[next];
      this.show(tab.dataset.panel as Pane);
      tab.focus();
    });
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
    this.select(pane);
    this.toggle(true);
  }

  private select(pane: Pane) {
    for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-panel]")) {
      const active = tab.dataset.panel === pane;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active && !tab.hidden ? 0 : -1;
      byId(`${tab.dataset.panel}-pane`).hidden = !active;
    }
  }

  hide(pane: Exclude<Pane, "output" | "problems">, focused = document.activeElement) {
    const tab = byId(`${pane}-tab`);
    const restore = focused === tab || byId(`${pane}-pane`).contains(focused);
    const wasSelected = tab.getAttribute("aria-selected") === "true";
    tab.hidden = true;
    tab.tabIndex = -1;
    if (wasSelected || restore) this.select("output");
    else byId(`${pane}-pane`).hidden = true;
    if (restore && !byId("panel").hidden) byId("output-tab").focus();
  }

  clear() {
    this.log.replaceChildren();
    this.tail = undefined;
  }

  clearTests() {
    this.tests = undefined;
    this.testContext = undefined;
    this.testing = false;
    window.clearTimeout(this.testRender);
    this.testRender = undefined;
    this.hide("test-results");
    byId("test-results-list").replaceChildren();
    byId("test-results-summary").textContent = "";
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

  private writeTestOutput(text: string) {
    if (!text || this.clipped) return;
    const bytes = this.encoder.encode(text);
    if (bytes.length <= this.testOutputBudget) {
      this.testOutputBudget -= bytes.length;
      this.write(text);
      return;
    }
    this.write(new TextDecoder().decode(bytes.subarray(0, this.testOutputBudget), { stream: true }));
    this.clipped = true;
    this.row("Visible output limit reached. Test results are still collected.", "quiet", "info");
  }

  private renderTests() {
    window.clearTimeout(this.testRender);
    this.testRender = undefined;
    const run = this.tests;
    if (!run) return;
    const label = (result: TestResult) => ({ running: "Running", pass: "Passed", fail: "Failed", skip: "Skipped", incomplete: "Incomplete" })[result.status];
    const row = (name: string, result: TestResult, packageName?: string) => {
      const box = element("div", "test-result-row");
      const jump = result.location && this.resolveTestLocation(result.location);
      if (jump) {
        const button = element("button", "button quiet test-result-link", name);
        button.title = `Open ${result.location!.absolute}:${result.location!.line}`;
        button.addEventListener("click", () => { if (this.tests === run) jump(); });
        box.append(button);
      } else box.append(element("span", "", name));
      const earlierFailure = result.status === "incomplete" && result.sawFailure ? " · earlier attempt failed" : "";
      const status = element("span", "test-result-status", `${label(result)}${earlierFailure}${result.elapsed === undefined ? "" : ` · ${result.elapsed.toFixed(2)} s`}`);
      status.dataset.result = result.status;
      box.append(status);
      const rerun = packageName && !this.testing && result.status === "fail" && this.testContext?.rerun(packageName, name);
      if (rerun) {
        const button = element("button", "button quiet test-result-rerun", "Rerun Matching Name");
        button.type = "button";
        button.title = "Run a fresh Go test with this name filter; Go may also execute parents and descendants.";
        button.addEventListener("click", () => { if (this.tests === run && !this.testing) rerun(); });
        box.append(button);
      }
      return box;
    };
    const groups: HTMLElement[] = [];
    for (const [name, pkg] of run.packages) {
      const group = element("section", "test-package");
      group.append(element("h3", "", name), row(pkg.failedBuild ? `Blocked by build: ${pkg.failedBuild}` : "Package", pkg));
      for (const [test, result] of pkg.tests) group.append(row(test, result, name));
      groups.push(group);
    }
    for (const [name, build] of run.buildFailures) {
      if (!build.failed) continue;
      const group = element("section", "test-package");
      group.append(element("h3", "", `Build: ${name}`), row(build.diagnostic ?? "Build failed", { status: "fail", location: build.location }));
      groups.push(group);
    }
    const expected = this.testContext?.expected;
    const missing = expected && !run.packages.get(expected.package)?.tests.get(expected.name)?.started;
    const summary = this.testing ? "Go tests are running…" : missing ?
      (run.incomplete ? "No run event was received for the selected test. Some results are incomplete." : "The selected test name did not run.") :
      run.incomplete ? "Some test results are incomplete." :
      groups.length ? "Go test run complete." : "No structured test results were reported. See Output.";
    byId("test-results-summary").textContent = summary;
    byId("test-results-list").replaceChildren(...groups);
  }

  private scheduleTestRender() {
    this.testRender ??= window.setTimeout(() => this.renderTests(), 75);
  }

  task(event: TaskEvent, testContext?: GoTestContext): string | undefined {
    if (event.type === "started") {
      this.clear();
      this.decoders.stdout = new TextDecoder();
      this.decoders.stderr = new TextDecoder();
      this.row(`$ ${event.command}`, "command", "command");
      if (event.structuredTests) {
        this.tests = new GoTestStream();
        this.testContext = testContext;
        this.testing = true;
        this.testOutputBudget = 512 * 1024;
        this.clipped = false;
        byId("test-results-tab").hidden = false;
        this.renderTests();
      }
    } else if (event.type === "output") {
      const bytes = Uint8Array.from(event.bytes);
      if (this.testing && this.tests) {
        const text = event.stream === "stdout" ? this.tests.push(bytes) : this.decoders.stderr.decode(bytes, { stream: true });
        this.writeTestOutput(text);
        this.scheduleTestRender();
      } else this.write(this.decoders[event.stream].decode(bytes, { stream: true }));
    } else if (event.type === "notice") {
      this.row(event.message, "quiet", "info");
    } else if (event.type === "output_limit") {
      if (this.testing && this.tests) {
        this.tests.wireTruncated();
        this.row("Go test event stream limit reached; results may be incomplete.", "quiet", "info");
        this.scheduleTestRender();
      } else this.row("Output limit reached; remaining output is hidden.", "quiet", "info");
    } else {
      if (this.testing && this.tests) {
        this.writeTestOutput(this.tests.finish(event.cancelled));
        this.writeTestOutput(this.decoders.stderr.decode());
        this.testing = false;
        this.renderTests();
      } else {
        this.write(this.decoders.stdout.decode());
        this.write(this.decoders.stderr.decode());
      }
      const result = event.cancelled ? "Task stopped" : event.code === null ? "Task ended without an exit code" : `Process exited with exit code ${event.code}`;
      this.row(result, event.success ? "success" : event.cancelled ? "quiet" : "error", event.success ? "check" : "info");
      return result;
    }
  }
}

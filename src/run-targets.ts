import { byId, element, message } from "./dialogs";
import { basename, dirname } from "./project-model";
import { host, type GoPackages, type Project } from "./workspace";

export class RunTargets {
  readonly picker = byId<HTMLSelectElement>("run-target");
  private readonly scope = byId<HTMLSelectElement>("package-scope");
  private readonly runPath = byId<HTMLInputElement>("manual-run-package");
  private readonly scopePath = byId<HTMLInputElement>("task-scope");
  private project?: Project;
  private info?: GoPackages;
  private generation = 0;
  private loading = false;
  private failure?: string;

  constructor(private readonly revealAdvanced: (focus: HTMLElement) => void, private readonly changed: () => void) {
    this.picker.addEventListener("change", () => {
      this.renderStatus();
      if (this.picker.value === "custom") this.revealAdvanced(this.runPath);
    });
    this.scope.addEventListener("change", () => {
      if (this.scope.value === "custom") this.revealAdvanced(this.scopePath);
    });
    this.runPath.addEventListener("input", () => this.renderStatus());
    byId("refresh-targets").addEventListener("click", () => { void this.refresh(); });
  }

  reset(project: Project) {
    this.project = project;
    this.generation++;
    this.info = undefined;
    this.failure = undefined;
    this.loading = false;
    this.picker.replaceChildren();
    this.scope.value = "all";
    this.runPath.value = "";
    this.scopePath.value = "./...";
    byId<HTMLDetailsElement>("advanced-targets").open = false;
    this.render("");
    void this.refresh();
  }

  async refresh() {
    const native = this.project?.native;
    if (!native) return;
    const previous = this.picker.value;
    const generation = ++this.generation;
    this.loading = true;
    this.failure = undefined;
    this.render(previous);
    try {
      const info = await host.discoverPackages(native.id);
      if (generation === this.generation) this.info = info;
    } catch (error) {
      if (generation === this.generation) {
        this.info = undefined;
        this.failure = message(error);
      }
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.render(this.picker.value || previous);
      }
    }
  }

  private render(previous: string) {
    const available = !!this.project?.native;
    const targets = this.info?.targets ?? [];
    const append = (value: string, label: string, title?: string) => {
      const row = element("option", "", label);
      row.value = value;
      if (title) row.title = title;
      this.picker.append(row);
    };
    this.picker.replaceChildren();
    if (!available) {
      append("", "No local target");
    } else {
      append("", targets.length ? "Choose a run target…" : this.loading ? "Scanning packages…" : "No executable package");
      const labels = targets.map(target => basename(target.importPath) || target.package);
      const counts = new Map<string, number>();
      for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
      for (const [index, target] of targets.entries()) {
        const label = labels[index];
        append(target.package, counts.get(label) === 1 ? label : `${label} — ${target.package}`, target.package);
      }
      append("custom", "Custom target…");
      this.picker.value = previous === "custom" || targets.some(target => target.package === previous)
        ? previous : targets.length === 1 ? targets[0].package : "";
    }
    this.renderStatus();
  }

  private renderStatus() {
    const selected = this.picker.value;
    this.picker.title = selected === "custom" ? this.runPath.value.trim() || "Custom run package" : selected || "Go executable package";
    byId("run-target-status").textContent = this.loading ? "Scanning Go packages…"
      : this.failure ?? (selected === "custom" ? this.runPath.value.trim() || "Enter a custom package below."
        : selected ? `Run target: ${selected}` : this.info?.targets.length ? "Choose a run target in the editor toolbar."
          : this.project?.native ? "No executable Go package found. Use Test, or choose a custom run target."
            : "Open a Go workspace to discover run targets.");
    this.changed();
  }

  primaryAction(): "run" | "test" {
    return this.info?.targets.length === 0 && this.picker.value !== "custom" ? "test" : "run";
  }

  setDisabled(busy: boolean, running: boolean) {
    const disabled = busy || running || !this.project?.native;
    this.picker.disabled = disabled;
    this.scope.disabled = disabled;
    this.runPath.disabled = disabled;
    this.scopePath.disabled = disabled;
    byId<HTMLButtonElement>("refresh-targets").disabled = disabled;
  }

  runArguments() {
    if (this.picker.value === "custom") {
      const value = this.runPath.value.trim();
      if (value) return [value];
      this.revealAdvanced(this.runPath);
      throw new Error("Enter a relative Go package for the custom target.");
    }
    if (this.picker.value) return [this.picker.value];
    this.picker.focus();
    throw new Error(this.loading ? "Still discovering Go packages." : "Choose a run target in the editor toolbar.");
  }

  buildTestArguments(activePath?: string) {
    if (this.scope.value === "current") {
      if (!activePath?.endsWith(".go")) throw new Error("Open a Go file to build or test its package.");
      return [packageForFile(activePath)];
    }
    if (this.scope.value === "custom") return [this.scopePath.value.trim()];
    if (this.loading && !this.info) throw new Error("Still discovering Go packages.");
    return this.info?.allScopes ?? ["./..."];
  }
}

export function packageForFile(path: string) {
  const dir = dirname(path);
  return dir ? `./${dir}` : ".";
}

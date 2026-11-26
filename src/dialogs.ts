import { fileIcon, icon, type Icon } from "./icons";

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Choice { label: string; detail?: string; icon: Icon; path?: string; run(): void }

export class Palette {
  private readonly dialog = byId<HTMLDialogElement>("palette");
  private readonly input = byId<HTMLInputElement>("palette-text");
  private readonly list = byId("palette-options");
  private options: Choice[] = [];
  private selected = 0;
  private choices: (query: string) => Choice[] = () => [];

  constructor() {
    this.input.addEventListener("input", () => this.update());
    this.input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.choose(this.options[this.selected]);
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!this.options.length) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        this.selected = (this.selected + delta + this.options.length) % this.options.length;
        this.highlight();
      }
    });
    this.dialog.addEventListener("click", event => { if (event.target === this.dialog) this.dialog.close(); });
  }

  show(label: string, choices: (query: string) => Choice[], initial = "") {
    this.choices = choices;
    this.input.value = initial;
    this.input.placeholder = label;
    byId("palette-hint").textContent = label;
    if (!this.dialog.open) this.dialog.showModal();
    this.update();
    this.input.focus();
    this.input.setSelectionRange(initial.length, initial.length);
  }

  private update() {
    this.options = this.choices(this.input.value);
    this.selected = 0;
    const nodes = this.options.map(option => {
      const row = element("button", "palette-option");
      row.type = "button";
      row.innerHTML = option.path ? fileIcon(option.path) : icon(option.icon);
      row.append(element("span", "", option.label));
      if (option.detail) row.append(element("span", "palette-description", option.detail));
      row.addEventListener("click", () => this.choose(option));
      return row;
    });
    if (!nodes.length) {
      this.list.replaceChildren(element("p", "view-note tree-note", "No matching entries."));
    } else {
      this.list.replaceChildren(...nodes);
      this.highlight();
    }
  }

  private highlight() {
    for (const [index, node] of [...this.list.children].entries()) {
      node.setAttribute("aria-current", String(index === this.selected));
      if (index === this.selected) node.scrollIntoView({ block: "nearest" });
    }
  }

  private choose(option?: Choice) {
    if (!option) return;
    this.dialog.close();
    option.run();
  }
}

interface Field { name: string; label: string; placeholder?: string; value?: string; maxLength?: number }
interface DialogSpec {
  title: string;
  description: string;
  submit?: string;
  fields: Field[];
  run(values: Record<string, string>): Promise<boolean | void>;
}

export class Forms {
  private readonly dialog = byId<HTMLDialogElement>("form-dialog");
  private readonly form = byId<HTMLFormElement>("dialog-form");
  private readonly submit = byId<HTMLButtonElement>("form-submit");
  private readonly error = byId("form-error");
  private spec?: DialogSpec;

  constructor() {
    this.dialog.addEventListener("cancel", event => { if (this.submit.disabled) event.preventDefault(); });
    this.form.addEventListener("submit", async event => {
      event.preventDefault();
      if (!this.spec || this.submit.disabled) return;
      this.error.hidden = true;
      const fields = Object.fromEntries([...new FormData(this.form)].map(([key, value]) => [key, String(value).trim()]));
      this.submit.disabled = true;
      try {
        if (await this.spec.run(fields) !== false) this.dialog.close();
      } catch (error) {
        this.error.textContent = message(error);
        this.error.hidden = false;
      } finally { this.submit.disabled = false; }
    });
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-dialog-close]")) {
      button.addEventListener("click", () => {
        if (button.dataset.dialogClose === "form-dialog" && this.submit.disabled) return;
        byId<HTMLDialogElement>(button.dataset.dialogClose!).close();
      });
    }
  }

  show(spec: DialogSpec) {
    if (this.dialog.open) return;
    this.spec = spec;
    byId("form-title").textContent = spec.title;
    byId("form-description").textContent = spec.description;
    this.error.hidden = true;
    this.submit.textContent = spec.submit ?? "Create";
    const fields = spec.fields.map(field => {
      const id = `form-${field.name}`;
      const row = element("div", "dialog-field");
      const label = element("label", "field-label", field.label);
      label.htmlFor = id;
      const input = element("input", "text-field mono");
      Object.assign(input, { id, name: field.name, required: true, autocomplete: "off", spellcheck: false, value: field.value ?? "", placeholder: field.placeholder ?? "", maxLength: field.maxLength ?? 256 });
      row.append(label, input);
      return row;
    });
    byId("form-fields").replaceChildren(...fields);
    this.dialog.showModal();
    fields[0]?.querySelector("input")?.select();
  }
}

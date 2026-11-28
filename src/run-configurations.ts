import { byId, element, message } from "./dialogs";
import { validateRelative } from "./project-model";
import type { RunLaunch } from "./workspace";

const prefix = "configuration:";
const storagePrefix = "irongo.runConfigurations:";
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).length;
const wellFormed = (value: string) => !/\p{Surrogate}/u.test(value);

type Profile = RunLaunch & { id: string; name: string; package: string };
type Saved = { version: 1; profiles: Profile[]; selected?: string };

function parseArgs(value: string) {
  let args: unknown;
  try { args = JSON.parse(value || "[]"); }
  catch { throw new Error("Arguments must be a JSON array of strings."); }
  return validateArgs(args);
}

function validateArgs(args: unknown) {
  if (!Array.isArray(args) || args.length > 128 || args.some(item => typeof item !== "string" || !wellFormed(item) || bytes(item) > 4096 || item.includes("\0"))) {
    throw new Error("Enter up to 128 valid Unicode argument strings, each within 4096 UTF-8 bytes.");
  }
  return args as string[];
}

function parseEnvironment(value: string) {
  const entries = new Map<string, string>();
  for (const line of value.split(/\r?\n/)) {
    if (!line) continue;
    const equals = line.indexOf("=");
    const key = line.slice(0, equals);
    const entry = line.slice(equals + 1);
    if (equals < 1 || !validEnvironmentEntry(key, entry)) {
      throw new Error("Use one NAME=value assignment per line with a valid environment name and value.");
    }
    if (entries.has(key)) throw new Error("An environment name appears twice in the same field.");
    entries.set(key, entry);
  }
  return Object.fromEntries(entries);
}

function validEnvironmentEntry(key: string, value: unknown): value is string {
  return /^[A-Za-z_][A-Za-z_0-9]{0,127}$/.test(key) && typeof value === "string" && wellFormed(value) && bytes(value) <= 4096 && !/[\0\r\n]/.test(value);
}

function validateLaunch(launch: RunLaunch) {
  const env = Object.entries(launch.environment);
  if (env.length > 64 || launch.args.reduce((sum, arg) => sum + bytes(arg), 0) +
    env.reduce((sum, [key, value]) => sum + bytes(key) + bytes(value), 0) > 64 * 1024) {
    throw new Error("The run arguments and environment exceed the supported limits.");
  }
  if (launch.directory !== ".") validateRelative(launch.directory);
  if (!wellFormed(launch.directory) || bytes(launch.directory) > 512) throw new Error("Enter a valid configured working directory within 512 UTF-8 bytes.");
}

function validateProfile(profile: Profile) {
  if (!profile.name.trim() || !wellFormed(profile.name) || bytes(profile.name) > 120) throw new Error("Enter a short configuration name.");
  if (profile.package !== ".") {
    if (!profile.package.startsWith("./") || !wellFormed(profile.package) || profile.package.includes("...") || bytes(profile.package) > 512) {
      throw new Error("Choose one relative Go package such as ./cmd/app.");
    }
    validateRelative(profile.package.slice(2));
  }
  validateLaunch(profile);
}

function readSaved(raw: string | null): Saved {
  const empty: Saved = { version: 1, profiles: [] };
  if (!raw || raw.length > 4 * 1024 * 1024) return empty;
  try {
    const decoded = JSON.parse(raw);
    if (decoded.version !== 1 || !Array.isArray(decoded.profiles)) return empty;
    const ids = new Set<string>();
    for (const record of decoded.profiles.slice(0, 32)) {
      try {
        if (!record || typeof record.id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(record.id) || ids.has(record.id) ||
          typeof record.name !== "string" || typeof record.package !== "string" || typeof record.directory !== "string" ||
          !record.environment || typeof record.environment !== "object" || Array.isArray(record.environment) ||
          Object.entries(record.environment).some(([key, value]) => !validEnvironmentEntry(key, value))) continue;
        const args = validateArgs(record.args);
        const environment = Object.fromEntries(Object.entries(record.environment)) as Record<string, string>;
        const profile: Profile = { id: record.id, name: record.name, package: record.package, directory: record.directory, args, environment };
        validateProfile(profile);
        ids.add(profile.id);
        empty.profiles.push(profile);
      } catch { /* Do not restore an invalid configuration. */ }
    }
    if (ids.has(decoded.selected)) empty.selected = decoded.selected;
    return empty;
  } catch { return empty; }
}

function formatEnvironment(environment: Record<string, string>) {
  return Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\n");
}

export class RunConfigurations {
  private readonly dialog = byId<HTMLDialogElement>("run-config-dialog");
  private readonly list = byId<HTMLSelectElement>("run-config-list");
  private readonly ephemeral = new Map<string, Map<string, Record<string, string>>>();
  private root?: string;
  private saved: Saved = { version: 1, profiles: [] };
  private field(id: string) { return byId<HTMLInputElement | HTMLTextAreaElement>(`run-config-${id}`); }

  constructor(private readonly packageForNew: () => string, private readonly selected: (value: string) => void) {
    this.list.addEventListener("change", () => this.populate());
    byId("run-config-form").addEventListener("submit", event => {
      event.preventDefault();
      try { this.save(); }
      catch (error) { this.error(message(error)); }
    });
    byId("run-config-delete").addEventListener("click", () => {
      try { this.remove(); } catch (error) { this.error(message(error)); }
    });
    byId("run-config-new").addEventListener("click", () => { this.list.value = ""; this.populate(); this.field("name").focus(); });
    byId("run-config-use").addEventListener("click", () => {
      if (!this.list.value) return;
      try {
        this.select(prefix + this.list.value);
        this.selected(prefix + this.list.value);
        this.dialog.close();
      } catch (error) { this.error(message(error)); }
    });
    this.dialog.addEventListener("close", () => { this.field("session").value = ""; });
  }

  reset(root?: string) {
    this.root = root;
    let raw = null;
    if (root) { try { raw = localStorage.getItem(storagePrefix + root); } catch { /* Use defaults. */ } }
    this.saved = readSaved(raw);
  }

  get restored() { return this.saved.selected ? prefix + this.saved.selected : ""; }

  options() { return this.saved.profiles.map(profile => ({ value: prefix + profile.id, name: profile.name, package: profile.package })); }

  select(value: string) {
    const selected = this.profile(value)?.id;
    if (selected !== this.saved.selected) this.persist({ ...this.saved, selected });
  }

  private profile(value: string) {
    return value.startsWith(prefix) ? this.saved.profiles.find(profile => prefix + profile.id === value) : undefined;
  }

  launch(value: string) {
    const profile = this.profile(value);
    if (!profile) return;
    const launch: RunLaunch = { directory: profile.directory, args: profile.args,
      environment: { ...profile.environment, ...this.ephemeral.get(this.root!)?.get(profile.id) } };
    validateLaunch(launch);
    return { package: profile.package, launch };
  }

  show(value: string) {
    if (!this.root || this.dialog.open) return;
    const blank = element("option", "", "New configuration");
    blank.value = "";
    this.list.replaceChildren(blank, ...this.saved.profiles.map(profile => {
      const option = element("option", "", profile.name);
      option.value = profile.id;
      return option;
    }));
    this.list.value = this.profile(value)?.id ?? "";
    this.populate();
    this.dialog.showModal();
    this.field("name").focus();
  }

  private populate() {
    const profile = this.saved.profiles.find(item => item.id === this.list.value);
    this.field("name").value = profile?.name ?? "";
    this.field("package").value = profile?.package ?? this.packageForNew();
    this.field("directory").value = profile?.directory ?? ".";
    this.field("arguments").value = JSON.stringify(profile?.args ?? [], null, 2);
    this.field("environment").value = formatEnvironment(profile?.environment ?? {});
    this.field("session").value = formatEnvironment(this.ephemeral.get(this.root!)?.get(profile?.id ?? "") ?? {});
    byId<HTMLButtonElement>("run-config-delete").disabled = !profile;
    byId<HTMLButtonElement>("run-config-use").disabled = !profile;
    this.error("");
  }

  private save() {
    if (!this.root) return;
    const index = this.saved.profiles.findIndex(profile => profile.id === this.list.value);
    if (index < 0 && this.saved.profiles.length >= 32) throw new Error("Delete a configuration before adding another.");
    const profile: Profile = {
      id: this.saved.profiles[index]?.id ?? crypto.randomUUID(), name: this.field("name").value.trim(),
      package: this.field("package").value.trim(), directory: this.field("directory").value.trim() || ".",
      args: parseArgs(this.field("arguments").value), environment: parseEnvironment(this.field("environment").value),
    };
    const session = parseEnvironment(this.field("session").value);
    validateProfile(profile);
    validateLaunch({ ...profile, environment: { ...profile.environment, ...session } });
    const profiles = [...this.saved.profiles];
    if (index < 0) profiles.push(profile);
    else profiles[index] = profile;
    this.persist({ version: 1, profiles, selected: profile.id });
    if (!this.ephemeral.has(this.root)) this.ephemeral.set(this.root, new Map());
    this.ephemeral.get(this.root)!.set(profile.id, session);
    this.selected(prefix + profile.id);
    this.dialog.close();
  }

  private remove() {
    const id = this.list.value;
    if (!id || !this.root) return;
    this.persist({ ...this.saved, profiles: this.saved.profiles.filter(profile => profile.id !== id),
      selected: this.saved.selected === id ? undefined : this.saved.selected });
    this.ephemeral.get(this.root)?.delete(id);
    this.selected(this.restored);
    this.dialog.close();
  }

  private persist(next: Saved) {
    if (!this.root) return;
    try { localStorage.setItem(storagePrefix + this.root, JSON.stringify(next)); }
    catch { throw new Error("Could not save Go run configurations. Previous settings were kept."); }
    this.saved = next;
  }

  private error(text: string) {
    const error = byId("run-config-error");
    error.textContent = text;
    error.hidden = !text;
  }
}

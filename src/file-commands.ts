export type FileCommand = "save" | "reload" | "format";

interface FileCommandContext {
  active?: { go: boolean; saving: boolean; reloading: boolean };
  blocked: boolean;
  busy: boolean;
  modal: boolean;
  desktop: boolean;
}

export function fileCommands({ active, blocked, busy, modal, desktop }: FileCommandContext) {
  const ready = !!active && !active.saving && !active.reloading && !blocked && !busy && !modal;
  return {
    save: { enabled: ready },
    reload: { enabled: ready },
    format: { enabled: ready && !!active.go && desktop,
      reason: ready && active.go && !desktop ? "Go formatting uses gofmt in the macOS desktop app." : undefined },
  };
}

type Activity = "decision" | "format" | "create";

export class FileActivity {
  private current?: { kind: Activity };
  private readonly changed: () => void;

  constructor(changed: () => void) { this.changed = changed; }
  get busy() { return this.current !== undefined; }
  get decision() { return this.current?.kind === "decision"; }

  reserve(kind: Activity) {
    if (this.current) return;
    const operation = { kind };
    this.current = operation;
    this.changed();
    return () => {
      if (this.current !== operation) return;
      this.current = undefined;
      this.changed();
    };
  }
}

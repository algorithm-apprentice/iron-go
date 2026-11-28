interface RecorderOptions<Project, View> {
  capture(): View;
  write(project: Project, revision: number, view: View, ticket?: number): Promise<void>;
  liveTicket(ticket: number): boolean;
  error(error: unknown): void;
}

export class EditorSessionRecorder<Project, View> {
  private readonly options: RecorderOptions<Project, View>;
  private owner?: { project?: Project; restoring: boolean; failed: boolean };
  private timer?: ReturnType<typeof setTimeout>;
  private writing?: Promise<void>;
  private dirty = false;
  private held = false;
  private paused = false;
  private revision = 0;

  constructor(options: RecorderOptions<Project, View>) { this.options = options; }

  beginProject(project?: Project) {
    clearTimeout(this.timer);
    this.dirty = false;
    const owner = { project, restoring: true, failed: false };
    this.owner = owner;
    return () => {
      if (this.owner !== owner) return;
      owner.restoring = false;
      this.changed();
    };
  }

  failRestore() { if (this.owner) this.owner.failed = true; }

  openedDocument() {
    if (this.owner && !this.owner.restoring) this.owner.failed = false;
  }

  holdDebounce(hold: boolean) {
    this.held = hold;
    clearTimeout(this.timer);
    if (!hold) this.changed();
  }

  pauseAutomatic(paused: boolean) {
    this.paused = paused;
    clearTimeout(this.timer);
    if (!paused) this.changed();
  }

  changed() {
    const owner = this.owner;
    if (owner?.project === undefined || owner.restoring || owner.failed) return;
    this.dirty = true;
    clearTimeout(this.timer);
    if (!this.held && !this.paused && !this.writing) this.timer = setTimeout(() => { void this.persist(undefined, true); }, 280);
  }

  flush(ticket?: number) { return this.persist(ticket, false); }

  private async persist(ticket: number | undefined, automatic: boolean) {
    clearTimeout(this.timer);
    this.dirty = false;
    const owner = this.owner;
    if (owner?.project === undefined || owner.restoring || owner.failed || (automatic && this.paused)) return;
    const snapshot = this.options.capture();
    const revision = ++this.revision;
    const current = () => this.owner === owner && (ticket === undefined || this.options.liveTicket(ticket));
    await this.writing;
    if (!current() || revision !== this.revision || (automatic && this.paused)) return;
    const writing = this.options.write(owner.project, revision, snapshot, ticket).catch(error => {
      if (current()) this.options.error(error);
    });
    this.writing = writing;
    try { await writing; }
    finally {
      if (this.writing === writing) this.writing = undefined;
      if (this.dirty) this.changed();
    }
  }
}

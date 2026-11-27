export class ProjectWorkflow {
  private reservation?: object;
  private readonly changed: (reserved: boolean) => void;

  constructor(changed: (reserved: boolean) => void) { this.changed = changed; }

  get busy() { return this.reservation !== undefined; }

  reserve() {
    if (this.busy) return undefined;
    const reservation = {};
    this.reservation = reservation;
    this.changed(true);
    return () => {
      if (this.reservation !== reservation) return;
      this.reservation = undefined;
      this.changed(false);
    };
  }

  async transition<T>(request: {
    ready(): boolean;
    confirm(): Promise<boolean>;
    choose(): Promise<T | undefined>;
    install(target: T): Promise<void>;
  }) {
    if (!request.ready()) return false;
    const release = this.reserve();
    if (!release) return false;
    try {
      if (!await request.confirm()) return false;
      const target = await request.choose();
      if (target === undefined) return false;
      await request.install(target);
      return true;
    } finally { release(); }
  }
}

export async function publishProjectSnapshot<P, S>(target: P, request: {
  current(): P;
  read(target: P): Promise<S>;
  apply(snapshot: S): void;
  fail(error: unknown): void;
}) {
  try {
    const snapshot = await request.read(target);
    if (request.current() === target) request.apply(snapshot);
  } catch (error) {
    if (request.current() === target) request.fail(error);
  }
}

export interface CodeLocation {
  path: string;
  anchorLine: number;
  anchorColumn: number;
  line: number;
  column: number;
  top: number;
  left: number;
}

interface Replay {
  current(): boolean;
  open(location: CodeLocation, activated: () => void): Promise<unknown>;
  inspect(path: string): Promise<{ kind: string } | undefined>;
}

const samePoint = (a: CodeLocation, b: CodeLocation) => a.path === b.path && a.line === b.line && a.column === b.column &&
  a.anchorLine === b.anchorLine && a.anchorColumn === b.anchorColumn;

export class NavigationHistory {
  private locations: CodeLocation[] = [];
  private index = -1;

  get entries(): readonly CodeLocation[] { return this.locations; }
  private get current() { return this.locations[this.index]; }

  reset() { this.locations = []; this.index = -1; }

  refresh(live: CodeLocation | undefined) {
    if (live && this.current?.path === live.path) this.locations[this.index] = live;
  }

  record(departure: CodeLocation | undefined, arrival: CodeLocation) {
    if (departure && samePoint(departure, arrival)) { this.refresh(arrival); return; }
    if (!departure && this.current && samePoint(this.current, arrival)) { this.refresh(arrival); return; }
    this.locations.splice(this.index + 1);
    if (departure) {
      if (this.current?.path === departure.path) this.refresh(departure);
      else this.locations.push(departure);
    }
    this.locations.push(arrival);
    if (this.locations.length > 100) this.locations.splice(0, this.locations.length - 100);
    this.index = this.locations.length - 1;
  }

  candidate(direction: -1 | 1) { return this.locations[this.index + direction]; }

  arrive(location: CodeLocation) {
    const index = this.locations.indexOf(location);
    if (index >= 0) this.index = index;
  }

  discard(location: CodeLocation) {
    const index = this.locations.indexOf(location);
    if (index < 0) return;
    this.locations.splice(index, 1);
    if (index <= this.index) this.index--;
  }

  async replay(direction: -1 | 1, { current, open, inspect }: Replay) {
    while (current()) {
      const location = this.candidate(direction);
      if (!location) return;
      try {
        await open(location, () => { if (current()) this.arrive(location); });
        return;
      } catch (error) {
        if (!current()) return;
        const observed = await inspect(location.path);
        if (!current()) return;
        if (observed?.kind !== "missing") throw error;
        this.discard(location);
      }
    }
  }

  updatePaths(map: (path: string) => string | undefined) {
    for (const entry of [...this.locations]) {
      const path = map(entry.path);
      if (path === undefined) this.discard(entry);
      else entry.path = path;
    }
  }
}

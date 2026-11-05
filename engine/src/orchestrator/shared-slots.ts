/**
 * One ceiling on agents across every engine on this Mac (Forge Desktop runs one engine per project). Each
 * engine writes how many agents it has in flight to its own file in a shared folder; before starting more, it
 * adds up the others' (skipping engines whose process is gone) and keeps the total under the ceiling. Engines
 * read each other between polls, so two starting at the same moment can briefly go one or two over.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface SlotFile {
  pid: number;
  inFlight: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class SharedSlots {
  private readonly file: string;

  constructor(
    private readonly dir: string,
    key: string,
    readonly ceiling: number,
    private readonly pid: number = process.pid,
  ) {
    this.file = join(dir, `${key.replace(/[^\w.-]/g, "_")}.json`);
  }

  /** Records this engine's agents in flight. */
  publish(inFlight: number): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify({ pid: this.pid, inFlight } satisfies SlotFile));
    } catch {
      // A folder we can't write only loses the shared view; this engine keeps its own limit.
    }
  }

  /** Agents in flight in the other live engines. */
  others(): number {
    let total = 0;
    let names: string[] = [];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return 0;
    }
    for (const name of names) {
      const path = join(this.dir, name);
      if (path === this.file) continue;
      try {
        const s = JSON.parse(readFileSync(path, "utf8")) as SlotFile;
        if (typeof s.pid === "number" && alive(s.pid)) total += Math.max(0, s.inFlight | 0);
        else rmSync(path, { force: true });
      } catch {
        // A half-written file counts as nothing this round.
      }
    }
    return total;
  }

  /** How many agents this engine may have in flight now, given its own count. Publishes that count. */
  limit(inFlight: number): number {
    this.publish(inFlight);
    return Math.max(0, this.ceiling - this.others());
  }

  /** This engine stopped: its agents no longer count. */
  close(): void {
    rmSync(this.file, { force: true });
  }
}

/**
 * Runaway guard (Forge Desktop): stops a card whose run fills the disk.
 *
 * The dispatch gate (inode-pressure.ts) only refuses to START cards on a full disk; nothing stopped a card that
 * was already filling it. A QA agent once wrote one 78 GB file in three minutes (a shell loop copying a file into
 * itself), the Mac dropped to 4% free and every card stopped with no reason on screen.
 *
 * Every 30 seconds this measures each running card's folder against its size when the guard first saw it:
 * - a folder that grew more than `maxGrowthBytes` (5 GB) in one run is stopped;
 * - when the disk is under `lowRatio` (10%) free, the card whose folder grew most (at least 1 GB) is stopped.
 * A stopped card isn't started again until it moves to another column or Start is pressed again; its folder is kept so
 * the person can see what happened. `snapshot()` is what the app shows.
 *
 * New in Forge Desktop.
 */
import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import type { Logger } from "pino";

const GB = 1024 ** 3;
export const MAX_GROWTH_BYTES = 5 * GB;
export const LOW_SPACE_MIN_GROWTH_BYTES = GB;
export const CHECK_EVERY_MS = 30_000;
export const LOW_RATIO = 0.1;

export interface RunningFolder {
  issueId: string;
  identifier: string;
  /** The card's column when it was measured. */
  stage: string;
  path: string | null;
}

export interface DiskStop {
  issueId: string;
  identifier: string;
  stage: string;
  grewBytes: number;
  why: "folder" | "disk";
  atMs: number;
}

export interface DiskSnapshot {
  /** Under `LOW_RATIO` free: no new card starts. */
  low_space: boolean;
  free_pct: number | null;
  stopped: Array<{ issue_identifier: string; grew_gb: number; why: "folder" | "disk"; at: string }>;
}

export interface GuardDeps {
  running: () => RunningFolder[];
  workspaceRoot: string;
  stop: (issueId: string, reason: string) => void;
  logger?: Logger;
  /** Overridable for tests. */
  measure?: (path: string) => Promise<number | null>;
  freeRatio?: (root: string) => Promise<number | null>;
  now?: () => number;
}

/** The folder's size in bytes (`du`, same disk only), or null when it can't be read in time. */
export function folderBytes(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("du", ["-skx", path], { timeout: 60_000 }, (err, stdout) => {
      const kb = Number.parseInt(String(stdout).trim().split(/\s/)[0] ?? "", 10);
      resolve(Number.isFinite(kb) ? kb * 1024 : err ? null : 0);
    });
  });
}

export async function diskFreeRatio(root: string): Promise<number | null> {
  try {
    const s = await statfs(root);
    const total = Number(s.blocks) * Number(s.bsize);
    return total > 0 ? (Number(s.bavail) * Number(s.bsize)) / total : null;
  } catch {
    return null;
  }
}

const gb = (bytes: number) => Math.round((bytes / GB) * 10) / 10;

export function stopReason(
  stop: Pick<DiskStop, "grewBytes" | "why">,
  freePct: number | null,
): string {
  const grew = `its folder grew by ${gb(stop.grewBytes)} GB in this run`;
  return stop.why === "folder"
    ? `Stopped: ${grew}. It won't start again until you move it or press Stop, then Start.`
    : `Stopped: the disk is almost full (${freePct ?? "?"}% free) and ${grew}, more than any other card. It won't start again until you move it or press Stop, then Start.`;
}

export class RunawayGuard {
  private readonly baseline = new Map<string, number>();
  private readonly stops = new Map<string, DiskStop>();
  private lastCheckMs = Number.NEGATIVE_INFINITY;
  private checking = false;
  private freePct: number | null = null;
  private lowSpace = false;

  constructor(
    private readonly maxGrowthBytes = MAX_GROWTH_BYTES,
    private readonly lowRatio = LOW_RATIO,
  ) {}

  /** A stopped card isn't started again (used as the dispatcher's `limited`). */
  holds(issueId: string): boolean {
    return this.stops.has(issueId);
  }

  /** Start was pressed: stopped cards may run again. */
  release(): void {
    this.stops.clear();
  }

  /** A stopped card the person moved to another column (or off the board) may run again. */
  forgetMoved(cards: Array<{ id: string; state: string }>): void {
    const stages = new Map(cards.map((c) => [c.id, c.state]));
    for (const [id, stop] of this.stops) if (stages.get(id) !== stop.stage) this.stops.delete(id);
  }

  snapshot(): DiskSnapshot {
    return {
      low_space: this.lowSpace,
      free_pct: this.freePct,
      stopped: [...this.stops.values()].map((s) => ({
        issue_identifier: s.identifier,
        grew_gb: gb(s.grewBytes),
        why: s.why,
        at: new Date(s.atMs).toISOString(),
      })),
    };
  }

  /** Runs `check` at most every `CHECK_EVERY_MS`, one at a time. Never throws. */
  async maybeCheck(deps: GuardDeps): Promise<void> {
    const now = (deps.now ?? Date.now)();
    if (this.checking || now - this.lastCheckMs < CHECK_EVERY_MS) return;
    this.checking = true;
    this.lastCheckMs = now;
    try {
      await this.check(deps);
    } catch (err) {
      deps.logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "runaway guard check failed",
      );
    } finally {
      this.checking = false;
    }
  }

  async check(deps: GuardDeps): Promise<void> {
    const measure = deps.measure ?? folderBytes;
    const running = deps.running().filter((r) => r.path);
    const live = new Set(running.map((r) => r.issueId));
    for (const id of this.baseline.keys()) if (!live.has(id)) this.baseline.delete(id);

    const grown: Array<{ card: RunningFolder; grew: number }> = [];
    for (const card of running) {
      const bytes = await measure(card.path as string);
      if (bytes === null) continue;
      const base = this.baseline.get(card.issueId);
      if (base === undefined) this.baseline.set(card.issueId, bytes);
      else grown.push({ card, grew: Math.max(0, bytes - base) });
    }

    const ratio = await (deps.freeRatio ?? diskFreeRatio)(deps.workspaceRoot);
    this.freePct = ratio === null ? null : Math.round(ratio * 100);
    this.lowSpace = ratio !== null && ratio < this.lowRatio;

    const now = (deps.now ?? Date.now)();
    let stopped = false;
    for (const { card, grew } of grown) {
      if (grew <= this.maxGrowthBytes) continue;
      this.stopCard(deps, card, grew, "folder", now);
      stopped = true;
    }
    if (stopped || !this.lowSpace) return;
    const worst = grown
      .filter((g) => g.grew >= LOW_SPACE_MIN_GROWTH_BYTES)
      .sort((a, b) => b.grew - a.grew)[0];
    if (worst) this.stopCard(deps, worst.card, worst.grew, "disk", now);
  }

  private stopCard(
    deps: GuardDeps,
    card: RunningFolder,
    grew: number,
    why: DiskStop["why"],
    now: number,
  ): void {
    const stop: DiskStop = {
      issueId: card.issueId,
      identifier: card.identifier,
      stage: card.stage,
      grewBytes: grew,
      why,
      atMs: now,
    };
    this.stops.set(card.issueId, stop);
    this.baseline.delete(card.issueId);
    const reason = stopReason(stop, this.freePct);
    deps.logger?.error(
      { identifier: card.identifier, grewBytes: grew, why, freePct: this.freePct, path: card.path },
      "runaway guard stopped a card",
    );
    deps.stop(card.issueId, reason);
  }
}

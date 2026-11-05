/**
 * Stops dev servers and other processes left running in card workspaces
 * (see `process/leftovers.ts` for how they are recognised). Three moments:
 *   - when a run takes a card's workspace lock, before the agent starts, so a
 *     previous run's server can't hold the port or serve stale code;
 *   - when the run releases the lock, after the agent has stopped;
 *   - every few minutes from the poll loop (first poll included), for cards
 *     no run holds: an engine that quit or crashed mid-run leaves them behind.
 * A card whose lock a live engine holds (a run is going on there, maybe in
 * another engine sharing the root) is never swept from the poll loop.
 */
import { join } from "node:path";
import type { Logger } from "pino";
import {
  type Leftover,
  type ListedProcess,
  listProcesses,
  pickLeftovers,
  stopLeftovers,
} from "../process/leftovers.js";
import { liveLockHolder } from "./lock.js";

/** How often the poll loop looks for leftovers. */
export const LEFTOVER_SWEEP_INTERVAL_MS = 3 * 60 * 1000;

/** Log message for stopped leftovers. */
export const LEFTOVERS_STOPPED = "Stopped processes left running in a card's workspace";

export interface LeftoverSweepOptions {
  /** Only this card folder (the caller holds its lock). Without it, every card no live run holds. */
  only?: string;
  logger?: Logger;
  graceMs?: number;
  list?: () => Promise<ListedProcess[]>;
}

/** Cards among `found` whose lock a live, non-orphaned engine holds. */
async function busyCards(root: string, found: Leftover[]): Promise<Set<string>> {
  const busy = new Set<string>();
  for (const card of new Set(found.map((l) => l.card))) {
    const holder = await liveLockHolder(join(root, card)).catch(() => null);
    if (holder && !holder.orphaned) busy.add(card);
  }
  return busy;
}

/** Find and stop leftovers under `root`; returns what was stopped. Never throws. */
export async function stopLeftoverServers(
  root: string,
  options: LeftoverSweepOptions = {},
): Promise<Leftover[]> {
  const { only, logger, graceMs } = options;
  const list = options.list ?? listProcesses;
  try {
    const rows = await list();
    let found = pickLeftovers(rows, { root, only });
    if (only === undefined && found.length > 0) {
      const busy = await busyCards(root, found);
      found = found.filter((l) => !busy.has(l.card));
    }
    if (found.length === 0) return [];
    const { stopped, survivors } = await stopLeftovers(found, { graceMs, list });
    for (const card of new Set(found.map((l) => l.card))) {
      const of = (ls: Leftover[]) =>
        ls.filter((l) => l.card === card).map((l) => `${l.pid} ${l.command}`);
      const fields = { root, card, stopped: of(stopped), survivors: of(survivors) };
      if (survivors.length > 0)
        logger?.warn(fields, `${LEFTOVERS_STOPPED}; some are still running`);
      else logger?.info(fields, LEFTOVERS_STOPPED);
    }
    return stopped;
  } catch (err) {
    logger?.warn({ root, err: String(err) }, "Looking for leftover processes failed");
    return [];
  }
}

/** Runs {@link stopLeftoverServers} from the poll loop: at once, then every interval, one at a time. */
export class LeftoverSweeper {
  private last = Number.NEGATIVE_INFINITY;
  private running: Promise<Leftover[]> | null = null;

  constructor(
    private readonly intervalMs = LEFTOVER_SWEEP_INTERVAL_MS,
    private readonly now: () => number = Date.now,
    private readonly sweep = stopLeftoverServers,
  ) {}

  /** The started sweep, or null when it isn't time yet or one is running. */
  maybeSweep(root: string | undefined, logger?: Logger): Promise<Leftover[]> | null {
    if (!root || this.running || this.now() - this.last < this.intervalMs) return null;
    this.last = this.now();
    this.running = this.sweep(root, { logger }).finally(() => {
      this.running = null;
    });
    return this.running;
  }
}

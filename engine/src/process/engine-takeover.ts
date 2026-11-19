/**
 * One engine per folder. An engine whose app is gone (launchd is its parent)
 * and that is still running in the folder a new engine is starting in is a
 * leftover: an app from before `FORGE_APP_PID` never told it to stop, or it
 * is still draining after its app died. Two engines on one folder share its
 * store and card locks and both dispatch, so a starting engine replaces it
 * first: SIGTERM (it drains, so running cards save their state), then SIGKILL
 * after the grace window.
 *
 * An engine is found the way leftover servers are (process/leftovers.ts):
 * the app starts each engine with its folder as its working folder, so a
 * leftover is a `node` with that exact cwd, launchd as parent and no
 * terminal. An engine whose app still runs is that app's own, never touched.
 *
 * New in Forge Desktop.
 */
import type { Logger } from "pino";
import { type ListedProcess, listProcesses, rootForms } from "./leftovers.js";

/** How long a leftover gets to drain (the engine's drain window is 20 s). */
export const TAKEOVER_GRACE_MS = 25_000;

export interface TakeoverOptions {
  graceMs?: number;
  logger?: Logger;
  list?: () => Promise<ListedProcess[]>;
}

/** Leftover engines of `home` among `rows` (see the file comment). */
export function pickLeftoverEngines(
  rows: ListedProcess[],
  home: string,
  self = process.pid,
): ListedProcess[] {
  const forms = new Set(rootForms(home));
  return rows.filter(
    (r) =>
      r.pid !== self &&
      r.ppid === 1 &&
      !r.terminal &&
      /^node\b/.test(r.command) &&
      forms.has(r.cwd),
  );
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone.
  }
};

async function gone(pids: number[], ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (pids.some(alive)) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

/** Stops every leftover engine of `home` and waits until they are gone; returns their pids. Never throws. */
export async function replaceLeftoverEngines(
  home: string,
  options: TakeoverOptions = {},
): Promise<number[]> {
  const { logger, graceMs = TAKEOVER_GRACE_MS } = options;
  let rows: ListedProcess[];
  try {
    rows = await (options.list ?? listProcesses)();
  } catch {
    return [];
  }
  const pids = pickLeftoverEngines(rows, home).map((r) => r.pid);
  if (pids.length === 0) return [];
  logger?.warn({ pids }, "Another engine was still running in this folder; stopping it first");
  for (const pid of pids) signal(pid, "SIGTERM");
  if (!(await gone(pids, graceMs))) {
    for (const pid of pids.filter(alive)) signal(pid, "SIGKILL");
    await gone(pids, 2000);
  }
  return pids;
}

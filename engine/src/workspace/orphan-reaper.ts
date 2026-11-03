/**
 * Reaping of a workspace dispatch lock that only orphaned agent processes keep
 * live (FRG-5429). When an orchestrator crashes and is relaunched, a surviving
 * process of its agent tree (a dev server, a watcher) keeps the lock live
 * forever (SPEC §9.6). Nothing observes such a process, so after a grace
 * period the new orchestrator terminates it and reclaims the lock.
 */
import type { Logger } from "pino";
import { isAlive, readProcStat } from "../process/procfs.js";
import { liveLockHolder, lockHolderLogFields, markedProcesses, reclaimIfStale } from "./lock.js";

/** How long a lock must stay orphan-held before its processes are reaped. */
export const ORPHAN_REAP_AFTER_MS = 60_000;

/** How long a reaped process gets to exit after SIGTERM before SIGKILL. */
export const ORPHAN_KILL_GRACE_MS = 5000;

/** How long SIGKILLed processes get to disappear. */
const KILL_WAIT_MS = 1000;

const POLL_MS = 50;

/** Log message for a reap of an orphan-held workspace lock. */
export const ORPHAN_LOCK_REAPED = "Reaped orphaned agent processes holding workspace lock";

export interface OrphanReapResult {
  /** Targets that are gone. */
  reapedPids: number[];
  /** Those that outlived SIGTERM and were sent SIGKILL. */
  killedPids: number[];
  /** Still running after SIGKILL (for example another user's: EPERM); the lock is kept. */
  survivors: number[];
  /** Whether the lock was reclaimed. */
  reclaimed: boolean;
}

/** Target pid → its start time when found, so a pid reuser is never signalled. */
type Targets = Map<number, string>;

/**
 * Add the processes marked as agents of `workspacePath`. Only marked
 * processes are ever targeted: a process group id or pid read from the lock
 * file may name an unrelated process by now (or be forged), but the marker is
 * inherited only within an agent tree of this workspace.
 */
function scanTargets(workspacePath: string, targets: Targets): void {
  for (const pid of markedProcesses(workspacePath)) {
    const startTime = readProcStat(pid)?.startTime;
    if (startTime && !targets.has(pid)) targets.set(pid, startTime);
  }
}

/** Whether target `pid` still runs: alive, not a zombie, and not a pid reuser. */
function running(pid: number, targets: Targets): boolean {
  if (!isAlive(pid)) return false;
  const stat = readProcStat(pid);
  return stat !== undefined && stat.startTime === targets.get(pid) && stat.state !== "Z";
}

function signalTargets(pids: number[], targets: Targets, sig: NodeJS.Signals): void {
  for (const pid of pids) {
    if (!running(pid, targets)) continue;
    try {
      process.kill(pid, sig);
    } catch {
      // ESRCH: already gone; EPERM: reported as a survivor.
    }
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms).unref?.());

/** Poll until every pid in `pids` stops running or `deadline` passes; returns the running ones. */
async function waitGone(pids: number[], targets: Targets, deadline: number): Promise<number[]> {
  let alive = pids.filter((pid) => running(pid, targets));
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(POLL_MS);
    alive = alive.filter((pid) => running(pid, targets));
  }
  return alive;
}

/**
 * Terminate the processes keeping `workspacePath`'s lock live when its holder
 * is orphaned (no orchestrator observes them), then reclaim the lock: SIGTERM,
 * up to `graceMs` to exit, SIGKILL to whatever is left (including processes
 * forked since the scan), and a reclaim only if nothing survived and the lock
 * is unchanged. Signals only marked processes, as single pids (never process
 * groups), each re-checked against its start time. Returns `null` when the
 * lock is free, or held by a live orchestrator.
 */
export async function reapOrphanedLock(
  workspacePath: string,
  options: { graceMs?: number; logger?: Logger } = {},
): Promise<OrphanReapResult | null> {
  const found = await liveLockHolder(workspacePath);
  if (!found?.orphaned) return null;
  const targets: Targets = new Map();
  scanTargets(workspacePath, targets);
  signalTargets([...targets.keys()], targets, "SIGTERM");
  await waitGone(
    [...targets.keys()],
    targets,
    Date.now() + (options.graceMs ?? ORPHAN_KILL_GRACE_MS),
  );

  // Children forked after the scan inherited the marker: SIGKILL them too.
  // Rescan only while the lock is unchanged: a new holder's agent carries the
  // same marker.
  const current = await liveLockHolder(workspacePath);
  if (current?.raw === found.raw) scanTargets(workspacePath, targets);
  const killedPids = [...targets.keys()].filter((pid) => running(pid, targets));
  signalTargets(killedPids, targets, "SIGKILL");
  const survivors = await waitGone(killedPids, targets, Date.now() + KILL_WAIT_MS);

  const reapedPids = [...targets.keys()].filter((pid) => !survivors.includes(pid));
  const reclaimed = survivors.length === 0 && (await reclaimIfStale(workspacePath, found.raw));
  const result = { reapedPids, killedPids, survivors, reclaimed };
  const fields = {
    workspacePath,
    ...lockHolderLogFields(found.holder, found.markedPids),
    ...result,
  };
  if (reclaimed) options.logger?.info(fields, ORPHAN_LOCK_REAPED);
  else options.logger?.warn(fields, `${ORPHAN_LOCK_REAPED}; lock is still held`);
  return result;
}

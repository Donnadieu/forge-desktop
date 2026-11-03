import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  AGENT_WORKSPACE_ENV,
  BOOT_ID,
  isAlive,
  processesWithEnv,
  readProcStat,
} from "../process/procfs.js";

/**
 * Lock file for `workspacePath`: a hidden sibling under the workspace root,
 * `<root>/.<workspace-dir>.forge-lock`. It deliberately lives outside the
 * workspace's git worktree, so `git clean` in a hook cannot delete it, an
 * agent's `git add -A` cannot commit it, and the lock can be taken before the
 * workspace directory is created or reset. Root sweeps only list directories.
 */
export function workspaceLockPath(workspacePath: string): string {
  return join(dirname(workspacePath), `.${basename(workspacePath)}.forge-lock`);
}

/**
 * Identifies this orchestrator process across restarts. A restarted container
 * often gets the same pid as its predecessor, so the pid alone cannot tell a
 * lock left by a previous incarnation from one this process holds.
 */
const PROCESS_TOKEN = randomUUID();

/** A real pid: never 0/-0 (our own group), 1 (init), or negative (`kill(-1)`: everything). */
const pidSchema = z.number().int().gt(1);

/** Contents of a workspace lock file. */
const WorkspaceLockHolderSchema = z.object({
  /** Orchestrator process that took the lock. */
  pid: pidSchema,
  /** Per-process random token (see {@link PROCESS_TOKEN}). */
  token: z.string().min(1),
  /** ISO timestamp of when the lock was taken. */
  startedAt: z.string(),
  /** Kernel boot id when the lock was taken (Linux). */
  bootId: z.string().optional(),
  /** Start time of `pid` (Linux), to detect pid reuse. */
  pidStartTime: z.string().optional(),
  /**
   * Process-group leader of the agent running in the workspace. The agent's
   * group outlives a crashed orchestrator, so it keeps the lock live until the
   * agent's whole process tree is gone.
   */
  agentPid: pidSchema.optional(),
  /** Start time of `agentPid` (Linux), to detect pid reuse. */
  agentStartTime: z.string().optional(),
});

export type WorkspaceLockHolder = z.infer<typeof WorkspaceLockHolderSchema>;

export interface WorkspaceLock {
  /**
   * Record the agent's process-group leader so the lock outlives a crash of
   * this process. Best-effort: never throws.
   */
  recordAgentPid(pid: number): Promise<void>;
  /** Remove the lock file if this lock still owns it. Never throws. */
  release(): Promise<void>;
}

/** Log message for a dispatch refused because another live process holds the workspace lock. */
export const WORKSPACE_LOCK_HELD = "Workspace lock held by a live process; skipping dispatch";

/** Structured log fields describing a lock holder and the marked processes keeping it live. */
export function lockHolderLogFields(holder: WorkspaceLockHolder, markedPids: number[]) {
  return {
    holderPid: holder.pid,
    holderAgentPid: holder.agentPid,
    holderStartedAt: holder.startedAt,
    holderMarkedPids: markedPids,
  };
}

export type WorkspaceLockResult =
  | { acquired: true; lock: WorkspaceLock }
  | { acquired: false; holder: WorkspaceLockHolder; markedPids: number[] };

/** Why a lock holder is (or is not) live. */
interface HolderLiveness {
  live: boolean;
  /**
   * Live only through agent processes (the `agentPid` group or marked
   * processes) that no orchestrator observes: the holder orchestrator is dead
   * or was a previous incarnation of this pid (FRG-5429).
   */
  orphaned: boolean;
  /**
   * Processes carrying the workspace's {@link AGENT_WORKSPACE_ENV} marker;
   * only scanned for when the holder orchestrator is not running.
   */
  markedPids: number[];
}

/** Processes marked as agents of `workspacePath` (other than this process and its ancestors). */
export function markedProcesses(workspacePath: string): number[] {
  return processesWithEnv(AGENT_WORKSPACE_ENV, resolve(workspacePath));
}

/** Whether the holder's orchestrator process is still running (not a pid reuser). */
function holderOrchestratorAlive(holder: WorkspaceLockHolder): boolean {
  if (holder.pid === process.pid || !isAlive(holder.pid)) return false;
  const startTime = holder.pidStartTime && readProcStat(holder.pid)?.startTime;
  // A different start time means an unrelated process reused the pid.
  return !startTime || startTime === holder.pidStartTime;
}

/** Whether the holder's agent process group still has members and is the agent's. */
function holderAgentGroupAlive(holder: WorkspaceLockHolder): boolean {
  if (holder.agentPid === undefined || !isAlive(-holder.agentPid)) return false;
  // The kernel never hands out a pid still in use as a group id, so a live
  // group is the agent's unless its leader pid now names a different process.
  const startTime = holder.agentStartTime && readProcStat(holder.agentPid)?.startTime;
  return !startTime || startTime === holder.agentStartTime;
}

/** Whether `holder` still guards `workspacePath`, and why. */
function holderLiveness(holder: WorkspaceLockHolder, workspacePath: string): HolderLiveness {
  if (holder.token === PROCESS_TOKEN) return { live: true, orphaned: false, markedPids: [] };
  // Every process recorded under a previous boot is gone, whatever owns its pid now.
  if (holder.bootId && BOOT_ID && holder.bootId !== BOOT_ID) {
    return { live: false, orphaned: false, markedPids: [] };
  }
  if (holderOrchestratorAlive(holder)) return { live: true, orphaned: false, markedPids: [] };
  // A crashed orchestrator's agent tree may survive outside the agent's own
  // process group (tools that started their own session): any process still
  // marked as an agent of this workspace keeps the lock live.
  const markedPids = markedProcesses(workspacePath);
  const live = holderAgentGroupAlive(holder) || markedPids.length > 0;
  return { live, orphaned: live, markedPids };
}

/** Locks are a few hundred bytes; anything larger is not one of ours. */
const MAX_LOCK_BYTES = 4096;

/**
 * The lock file's contents, or `null` when the path is not a small regular
 * file (a FIFO, device, symlink, or oversized file planted at the lock path
 * must not block or exhaust the reader). Throws when absent (ENOENT) or
 * unreadable (EACCES, EMFILE, ...): a lock that cannot be read is not stale.
 */
async function readLockFile(lockPath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") return null; // A symlink.
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return null;
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function readHolder(
  lockPath: string,
): Promise<{ raw: string | null; holder: WorkspaceLockHolder | null }> {
  const raw = await readLockFile(lockPath);
  try {
    const parsed = WorkspaceLockHolderSchema.safeParse(JSON.parse(raw ?? ""));
    if (parsed.success) return { raw, holder: parsed.data };
  } catch {
    // Fall through: an unparseable lock names no live holder.
  }
  return { raw, holder: null };
}

/** A live holder of a workspace lock, with why it is live. */
export interface LiveLockHolder {
  workspacePath: string;
  holder: WorkspaceLockHolder;
  /** See {@link HolderLiveness.orphaned}. */
  orphaned: boolean;
  markedPids: number[];
  /** The lock file's contents, so a reclaim can verify it is unchanged. */
  raw: string | null;
}

/** The holder of `workspacePath`'s lock if it is live, else `null`. */
export async function liveLockHolder(workspacePath: string): Promise<LiveLockHolder | null> {
  const current = await readHolder(workspaceLockPath(workspacePath)).catch(() => null);
  if (!current?.holder) return null;
  const { live, orphaned, markedPids } = holderLiveness(current.holder, workspacePath);
  return live
    ? { workspacePath, holder: current.holder, orphaned, markedPids, raw: current.raw }
    : null;
}

/**
 * Write `contents` to a sibling temp file, then `link` it into place (fails
 * with EEXIST when the lock exists) or `rename` it over the lock. Either way a
 * reader sees the old or the new contents, never a torn write.
 */
async function writeAtomic(lockPath: string, contents: string, replace: boolean): Promise<void> {
  const tmp = `${lockPath}.${process.pid}.${randomUUID()}`;
  await writeFile(tmp, contents);
  try {
    // A successful rename consumes the temp file; a link leaves it behind.
    if (replace) return await rename(tmp, lockPath);
    await link(tmp, lockPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await unlink(tmp).catch(() => {});
}

/**
 * Remove the stale lock whose contents were `staleRaw`. The lock is first
 * renamed to a unique name, so of two concurrent reclaimers only one moves the
 * stale file; one that instead moved a fresh lock (the other reclaimed first)
 * links it back. Not airtight: a third acquirer that creates a lock while the
 * fresh one is moved aside makes the link-back fail (SPEC §9.6 limitation).
 */
/**
 * Remove the lock only if it still holds `staleRaw`. Reclaimers take turns
 * through a short-lived `.reclaiming` directory (mkdir is atomic), so the check
 * and the removal can't interleave with another reclaimer. The previous
 * move-aside-and-link-back left a window where the live lock was briefly absent,
 * a third acquirer created a new one, and two acquirers both held the lock.
 */
async function reclaimStale(lockPath: string, staleRaw: string | null): Promise<void> {
  const gate = `${lockPath}.reclaiming`;
  for (let i = 0; ; i++) {
    try {
      await mkdir(gate);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return;
      // A gate left by a crashed reclaimer is cleared after RECLAIM_GATE_MS.
      const age = await stat(gate)
        .then((s) => Date.now() - s.mtimeMs)
        .catch(() => 0);
      if (age > RECLAIM_GATE_MS) await rmdir(gate).catch(() => {});
      if (i > 400) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  try {
    if ((await readLockFile(lockPath).catch(() => undefined)) === staleRaw) {
      await unlink(lockPath).catch(() => {});
    }
  } finally {
    await rmdir(gate).catch(() => {});
  }
}

const RECLAIM_GATE_MS = 10_000;

/**
 * Reclaim `workspacePath`'s lock if it still has the contents `expectedRaw`
 * and its holder is no longer live (FRG-5429: after its orphaned agent
 * processes were reaped). Returns `false` when the lock changed or is live.
 */
export async function reclaimIfStale(workspacePath: string, expectedRaw: string | null) {
  const lockPath = workspaceLockPath(workspacePath);
  const current = await readHolder(lockPath).catch((err: NodeJS.ErrnoException) =>
    err.code === "ENOENT" ? "absent" : null,
  );
  if (current === "absent") return true;
  if (!current || current.raw !== expectedRaw) return false;
  if (current.holder && holderLiveness(current.holder, workspacePath).live) return false;
  await reclaimStale(lockPath, current.raw);
  return true;
}

/**
 * Take the per-workspace dispatch lock ({@link workspaceLockPath}). A lock
 * whose holder is no longer live — dead orchestrator pid (or one reused by an
 * unrelated process, or one from a previous boot) and no surviving agent
 * process — is stale and reclaimed. Returns the live holder instead
 * when the workspace is in use. The workspace root must exist.
 */
export async function acquireWorkspaceLock(workspacePath: string): Promise<WorkspaceLockResult> {
  const lockPath = workspaceLockPath(workspacePath);
  const holder: WorkspaceLockHolder = {
    pid: process.pid,
    token: PROCESS_TOKEN,
    startedAt: new Date().toISOString(),
    bootId: BOOT_ID,
    pidStartTime: readProcStat(process.pid)?.startTime,
  };
  let contents = JSON.stringify(holder);

  const ownsLock = async (): Promise<boolean> =>
    (await readLockFile(lockPath).catch(() => null)) === contents;
  const lock: WorkspaceLock = {
    async recordAgentPid(pid: number): Promise<void> {
      if (holder.agentPid === pid || !(await ownsLock())) return;
      const agentStartTime = readProcStat(pid)?.startTime;
      const next = JSON.stringify({ ...holder, agentPid: pid, agentStartTime });
      try {
        await writeAtomic(lockPath, next, true);
        Object.assign(holder, { agentPid: pid, agentStartTime });
        contents = next;
      } catch {
        // Best-effort: the lock still guards this process's own lifetime.
      }
    },
    async release(): Promise<void> {
      if (await ownsLock()) await unlink(lockPath).catch(() => {});
    },
  };

  // Bounded: each extra pass follows reclaiming a stale lock or a lock that
  // vanished between the failed create and the read.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeAtomic(lockPath, contents, false);
      return { acquired: true, lock };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const current = await readHolder(lockPath).catch(() => null);
    if (!current) continue;
    if (current.holder) {
      const { live, markedPids } = holderLiveness(current.holder, workspacePath);
      if (live) return { acquired: false, holder: current.holder, markedPids };
    }
    await reclaimStale(lockPath, current.raw);
  }
  throw new Error(`Could not acquire ${lockPath}: lock is contended`);
}

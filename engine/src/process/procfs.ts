/**
 * Process-table helpers over Linux `/proc` (or, on macOS, `ps`: see
 * `ps-table.ts`), shared by the process-tree kill
 * (`process/process-tree.ts`), the workspace dispatch lock
 * (`workspace/lock.ts`), and its orphan reaper (`workspace/orphan-reaper.ts`).
 * Everything degrades to "unknown" (`undefined` / no
 * processes) where `/proc` is missing (non-Linux) or describes another pid
 * namespace, so callers must treat absence as "cannot tell", not "dead".
 */
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { macBootId, psPidsOfUid, psPidsWithEnv, psTable } from "./ps-table.js";

/**
 * Environment markers set by `spawnProcessGroup` (FRG-4527). Inherited by the
 * whole tree — including tools that start their own session (Claude Code's
 * Bash tool runs under `setsid`) or are reparented to init — so the tree can
 * be found without walking parent links.
 *
 * - `AGENT_TREE_ENV`: unique per spawned process tree (agent sessions and
 *   pipeline-stage CLIs alike); what the kill uses.
 * - `AGENT_WORKSPACE_ENV`: an agent session's workspace, set for agent
 *   sessions only (FRG-5427); what lock liveness uses.
 */
export const AGENT_TREE_ENV = "FORGE_AGENT_TREE";
export const AGENT_WORKSPACE_ENV = "FORGE_AGENT_WORKSPACE";

function readProc(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Whether `/proc` describes this process's own pid namespace. */
const PROC_IS_OURS = (() => {
  try {
    return readlinkSync("/proc/self") === String(process.pid);
  } catch {
    return false;
  }
})();

/** macOS has no `/proc`; the same questions are answered from `ps`. */
const USE_PS = !PROC_IS_OURS && process.platform === "darwin";

/** Kernel boot id: every process recorded under a different boot is gone. */
export const BOOT_ID = PROC_IS_OURS
  ? readProc("/proc/sys/kernel/random/boot_id")?.trim()
  : USE_PS
    ? macBootId()
    : undefined;

export interface ProcStat {
  /** One-letter state; `Z` is a zombie: exited, waiting to be reaped. */
  state: string;
  ppid: number;
  pgid: number;
  /** Clock ticks since boot; with {@link BOOT_ID} it tells a process from a pid reuser. */
  startTime: string;
}

/** `/proc/<pid>/stat`; fields are read after the last `)`, since `comm` may contain any. */
export function readProcStat(pid: number): ProcStat | undefined {
  if (USE_PS) {
    const row = psTable().get(pid);
    return row
      ? { state: row.stat.charAt(0), ppid: row.ppid, pgid: row.pgid, startTime: row.started }
      : undefined;
  }
  const stat = PROC_IS_OURS ? readProc(`/proc/${pid}/stat`) : undefined;
  if (!stat) return undefined;
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return {
    state: fields[0] ?? "",
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    startTime: fields[19] ?? "",
  };
}

/** Every pid in this namespace; empty when `/proc` is unavailable. */
export function listPids(): number[] {
  if (USE_PS) return [...psTable().keys()];
  if (!PROC_IS_OURS) return [];
  try {
    return readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map(Number);
  } catch {
    return [];
  }
}

/** Whether process `pid` (or, negative, process group `-pid`) exists. EPERM counts as alive. */
export function isAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * This process and its ancestors. Excluded from every agent-tree match, so an
 * orchestrator that itself runs inside an agent's tree never targets itself.
 */
function selfAndAncestors(): Set<number> {
  const chain = new Set<number>();
  for (let pid = process.pid; pid > 1 && !chain.has(pid); ) {
    chain.add(pid);
    pid = readProcStat(pid)?.ppid ?? 0;
  }
  return chain;
}

/**
 * Pids whose environment carries `name=value`, other than this process and
 * its ancestors. A process whose environment cannot be read (another user,
 * without root) is missed.
 */
export function processesWithEnv(name: string, value: string): number[] {
  const entry = `${name}=${value}`;
  const excluded = selfAndAncestors();
  if (USE_PS) return psPidsWithEnv(name, value).filter((pid) => !excluded.has(pid));
  return listPids().filter(
    (pid) =>
      !excluded.has(pid) &&
      (readProc(`/proc/${pid}/environ`)?.split("\0").includes(entry) ?? false),
  );
}

/** Descendants of `pid` by parent links (only those not yet reparented away). */
export function descendants(pid: number): number[] {
  const children = new Map<number, number[]>();
  for (const child of listPids()) {
    const ppid = readProcStat(child)?.ppid;
    if (ppid === undefined) continue;
    const siblings = children.get(ppid);
    if (siblings) siblings.push(child);
    else children.set(ppid, [child]);
  }
  const found: number[] = [];
  const stack = [...(children.get(pid) ?? [])];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    found.push(next);
    stack.push(...(children.get(next) ?? []));
  }
  return found;
}

/**
 * Live pids whose real, effective or saved uid is `uid` — every process that
 * user can signal or that can act as it. Zombies are left out: they have
 * exited and only wait for their parent.
 */
export function processesOfUid(uid: number): number[] {
  if (USE_PS) return psPidsOfUid(uid);
  return listPids().filter((pid) => {
    const status = readProc(`/proc/${pid}/status`);
    const ids = status?.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)/m);
    if (!ids || /^State:\s+Z/m.test(status ?? "")) return false;
    return ids.slice(1).map(Number).includes(uid);
  });
}

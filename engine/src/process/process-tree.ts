/**
 * Process-tree spawn and kill, shared by the agent adapters (FRG-4527) and the
 * pipeline-stage `claude` spawns (FRG-5427): a child is spawned as the leader
 * of its own process group and marked so {@link terminateChild} can kill the
 * whole tree, including descendants that start a session of their own.
 */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import {
  AGENT_TREE_ENV,
  AGENT_WORKSPACE_ENV,
  descendants,
  isAlive,
  processesWithEnv,
  readProcStat,
} from "./procfs.js";

/** How long a process gets to exit after SIGTERM before it is sent SIGKILL. */
export const KILL_GRACE_MS = 5000;

/** How often a group sweep re-checks whether the leader's descendants are gone. */
const GROUP_POLL_MS = 50;

/** How long a sweep waits for SIGKILLed groups to be reaped. */
const REAP_WAIT_MS = 1000;

/** Whether the process has actually exited (`killed` only means a signal was sent). */
export function hasExited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

const terminating = new WeakMap<ChildProcess, Promise<void>>();
/** Group leaders from {@link spawnProcessGroup}, with their {@link AGENT_TREE_ENV} marker. */
const groupLeaders = new WeakMap<ChildProcess, string>();
/** Live `killOnExit` leaders, until {@link terminateChild} has swept their tree. */
const exitKilled = new Set<ChildProcess>();

/** Options for {@link spawnProcessGroup}. */
export interface ProcessGroupOptions {
  /**
   * Mark the tree as a live agent session in this workspace, which keeps the
   * workspace dispatch lock held. Agent sessions only.
   */
  workspace?: string;
  /**
   * SIGKILL the tree if this process exits first: a group leader no longer
   * dies with its parent's process group, so a one-off child would otherwise
   * outlive a torn-down host (e.g. an MCP server killed by `killpg`). The
   * caller must {@link terminateChild} the child once it is done with it.
   */
  killOnExit?: boolean;
}

/**
 * Spawn a child as the leader of its own process group, marked so
 * {@link terminateChild} can find and signal its whole tree: tool children
 * (`make all`, vitest, shells) otherwise outlive the session and keep
 * mutating the workspace (FRG-4527). Only real `ChildProcess` objects (they
 * carry `spawnfile`) are registered — a test double's fabricated pid must
 * never be signalled as a host process group. A spawn made inside another
 * marked tree gets a fresh tree marker, so the outer kill finds it by parent
 * link only, not by environment scan.
 */
export function spawnProcessGroup(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  { workspace, killOnExit = false }: ProcessGroupOptions = {},
): ChildProcess {
  const tree = randomUUID();
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), [AGENT_TREE_ENV]: tree };
  delete env[AGENT_WORKSPACE_ENV]; // Never inherit an outer agent's marker.
  if (workspace !== undefined) env[AGENT_WORKSPACE_ENV] = resolvePath(workspace);
  const child = spawn(command, args, { ...options, env, detached: true });
  if (typeof child.spawnfile === "string" && child.pid !== undefined) {
    groupLeaders.set(child, tree);
    if (killOnExit) {
      if (exitKilled.size === 0) process.once("exit", killTreesOnExit);
      exitKilled.add(child);
    }
  }
  return child;
}

/** The `exit` hook: SIGKILL every `killOnExit` tree still running. */
function killTreesOnExit(): void {
  for (const child of exitKilled) {
    const tree = groupLeaders.get(child);
    if (child.pid === undefined || tree === undefined) continue;
    for (const pgid of treeGroups(child.pid, tree, !hasExited(child))) killGroup(pgid, "SIGKILL");
    killGroup(child.pid, "SIGKILL");
  }
}

function killGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // ESRCH: the group is already empty.
  }
}

const groupAlive = (pgid: number): boolean => isAlive(-pgid);

/**
 * Process groups of the agent tree other than the leader's own: processes
 * carrying the leader's tree marker — found even after a tool starts its own
 * session (Claude Code runs every Bash-tool shell under `setsid`) or is
 * reparented away from an exited leader — plus, while the leader is alive, its
 * descendants by parent link (covering any that cleared their environment).
 */
function treeGroups(pid: number, tree: string, leaderAlive: boolean): number[] {
  const members = processesWithEnv(AGENT_TREE_ENV, tree);
  if (leaderAlive) members.push(...descendants(pid));
  const ownGroup = readProcStat(process.pid)?.pgid;
  const groups = new Set<number>();
  for (const member of members) {
    const pgid = readProcStat(member)?.pgid;
    if (pgid !== undefined && pgid > 1 && pgid !== pid && pgid !== ownGroup) groups.add(pgid);
  }
  return [...groups];
}

/**
 * Signal every tree group, then the child's own group when it leads one, else
 * just the child.
 */
function signal(child: ChildProcess, sig: NodeJS.Signals, treeGroupIds: number[]): void {
  for (const pgid of treeGroupIds) killGroup(pgid, sig);
  if (groupLeaders.has(child) && child.pid !== undefined && groupAlive(child.pid)) {
    killGroup(child.pid, sig);
  } else if (!hasExited(child)) {
    child.kill(sig);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/** Poll until every group in `pgids` is empty or `deadline` passes; returns the live ones. */
async function waitForGroups(pgids: number[], deadline: number): Promise<number[]> {
  let alive = pgids.filter(groupAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(GROUP_POLL_MS);
    alive = alive.filter(groupAlive);
  }
  return alive;
}

/**
 * After the leader exits, wait for the rest of the tree to exit on the
 * SIGTERM it already received, then SIGKILL whatever is left at `deadline` —
 * including tree members that appeared since — and give the kernel a moment
 * to reap it.
 */
async function sweepGroups(
  pgids: number[],
  deadline: number,
  rescan: () => number[],
): Promise<void> {
  const alive = await waitForGroups(pgids, deadline);
  const left = [...new Set([...alive, ...rescan()])];
  for (const pgid of left) killGroup(pgid, "SIGKILL");
  if (left.length > 0) await waitForGroups(left, Date.now() + REAP_WAIT_MS);
}

/**
 * Send SIGTERM, escalate to SIGKILL after {@link KILL_GRACE_MS}, and resolve
 * once the process has exited. Idempotent: the abort listener and
 * `stopSession` share one termination per process (FRG-4086). For a child from
 * {@link spawnProcessGroup} every signal goes to the whole group, and the
 * promise resolves only once the rest of the agent's tree is gone too,
 * including members in process groups of their own (FRG-4527).
 */
export function terminateChild(child: ChildProcess): Promise<void> {
  const pending = terminating.get(child);
  if (pending) return pending;
  // No pid means spawn failed: there is no process, and `kill` on it could
  // signal our own process group.
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  const tree = groupLeaders.get(child);
  // A leader that already exited can still leave descendants in its tree.
  if (hasExited(child) && tree === undefined) return Promise.resolve();
  const exitedAtScan = hasExited(child);
  const treeGroupIds = tree === undefined ? [] : treeGroups(pid, tree, !exitedAtScan);

  const done = new Promise<void>((resolve) => {
    const deadline = Date.now() + KILL_GRACE_MS;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const onExit = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(escalation);
      // Only tree members can add members: none left after the leader means none to come.
      if (tree === undefined || (exitedAtScan && treeGroupIds.length === 0 && !groupAlive(pid))) {
        resolve();
        return;
      }
      const rescan = () => treeGroups(pid, tree, false);
      void sweepGroups([pid, ...treeGroupIds], deadline, rescan).then(resolve);
    };
    // Registered before the signal so a synchronous exit is not missed. A
    // late spawn error surfaces as `close` with no `exit` event.
    child.once("exit", onExit);
    child.once("close", onExit);
    signal(child, "SIGTERM", treeGroupIds);
    if (hasExited(child)) return onExit();
    escalation = setTimeout(() => {
      if (!hasExited(child)) signal(child, "SIGKILL", treeGroupIds);
    }, KILL_GRACE_MS);
    escalation.unref?.();
  });
  terminating.set(child, done);
  void done.then(() => {
    exitKilled.delete(child);
    if (exitKilled.size === 0) process.off("exit", killTreesOnExit);
  });
  return done;
}

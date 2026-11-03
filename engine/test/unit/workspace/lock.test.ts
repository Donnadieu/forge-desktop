import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupCompletedWorkspaceImpl } from "../../../src/workspace/cleanup.js";
import {
  acquireWorkspaceLock,
  liveLockHolder,
  workspaceLockPath,
} from "../../../src/workspace/lock.js";
import { waitFor } from "../../support/test-helpers.js";

/** Field 22 of `/proc/<pid>/stat` (the process start time), parsed independently of src. */
function procStartTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[22 - 3] as string;
}

/** A pid that existed and has exited (and been reaped). */
async function deadPid(): Promise<number> {
  const child = spawn("true");
  await once(child, "exit");
  return child.pid as number;
}

describe("workspace dispatch lock (FRG-4527)", () => {
  let root: string;
  let ws: string;
  let lockPath: string;
  const children: ChildProcess[] = [];

  function liveChild(detached = false): ChildProcess {
    const child = spawn("sleep", ["30"], { stdio: "ignore", detached });
    children.push(child);
    return child;
  }

  function writeHolder(holder: Record<string, unknown>): void {
    writeFileSync(lockPath, JSON.stringify({ startedAt: "2026-01-01T00:00:00Z", ...holder }));
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "forge-lock-"));
    ws = join(root, "MT-42");
    mkdirSync(ws);
    lockPath = workspaceLockPath(ws);
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });

  it("acquires a free workspace, records pid + start time, and releases it", async () => {
    const result = await acquireWorkspaceLock(ws);
    expect(result.acquired).toBe(true);
    const holder = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(holder.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(holder.startedAt))).toBe(false);
    if (result.acquired) await result.lock.release();
    expect(existsSync(lockPath)).toBe(false);
    // No temp files left behind.
    expect(readdirSync(root)).toEqual(["MT-42"]);
  });

  it("refuses a lock held by a live foreign pid", async () => {
    const holderPid = liveChild().pid as number;
    writeHolder({ pid: holderPid, token: "other-orchestrator" });
    const result = await acquireWorkspaceLock(ws);
    expect(result).toMatchObject({ acquired: false, holder: { pid: holderPid } });
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(holderPid);
  });

  it.skipIf(!existsSync("/proc/self/stat"))(
    "refuses a realistic foreign lock whose recorded start time matches the live pid",
    async () => {
      const holderPid = liveChild().pid as number;
      writeHolder({ pid: holderPid, token: "other", pidStartTime: procStartTime(holderPid) });
      expect((await acquireWorkspaceLock(ws)).acquired).toBe(false);
    },
  );

  it.skipIf(!existsSync("/proc/self/stat"))(
    "treats a live agent group whose leader pid was reused as stale",
    async () => {
      const agent = liveChild(true);
      const agentPid = agent.pid as number;
      writeHolder({ pid: await deadPid(), token: "crashed", agentPid, agentStartTime: "1" });
      expect(await liveLockHolder(ws)).toBeNull();
      writeHolder({
        pid: await deadPid(),
        token: "crashed",
        agentPid,
        agentStartTime: procStartTime(agentPid),
      });
      expect(await liveLockHolder(ws)).toMatchObject({ holder: { agentPid }, orphaned: true });
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "fails rather than reclaiming a live lock it cannot read",
    async () => {
      writeHolder({ pid: liveChild().pid, token: "other" });
      const foreign = readFileSync(lockPath, "utf8");
      chmodSync(lockPath, 0o000);
      await expect(acquireWorkspaceLock(ws)).rejects.toThrow(/contended/);
      chmodSync(lockPath, 0o600);
      expect(readFileSync(lockPath, "utf8")).toBe(foreign);
    },
  );

  it("keeps the lock outside the workspace's git worktree", () => {
    expect(lockPath).toBe(join(root, ".MT-42.forge-lock"));
  });

  it("can be taken before the workspace directory exists", async () => {
    rmSync(ws, { recursive: true });
    expect((await acquireWorkspaceLock(ws)).acquired).toBe(true);
  });

  it.each([-1, 0, 1, 1.5])("treats a lock naming pid %s as stale", async (pid) => {
    writeHolder({ pid, token: "tampered", agentPid: pid });
    expect((await acquireWorkspaceLock(ws)).acquired).toBe(true);
  });

  it.skipIf(!existsSync("/proc/sys/kernel/random/boot_id"))(
    "treats a holder recorded under a previous boot as stale, even if its pid is alive",
    async () => {
      writeHolder({ pid: liveChild().pid, token: "before-reboot", bootId: "previous-boot" });
      expect((await acquireWorkspaceLock(ws)).acquired).toBe(true);
    },
  );

  it.skipIf(!existsSync("/proc/self/stat"))(
    "treats a live pid with a different start time as reused, so stale",
    async () => {
      writeHolder({ pid: liveChild().pid, token: "reused", pidStartTime: "1" });
      expect((await acquireWorkspaceLock(ws)).acquired).toBe(true);
    },
  );

  it("lets exactly one of several concurrent acquirers reclaim a stale lock", async () => {
    writeHolder({ pid: await deadPid(), token: "crashed" });
    const results = await Promise.all(Array.from({ length: 8 }, () => acquireWorkspaceLock(ws)));
    expect(results.filter((r) => r.acquired)).toHaveLength(1);
    expect(readdirSync(root).sort()).toEqual([".MT-42.forge-lock", "MT-42"]);
  });

  it.each([
    ["a FIFO", (path: string) => execFileSync("mkfifo", [path])],
    ["a symlink", (path: string) => symlinkSync("/dev/zero", path)],
  ])("reclaims %s planted at the lock path without blocking on it", async (_kind, plant) => {
    plant(lockPath);
    expect(await liveLockHolder(ws)).toBeNull();
    expect((await acquireWorkspaceLock(ws)).acquired).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
  });

  it("ignores a live holder behind a symlink or in an oversized file", async () => {
    const live = JSON.stringify({ pid: liveChild().pid, token: "other", startedAt: "x" });
    writeFileSync(join(root, "target"), live);
    symlinkSync(join(root, "target"), lockPath);
    expect(await liveLockHolder(ws)).toBeNull();
    rmSync(lockPath);
    writeFileSync(lockPath, live + " ".repeat(5000));
    expect(await liveLockHolder(ws)).toBeNull();
  });

  it.skipIf(!existsSync("/proc/self/environ"))(
    "stays live while any process marked as this workspace's agent survives",
    async () => {
      // A crashed orchestrator's agent tool that started its own session: in
      // neither the dead holder's pid nor the recorded agent group.
      const tool = spawn("sleep", ["30"], {
        stdio: "ignore",
        env: { ...process.env, FORGE_AGENT_WORKSPACE: ws },
      });
      children.push(tool);
      await waitFor(() => readFileSync(`/proc/${tool.pid}/environ`, "utf8").includes(ws));
      writeHolder({ pid: await deadPid(), token: "crashed", agentPid: await deadPid() });
      expect((await acquireWorkspaceLock(ws)).acquired).toBe(false);
      tool.kill("SIGKILL");
      await once(tool, "exit");
      expect((await acquireWorkspaceLock(ws)).acquired).toBe(true);
    },
  );

  it("refuses a second acquisition by this same process", async () => {
    const first = await acquireWorkspaceLock(ws);
    expect(first.acquired).toBe(true);
    expect((await acquireWorkspaceLock(ws)).acquired).toBe(false);
  });

  it("reclaims a stale lock whose holder pid is dead", async () => {
    writeHolder({ pid: await deadPid(), token: "crashed-orchestrator" });
    const result = await acquireWorkspaceLock(ws);
    expect(result.acquired).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
  });

  it("reclaims a lock left by a previous incarnation that had this pid", async () => {
    writeHolder({ pid: process.pid, token: "previous-container-boot" });
    expect((await acquireWorkspaceLock(ws)).acquired).toBe(true);
  });

  it("reclaims an unparseable lock", async () => {
    writeFileSync(lockPath, "not json");
    expect((await acquireWorkspaceLock(ws)).acquired).toBe(true);
  });

  it("stays live while the agent's process group survives a dead orchestrator", async () => {
    const agent = liveChild(true);
    writeHolder({ pid: await deadPid(), token: "crashed", agentPid: agent.pid });
    expect((await acquireWorkspaceLock(ws)).acquired).toBe(false);
    agent.kill("SIGKILL");
    await once(agent, "exit");
    expect((await acquireWorkspaceLock(ws)).acquired).toBe(true);
  });

  it("recordAgentPid writes the agent pid into the held lock", async () => {
    const result = await acquireWorkspaceLock(ws);
    if (!result.acquired) throw new Error("expected lock");
    await result.lock.recordAgentPid(process.ppid);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      pid: process.pid,
      agentPid: process.ppid,
      ...(existsSync("/proc/self/stat") && { agentStartTime: procStartTime(process.ppid) }),
    });
    await result.lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("release leaves a lock it no longer owns alone", async () => {
    const result = await acquireWorkspaceLock(ws);
    if (!result.acquired) throw new Error("expected lock");
    writeHolder({ pid: liveChild().pid, token: "someone-else" });
    await result.lock.release();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("liveLockHolder reports only live holders", async () => {
    expect(await liveLockHolder(ws)).toBeNull();
    writeHolder({ pid: await deadPid(), token: "gone" });
    expect(await liveLockHolder(ws)).toBeNull();
    const pid = liveChild().pid;
    writeHolder({ pid, token: "alive" });
    expect(await liveLockHolder(ws)).toMatchObject({
      workspacePath: ws,
      holder: { pid },
      orphaned: false,
    });
  });

  it("recordAgentPid leaves a lock it no longer owns alone", async () => {
    const result = await acquireWorkspaceLock(ws);
    if (!result.acquired) throw new Error("expected lock");
    writeHolder({ pid: liveChild().pid, token: "someone-else" });
    const foreign = readFileSync(lockPath, "utf8");
    await result.lock.recordAgentPid(4321);
    expect(readFileSync(lockPath, "utf8")).toBe(foreign);
  });

  it("auto-GC removes an unlocked workspace and its lock file", async () => {
    const result = await cleanupCompletedWorkspaceImpl(
      ws,
      { validatePath: async () => {}, runBeforeRemoveHook: null },
      { minAgeMs: 0 },
    );
    expect(result.removed).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  it("auto-GC holds the lock while it deletes", async () => {
    let duringRemoval: boolean | undefined;
    await cleanupCompletedWorkspaceImpl(
      ws,
      {
        validatePath: async () => {},
        runBeforeRemoveHook: async () => {
          duringRemoval = (await acquireWorkspaceLock(ws)).acquired;
        },
      },
      { minAgeMs: 0 },
    );
    expect(duringRemoval).toBe(false);
  });

  it("auto-GC refuses to delete a workspace held by a live lock", async () => {
    writeHolder({ pid: liveChild().pid, token: "alive" });
    const result = await cleanupCompletedWorkspaceImpl(
      ws,
      { validatePath: async () => {}, runBeforeRemoveHook: null },
      { minAgeMs: 0 },
    );
    expect(result.removed).toBe(false);
    expect(result.reason).toMatch(/^locked by live pid/);
    expect(existsSync(ws)).toBe(true);
  });
});

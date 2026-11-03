import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveLockHolder, workspaceLockPath } from "../../../src/workspace/lock.js";
import { ORPHAN_LOCK_REAPED, reapOrphanedLock } from "../../../src/workspace/orphan-reaper.js";

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

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

// Marker scans read `/proc/<pid>/environ`, so the reap only works on Linux.
describe.skipIf(!existsSync("/proc/self/environ"))("reapOrphanedLock (FRG-5429)", () => {
  let root: string;
  let ws: string;
  const children: ChildProcess[] = [];

  /** A process of a crashed orchestrator's agent tree: carries the workspace marker. */
  function markedProcess(command: string, args: string[]): ChildProcess {
    const env = { ...process.env, FORGE_AGENT_WORKSPACE: resolve(ws) };
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], env });
    children.push(child);
    return child;
  }

  function writeHolder(holder: Record<string, unknown>): void {
    const contents = {
      token: "crashed-orchestrator",
      startedAt: "2026-10-01T00:00:00Z",
      ...holder,
    };
    writeFileSync(workspaceLockPath(ws), JSON.stringify(contents));
  }

  function fakeLogger() {
    return { info: vi.fn(), warn: vi.fn() };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "forge-reap-"));
    ws = join(root, "MT-42");
    mkdirSync(ws);
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });

  it("reaps a marked sleep holding a dead orchestrator's lock, then reclaims the lock", async () => {
    const sleeper = markedProcess("sleep", ["600"]);
    writeHolder({ pid: await deadPid() });

    expect(await liveLockHolder(ws)).toMatchObject({
      orphaned: true,
      markedPids: [sleeper.pid],
    });

    const logger = fakeLogger();
    const result = await reapOrphanedLock(ws, { logger: logger as unknown as Logger });

    expect(result).toEqual({
      reapedPids: [sleeper.pid],
      killedPids: [],
      survivors: [],
      reclaimed: true,
    });
    expect(existsSync(workspaceLockPath(ws))).toBe(false);
    await vi.waitFor(() => expect(exited(sleeper)).toBe(true));
    expect(sleeper.signalCode).toBe("SIGTERM");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: ws,
        holderMarkedPids: [sleeper.pid],
        reapedPids: [sleeper.pid],
        reclaimed: true,
      }),
      ORPHAN_LOCK_REAPED,
    );
  });

  it("SIGKILLs a marked process that ignores SIGTERM after the grace period", async () => {
    const stubborn = markedProcess(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');",
    ]);
    await once(stubborn.stdout as NodeJS.ReadableStream, "data");
    writeHolder({ pid: await deadPid() });

    const result = await reapOrphanedLock(ws, { graceMs: 300 });

    expect(result).toMatchObject({ killedPids: [stubborn.pid], survivors: [], reclaimed: true });
    await vi.waitFor(() => expect(exited(stubborn)).toBe(true));
    expect(stubborn.signalCode).toBe("SIGKILL");
  });

  it("reaps a lock left by a previous incarnation that had this pid", async () => {
    const sleeper = markedProcess("sleep", ["600"]);
    writeHolder({ pid: process.pid, token: "previous-container-boot" });

    expect((await reapOrphanedLock(ws))?.reclaimed).toBe(true);
    await vi.waitFor(() => expect(exited(sleeper)).toBe(true));
  });

  it("never reaps a lock whose orchestrator is still alive", async () => {
    const sleeper = markedProcess("sleep", ["600"]);
    const orchestrator = spawn("sleep", ["600"], { stdio: "ignore" });
    children.push(orchestrator);
    writeHolder({ pid: orchestrator.pid, token: "live-orchestrator" });
    const lock = readFileSync(workspaceLockPath(ws), "utf8");

    expect(await liveLockHolder(ws)).toMatchObject({ orphaned: false });
    expect(await reapOrphanedLock(ws)).toBeNull();
    expect(exited(sleeper)).toBe(false);
    expect(readFileSync(workspaceLockPath(ws), "utf8")).toBe(lock);
  });

  it("never signals an unmarked process, even in the recorded agent group", async () => {
    // The group id read from the lock may name an unrelated (or forged) group.
    const unmarked = spawn("sleep", ["600"], { stdio: "ignore", detached: true });
    children.push(unmarked);
    const agentPid = unmarked.pid as number;
    writeHolder({ pid: await deadPid(), agentPid, agentStartTime: procStartTime(agentPid) });

    expect(await liveLockHolder(ws)).toMatchObject({ orphaned: true, markedPids: [] });
    const logger = fakeLogger();
    const result = await reapOrphanedLock(ws, { logger: logger as unknown as Logger });

    expect(result).toEqual({ reapedPids: [], killedPids: [], survivors: [], reclaimed: false });
    expect(exited(unmarked)).toBe(false);
    expect(existsSync(workspaceLockPath(ws))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reclaimed: false }),
      `${ORPHAN_LOCK_REAPED}; lock is still held`,
    );
  });

  it("keeps a lock whose contents changed during the reap", async () => {
    const stubborn = markedProcess(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');",
    ]);
    await once(stubborn.stdout as NodeJS.ReadableStream, "data");
    const [oldPid, newPid] = [await deadPid(), await deadPid()];
    writeHolder({ pid: oldPid });

    // The lock changes during the grace period, after the SIGTERM.
    const reap = reapOrphanedLock(ws, { graceMs: 2000 });
    await new Promise((done) => setTimeout(done, 300));
    writeHolder({ pid: newPid, token: "new-holder" });
    const newLock = readFileSync(workspaceLockPath(ws), "utf8");

    expect(await reap).toEqual({
      reapedPids: [stubborn.pid],
      killedPids: [stubborn.pid],
      survivors: [],
      reclaimed: false,
    });
    expect(readFileSync(workspaceLockPath(ws), "utf8")).toBe(newLock);
  });

  it("does nothing for a free or stale lock", async () => {
    expect(await reapOrphanedLock(ws)).toBeNull();
    writeHolder({ pid: await deadPid() });
    expect(await reapOrphanedLock(ws)).toBeNull();
  });
});

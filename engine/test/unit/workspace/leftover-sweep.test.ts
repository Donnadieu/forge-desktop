import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListedProcess } from "../../../src/process/leftovers.js";
import { LeftoverSweeper, stopLeftoverServers } from "../../../src/workspace/leftover-sweep.js";
import { workspaceLockPath } from "../../../src/workspace/lock.js";
import { WorkspaceManager } from "../../../src/workspace/manager.js";

describe("stopLeftoverServers", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "forge-leftover-sweep-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  /** Fake process table: pids 'killed' disappear from the next listing. */
  function table(rows: ListedProcess[]) {
    const gone = new Set<number>();
    const kill = vi.spyOn(process, "kill").mockImplementation((pid: number) => {
      gone.add(pid);
      return true;
    });
    const list = async () => rows.filter((r) => !gone.has(r.pid));
    return { list, kill };
  }
  const row = (pid: number, card: string): ListedProcess => ({
    pid,
    ppid: 1,
    command: "ruby",
    cwd: join(root, card),
    terminal: false,
  });

  it("skips a card whose lock a live engine holds and logs what it stopped", async () => {
    writeFileSync(
      workspaceLockPath(join(root, "BC-2")),
      JSON.stringify({
        pid: process.ppid,
        token: "another-engine",
        startedAt: "2026-11-05T00:00:00Z",
      }),
    );
    const { list, kill } = table([row(70001, "BC-1"), row(70002, "BC-2")]);
    const info = vi.fn();
    const logger = { info, warn: vi.fn() } as never;

    const stopped = await stopLeftoverServers(root, { list, logger, graceMs: 100 });

    expect(stopped.map((l) => l.pid)).toEqual([70001]);
    expect(kill).toHaveBeenCalledWith(70001, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(70002, expect.anything());
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ card: "BC-1", stopped: ["70001 ruby"] }),
      expect.stringContaining("Stopped processes left running"),
    );
  });

  it("with only, stops that card's leftovers even though its lock is held (by the caller)", async () => {
    writeFileSync(
      workspaceLockPath(join(root, "BC-2")),
      JSON.stringify({ pid: process.ppid, token: "this-run", startedAt: "2026-11-05T00:00:00Z" }),
    );
    const { list } = table([row(70001, "BC-1"), row(70002, "BC-2")]);
    const stopped = await stopLeftoverServers(root, { only: "BC-2", list, graceMs: 100 });
    expect(stopped.map((l) => l.pid)).toEqual([70002]);
  });

  it("never throws when listing fails", async () => {
    const list = async (): Promise<ListedProcess[]> => {
      throw new Error("no lsof");
    };
    await expect(stopLeftoverServers(root, { list })).resolves.toEqual([]);
  });
});

describe("LeftoverSweeper", () => {
  it("sweeps on the first poll, then once per interval, one at a time", async () => {
    let now = 0;
    let finish: () => void = () => {};
    const sweep = vi.fn(
      () =>
        new Promise<never[]>((done) => {
          finish = () => done([]);
        }),
    );
    const sweeper = new LeftoverSweeper(1000, () => now, sweep);

    expect(sweeper.maybeSweep(undefined)).toBeNull();
    const first = sweeper.maybeSweep("/root");
    expect(first).not.toBeNull();
    now = 5000;
    expect(sweeper.maybeSweep("/root")).toBeNull(); // still running
    finish();
    await first;
    now = 5500;
    expect(sweeper.maybeSweep("/root")).not.toBeNull(); // interval passed since the first
    expect(sweeper.maybeSweep("/root")).toBeNull();
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});

describe("WorkspaceManager.acquireLock stops leftovers", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "forge-leftover-lock-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("once the lock is taken and again before it is released", async () => {
    const order: string[] = [];
    const stopLeftovers = vi.fn(async (_root: string, card: string) => {
      order.push(`stop ${card}`);
    });
    const manager = new WorkspaceManager({ root, hooks: {}, stopLeftovers });

    const locked = await manager.acquireLock("BC-7");
    expect(locked.acquired).toBe(true);
    if (!locked.acquired) return;
    order.push("agent runs");
    await locked.lock.release();

    expect(stopLeftovers).toHaveBeenCalledWith(root, "BC-7");
    expect(order).toEqual(["stop BC-7", "agent runs", "stop BC-7"]);
    // Released: a second acquire succeeds.
    expect((await manager.acquireLock("BC-7")).acquired).toBe(true);
  });

  it("does not stop anything when another holder has the lock", async () => {
    writeFileSync(
      workspaceLockPath(join(root, "BC-7")),
      JSON.stringify({ pid: process.ppid, token: "other", startedAt: "2026-11-05T00:00:00Z" }),
    );
    const stopLeftovers = vi.fn(async () => {});
    const manager = new WorkspaceManager({ root, hooks: {}, stopLeftovers });
    expect((await manager.acquireLock("BC-7")).acquired).toBe(false);
    expect(stopLeftovers).not.toHaveBeenCalled();
  });
});

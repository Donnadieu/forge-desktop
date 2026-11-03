import { afterEach, describe, expect, it, vi } from "vitest";

const { reapOrphanedLock } = vi.hoisted(() => ({ reapOrphanedLock: vi.fn() }));

vi.mock("../../../src/workspace/orphan-reaper.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  reapOrphanedLock,
}));

import { buildStateSnapshot } from "../../../src/orchestrator/snapshot.js";
import { createInitialState, type OrchestratorState } from "../../../src/orchestrator/types.js";
import {
  refreshWorkspaceLocks,
  suppressedByWorkspaceLock,
  type WorkspaceLockGateDeps,
} from "../../../src/orchestrator/workspace-lock-gate.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";
import type { LiveLockHolder } from "../../../src/workspace/lock.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";
import { ORPHAN_REAP_AFTER_MS } from "../../../src/workspace/orphan-reaper.js";

const issue: NormalizedIssue = {
  id: "a",
  identifier: "A",
  title: "t",
  description: "",
  state: "Todo",
  priority: 1,
  labels: [],
  blockedBy: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

function liveHolder(orphaned: boolean, markedPids = [4444]): LiveLockHolder {
  return {
    workspacePath: "/ws/A",
    holder: { pid: 4242, token: "crashed", startedAt: "2026-10-01T00:00:00Z", agentPid: 4343 },
    orphaned,
    markedPids,
    raw: "{}",
  };
}

function makeDeps(state: OrchestratorState, found: () => LiveLockHolder | null) {
  const warn = vi.fn();
  const lockHolder = vi.fn(async () => found());
  let stopped = false;
  let draining = false;
  const deps: WorkspaceLockGateDeps = {
    state,
    workspace: { lockHolder } as unknown as WorkspaceManager,
    config: { logger: { warn } as never },
    isStopped: () => stopped,
    isDraining: () => draining,
  };
  return {
    deps,
    warn,
    lockHolder,
    stop: () => (stopped = true),
    drain: () => (draining = true),
  };
}

/** Make the issue's lock look orphan-held for longer than the reap grace period. */
function ageOrphan(state: OrchestratorState): void {
  const entry = state.workspaceLocked.get("a");
  if (entry) entry.orphanedSinceMs = performance.now() - ORPHAN_REAP_AFTER_MS - 1;
}

afterEach(() => reapOrphanedLock.mockReset());

describe("workspace lock gate — orphan reap (FRG-5429)", () => {
  it("logs the marked pids and lists the refusal in the snapshot", async () => {
    const state = createInitialState();
    const { deps, warn } = makeDeps(state, () => liveHolder(true));

    expect(await suppressedByWorkspaceLock(deps, issue)).toBe(true);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ holderPid: 4242, holderMarkedPids: [4444], orphaned: true }),
      expect.any(String),
    );
    expect(buildStateSnapshot(state).workspaceLocked).toEqual([
      expect.objectContaining({
        issueId: "a",
        identifier: "A",
        holderPid: 4242,
        holderAgentPid: 4343,
        markedPids: [4444],
        orphaned: true,
        reaping: false,
      }),
    ]);
  });

  it("reaps an orphan-held lock once, only after the grace period", async () => {
    let finish: (value: null) => void = () => {};
    reapOrphanedLock.mockReturnValue(new Promise<null>((done) => (finish = done)));
    const state = createInitialState();
    const { deps } = makeDeps(state, () => liveHolder(true));
    await suppressedByWorkspaceLock(deps, issue);

    await refreshWorkspaceLocks(deps, [issue]);
    expect(reapOrphanedLock).not.toHaveBeenCalled();

    ageOrphan(state);
    await refreshWorkspaceLocks(deps, [issue]);
    await refreshWorkspaceLocks(deps, [issue]);
    expect(reapOrphanedLock).toHaveBeenCalledTimes(1);
    expect(reapOrphanedLock).toHaveBeenCalledWith("/ws/A", expect.anything());
    expect(buildStateSnapshot(state).workspaceLocked[0]?.reaping).toBe(true);
    // No dispatch while the reap may still SIGKILL marked processes.
    expect(await suppressedByWorkspaceLock(deps, issue)).toBe(true);

    finish(null);
    await vi.waitFor(() => expect(state.workspaceLocked.get("a")?.reaping).toBe(false));
    // A reap that left the lock held restarts the grace period.
    await refreshWorkspaceLocks(deps, [issue]);
    expect(reapOrphanedLock).toHaveBeenCalledTimes(1);
  });

  it("never reaps a lock held by a live orchestrator", async () => {
    const state = createInitialState();
    const { deps } = makeDeps(state, () => liveHolder(false));
    await suppressedByWorkspaceLock(deps, issue);
    ageOrphan(state);

    await refreshWorkspaceLocks(deps, [issue]);
    expect(reapOrphanedLock).not.toHaveBeenCalled();
    expect(state.workspaceLocked.get("a")?.orphanedSinceMs).toBeNull();
  });

  it("does not start a reap once the orchestrator is stopping or draining", async () => {
    for (const halt of ["stop", "drain"] as const) {
      const state = createInitialState();
      const gate = makeDeps(state, () => liveHolder(true));
      await suppressedByWorkspaceLock(gate.deps, issue);
      ageOrphan(state);
      gate[halt]();

      await refreshWorkspaceLocks(gate.deps, [issue]);
    }
    expect(reapOrphanedLock).not.toHaveBeenCalled();
  });

  it("does not reap a lock kept live only by the agent's process group", async () => {
    const state = createInitialState();
    const { deps } = makeDeps(state, () => liveHolder(true, []));
    await suppressedByWorkspaceLock(deps, issue);
    ageOrphan(state);

    await refreshWorkspaceLocks(deps, [issue]);
    expect(reapOrphanedLock).not.toHaveBeenCalled();
  });

  it("logs a failed reap and allows the next one after another grace period", async () => {
    reapOrphanedLock.mockRejectedValue(new Error("boom"));
    const state = createInitialState();
    const { deps, warn } = makeDeps(state, () => liveHolder(true));
    await suppressedByWorkspaceLock(deps, issue);
    ageOrphan(state);

    await refreshWorkspaceLocks(deps, [issue]);
    await vi.waitFor(() => expect(state.workspaceLocked.get("a")?.reaping).toBe(false));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: "a", err: expect.any(Error) }),
      "Reap of orphaned workspace lock failed",
    );
    ageOrphan(state);
    await refreshWorkspaceLocks(deps, [issue]);
    expect(reapOrphanedLock).toHaveBeenCalledTimes(2);
  });

  it("drops the entry once the lock is free", async () => {
    let found: LiveLockHolder | null = liveHolder(true);
    const state = createInitialState();
    const { deps } = makeDeps(state, () => found);
    await suppressedByWorkspaceLock(deps, issue);

    found = null;
    await refreshWorkspaceLocks(deps, [issue]);
    expect(state.workspaceLocked.size).toBe(0);
  });
});

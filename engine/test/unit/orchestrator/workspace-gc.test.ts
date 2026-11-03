import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconcileResult } from "../../../src/orchestrator/reconciler.js";
import type {
  OrchestratorConfig,
  OrchestratorState,
  RunningEntry,
} from "../../../src/orchestrator/types.js";
import { createInitialState } from "../../../src/orchestrator/types.js";
import { handleTerminalTransitions } from "../../../src/orchestrator/workspace-gc.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";

/**
 * Regression suite for FRG-1547 auto-GC. `handleTerminalTransitions` drives
 * one poll cycle's terminal-transition path — it settles complete/kill/retry
 * IDs via caller-supplied callbacks and fires cleanup on the snapshotted
 * workspace paths.
 *
 * We test this directly (not via the full Orchestrator) so the invariants
 * — "snapshot BEFORE settle", "toRetry is excluded", "cleanup errors never
 * propagate" — are pinned in isolation.
 */
describe("handleTerminalTransitions (auto-GC on terminal state)", () => {
  let state: OrchestratorState;
  let workspace: { cleanupCompletedWorkspace: ReturnType<typeof vi.fn> };
  let onComplete: ReturnType<typeof vi.fn>;
  let onKill: ReturnType<typeof vi.fn>;
  let onRetry: ReturnType<typeof vi.fn>;
  let onReconcile: ReturnType<typeof vi.fn>;

  /** Minimal RunningEntry — only the fields the GC path reads. */
  const makeRunning = (issueId: string, workspacePath: string | null): RunningEntry =>
    ({
      issueId,
      identifier: issueId,
      workspacePath,
    }) as unknown as RunningEntry;

  const configWithCleanup = (cleanup: boolean): OrchestratorConfig =>
    ({
      cleanupCompletedWorkspaces: cleanup,
      logger: undefined,
    }) as unknown as OrchestratorConfig;

  const makeReconcile = (overrides: Partial<ReconcileResult> = {}): ReconcileResult => ({
    toComplete: [],
    toKill: [],
    toRetry: [],
    staleIds: [],
    ...overrides,
  });

  beforeEach(() => {
    state = createInitialState();
    workspace = {
      cleanupCompletedWorkspace: vi.fn().mockResolvedValue({
        removed: true,
        reason: "ok",
        errors: [],
      }),
    };
    onComplete = vi.fn();
    onKill = vi.fn();
    onRetry = vi.fn();
    onReconcile = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Sanity: the settle callbacks a real Orchestrator supplies also remove the
  // RunningEntry from state.running. Simulate that so the "snapshot BEFORE
  // settle" invariant is exercised.
  const settleThatRemoves =
    (base: ReturnType<typeof vi.fn>) =>
    (issueId: string): void => {
      state.running.delete(issueId);
      base(issueId);
    };

  it("fires cleanup for toComplete entries", async () => {
    state.running.set("FRG-1", makeRunning("FRG-1", "/data/workspaces/FRG-1"));
    const cfg = configWithCleanup(true);

    handleTerminalTransitions(
      state,
      cfg,
      workspace as unknown as WorkspaceManager,
      makeReconcile({ toComplete: ["FRG-1"] }),
      {
        onComplete: settleThatRemoves(onComplete),
        onKill,
        onRetry,
        onReconcile,
      },
    );

    // Cleanup is fire-and-forget; give the microtask queue a tick.
    await new Promise((r) => setImmediate(r));

    expect(onComplete).toHaveBeenCalledWith("FRG-1");
    expect(workspace.cleanupCompletedWorkspace).toHaveBeenCalledWith("/data/workspaces/FRG-1");
    expect(onKill).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("fires cleanup for toKill entries", async () => {
    state.running.set("FRG-2", makeRunning("FRG-2", "/data/workspaces/FRG-2"));
    const cfg = configWithCleanup(true);

    handleTerminalTransitions(
      state,
      cfg,
      workspace as unknown as WorkspaceManager,
      makeReconcile({ toKill: ["FRG-2"] }),
      {
        onComplete,
        onKill: settleThatRemoves(onKill),
        onRetry,
        onReconcile,
      },
    );

    await new Promise((r) => setImmediate(r));

    expect(onKill).toHaveBeenCalledWith("FRG-2");
    expect(workspace.cleanupCompletedWorkspace).toHaveBeenCalledWith("/data/workspaces/FRG-2");
  });

  it("waits for a killed worker to exit before removing its workspace (FRG-4086)", async () => {
    state.running.set("FRG-5", makeRunning("FRG-5", "/data/workspaces/FRG-5"));
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    // The real kill moves the entry to `settling` until its after_run hook ends.
    const killIntoSettling = (issueId: string): void => {
      state.running.delete(issueId);
      state.settling.set(issueId, { identifier: issueId, exited });
      onKill(issueId);
    };

    handleTerminalTransitions(
      state,
      configWithCleanup(true),
      workspace as unknown as WorkspaceManager,
      makeReconcile({ toKill: ["FRG-5"] }),
      { onComplete, onKill: killIntoSettling, onRetry, onReconcile },
    );

    await new Promise((r) => setImmediate(r));
    expect(workspace.cleanupCompletedWorkspace).not.toHaveBeenCalled();

    exit();
    await new Promise((r) => setImmediate(r));
    expect(workspace.cleanupCompletedWorkspace).toHaveBeenCalledWith("/data/workspaces/FRG-5");
  });

  it("does NOT fire cleanup for toRetry entries (retry reuses the worktree)", async () => {
    state.running.set("FRG-3", makeRunning("FRG-3", "/data/workspaces/FRG-3"));
    const cfg = configWithCleanup(true);

    handleTerminalTransitions(
      state,
      cfg,
      workspace as unknown as WorkspaceManager,
      makeReconcile({ toRetry: ["FRG-3"] }),
      {
        onComplete,
        onKill,
        onRetry: settleThatRemoves(onRetry),
        onReconcile,
      },
    );

    await new Promise((r) => setImmediate(r));

    expect(onRetry).toHaveBeenCalledWith("FRG-3");
    // Critical invariant: retry MUST NOT delete the workspace.
    expect(workspace.cleanupCompletedWorkspace).not.toHaveBeenCalled();
  });

  it("snapshots workspacePath BEFORE settle callbacks remove the RunningEntry", async () => {
    state.running.set("FRG-4", makeRunning("FRG-4", "/data/workspaces/FRG-4"));
    state.running.set("FRG-5", makeRunning("FRG-5", "/data/workspaces/FRG-5"));
    const cfg = configWithCleanup(true);

    handleTerminalTransitions(
      state,
      cfg,
      workspace as unknown as WorkspaceManager,
      makeReconcile({ toComplete: ["FRG-4"], toKill: ["FRG-5"] }),
      {
        onComplete: settleThatRemoves(onComplete),
        onKill: settleThatRemoves(onKill),
        onRetry,
        onReconcile,
      },
    );

    await new Promise((r) => setImmediate(r));

    // Both entries were removed from state.running by the fake settle
    // callbacks, yet BOTH paths made it to cleanup — proving the snapshot
    // occurred BEFORE settlement.
    expect(state.running.size).toBe(0);
    expect(workspace.cleanupCompletedWorkspace).toHaveBeenCalledTimes(2);
    const calls = workspace.cleanupCompletedWorkspace.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(
      expect.arrayContaining(["/data/workspaces/FRG-4", "/data/workspaces/FRG-5"]),
    );
  });

  it("skips entries with a null workspacePath", async () => {
    state.running.set("FRG-6", makeRunning("FRG-6", null));
    const cfg = configWithCleanup(true);

    handleTerminalTransitions(
      state,
      cfg,
      workspace as unknown as WorkspaceManager,
      makeReconcile({ toComplete: ["FRG-6"] }),
      {
        onComplete: settleThatRemoves(onComplete),
        onKill,
        onRetry,
        onReconcile,
      },
    );

    await new Promise((r) => setImmediate(r));

    expect(onComplete).toHaveBeenCalledWith("FRG-6");
    expect(workspace.cleanupCompletedWorkspace).not.toHaveBeenCalled();
  });

  it("skips cleanup entirely when cleanupCompletedWorkspaces is false", async () => {
    state.running.set("FRG-7", makeRunning("FRG-7", "/data/workspaces/FRG-7"));
    const cfg = configWithCleanup(false);

    handleTerminalTransitions(
      state,
      cfg,
      workspace as unknown as WorkspaceManager,
      makeReconcile({ toComplete: ["FRG-7"], toKill: ["FRG-7"] }),
      {
        onComplete: settleThatRemoves(onComplete),
        onKill: settleThatRemoves(onKill),
        onRetry,
        onReconcile,
      },
    );

    await new Promise((r) => setImmediate(r));

    // Settlement still happens; only the cleanup call is suppressed.
    expect(onComplete).toHaveBeenCalledWith("FRG-7");
    expect(workspace.cleanupCompletedWorkspace).not.toHaveBeenCalled();
  });

  it("fires onReconcile with (killed, retried) IDs after settlement", async () => {
    state.running.set("FRG-8", makeRunning("FRG-8", "/data/workspaces/FRG-8"));
    state.running.set("FRG-9", makeRunning("FRG-9", "/data/workspaces/FRG-9"));
    const cfg = configWithCleanup(true);

    handleTerminalTransitions(
      state,
      cfg,
      workspace as unknown as WorkspaceManager,
      makeReconcile({ toKill: ["FRG-8"], toRetry: ["FRG-9"] }),
      {
        onComplete,
        onKill: settleThatRemoves(onKill),
        onRetry: settleThatRemoves(onRetry),
        onReconcile,
      },
    );

    expect(onReconcile).toHaveBeenCalledWith(["FRG-8"], ["FRG-9"]);
  });

  it("does not throw when onReconcile is omitted", async () => {
    state.running.set("FRG-10", makeRunning("FRG-10", "/data/workspaces/FRG-10"));
    const cfg = configWithCleanup(true);

    expect(() =>
      handleTerminalTransitions(
        state,
        cfg,
        workspace as unknown as WorkspaceManager,
        makeReconcile({ toComplete: ["FRG-10"] }),
        {
          onComplete: settleThatRemoves(onComplete),
          onKill,
          onRetry,
        },
      ),
    ).not.toThrow();
  });

  it("cleanup errors are swallowed and do NOT propagate to the caller", async () => {
    state.running.set("FRG-11", makeRunning("FRG-11", "/data/workspaces/FRG-11"));
    const cfg = configWithCleanup(true);

    // Simulate a cleanup that throws — poll loop must survive it.
    workspace.cleanupCompletedWorkspace.mockRejectedValueOnce(new Error("rmSync boom"));

    // Synchronous call must not throw.
    expect(() =>
      handleTerminalTransitions(
        state,
        cfg,
        workspace as unknown as WorkspaceManager,
        makeReconcile({ toComplete: ["FRG-11"] }),
        {
          onComplete: settleThatRemoves(onComplete),
          onKill,
          onRetry,
          onReconcile,
        },
      ),
    ).not.toThrow();

    // Give the fire-and-forget cleanup time to reject; the caller must not
    // see an unhandled rejection.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(workspace.cleanupCompletedWorkspace).toHaveBeenCalledWith("/data/workspaces/FRG-11");
  });

  it("no-ops when the reconcile result has no terminal transitions", async () => {
    const cfg = configWithCleanup(true);

    handleTerminalTransitions(
      state,
      cfg,
      workspace as unknown as WorkspaceManager,
      makeReconcile(),
      {
        onComplete,
        onKill,
        onRetry,
        onReconcile,
      },
    );

    await new Promise((r) => setImmediate(r));

    expect(onComplete).not.toHaveBeenCalled();
    expect(onKill).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    expect(workspace.cleanupCompletedWorkspace).not.toHaveBeenCalled();
    // onReconcile IS called (matches existing orchestrator behavior — the
    // callback fires even with empty arrays, so operators see the tick).
    expect(onReconcile).toHaveBeenCalledWith([], []);
  });
});

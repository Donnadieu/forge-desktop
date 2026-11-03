import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialState, type OrchestratorState } from "../../../src/orchestrator/types.js";
import {
  runTerminalWorkspaceSweep,
  WorkspaceSweeper,
} from "../../../src/orchestrator/workspace-periodic-sweep.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { NormalizedIssue, TrackerConfig } from "../../../src/tracker/types.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";

function makeIssue(identifier: string, state: string): NormalizedIssue {
  return {
    id: `id-${identifier}`,
    identifier,
    title: "t",
    description: "",
    state,
    priority: 2,
    labels: [],
    blockedBy: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

const trackerConfig: TrackerConfig = {
  kind: "memory",
  project_slug: "test",
  active_states: ["Todo", "In Progress", "Merging"],
  terminal_states: ["Done", "Cancelled"],
};

function makeWorkspace(): WorkspaceManager & {
  cleanupCompletedWorkspace: ReturnType<typeof vi.fn>;
} {
  return {
    cleanupCompletedWorkspace: vi
      .fn()
      .mockResolvedValue({ removed: true, reason: "ok", errors: [] }),
  } as unknown as WorkspaceManager & { cleanupCompletedWorkspace: ReturnType<typeof vi.fn> };
}

describe("runTerminalWorkspaceSweep", () => {
  let root: string;
  let state: OrchestratorState;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "forge-periodic-sweep-"));
    state = createInitialState();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const mk = (...names: string[]) => {
    for (const n of names) mkdirSync(join(root, n));
  };

  it("removes only workspaces whose tickets are terminal", async () => {
    mk("FRG-1", "FRG-2", "FRG-3", "FRG-4", "FRG-5");
    const tracker = new MemoryTracker([
      makeIssue("FRG-1", "Done"),
      makeIssue("FRG-2", "Cancelled"),
      makeIssue("FRG-3", "In Progress"),
      makeIssue("FRG-4", "Merging"),
      // FRG-5 unknown to the tracker — never touched.
    ]);
    const workspace = makeWorkspace();
    const result = await runTerminalWorkspaceSweep({
      workspaceRoot: root,
      tracker,
      trackerConfig,
      workspace,
      state,
      logger: undefined,
      reason: "periodic",
      hasOpenHandles: async () => false,
    });
    const removed = workspace.cleanupCompletedWorkspace.mock.calls.map((c) => c[0]).sort();
    expect(removed).toEqual([join(root, "FRG-1"), join(root, "FRG-2")]);
    expect(result).toEqual({ scanned: 5, removed: 2, skipped: 3 });
  });

  it("skips running, exiting, retrying, preserved and open workspaces", async () => {
    mk("FRG-1", "FRG-2", "FRG-3", "FRG-4", "FRG-5");
    const tracker = new MemoryTracker(
      ["FRG-1", "FRG-2", "FRG-3", "FRG-4", "FRG-5"].map((i) => makeIssue(i, "Done")),
    );
    state.running.set("id-FRG-1", { identifier: "FRG-1" } as never);
    state.retryAttempts.set("id-FRG-2", { identifier: "FRG-2" } as never);
    state.preserveWorkspacePaths.add(join(root, "FRG-3"));
    // Killed, but its process has not exited yet (FRG-4086).
    state.settling.set("id-FRG-5", { identifier: "FRG-5", exited: new Promise(() => {}) });
    const workspace = makeWorkspace();
    const result = await runTerminalWorkspaceSweep({
      workspaceRoot: root,
      tracker,
      trackerConfig,
      workspace,
      state,
      logger: undefined,
      reason: "pressure",
      hasOpenHandles: async (p) => p.endsWith("FRG-4"),
    });
    expect(workspace.cleanupCompletedWorkspace).not.toHaveBeenCalled();
    expect(result.removed).toBe(0);
  });

  it("sweeps nothing when the tracker read fails", async () => {
    mk("FRG-1");
    const tracker = new MemoryTracker([]);
    vi.spyOn(tracker, "fetchTerminalIssues").mockRejectedValue(new Error("linear down"));
    const workspace = makeWorkspace();
    const result = await runTerminalWorkspaceSweep({
      workspaceRoot: root,
      tracker,
      trackerConfig,
      workspace,
      state,
      logger: undefined,
      reason: "periodic",
      hasOpenHandles: async () => false,
    });
    expect(workspace.cleanupCompletedWorkspace).not.toHaveBeenCalled();
    expect(result.removed).toBe(0);
  });
});

describe("runTerminalWorkspaceSweep — parked (Backlog) workspaces (FRG-5471)", () => {
  let root: string;
  let state: OrchestratorState;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "forge-parked-sweep-"));
    state = createInitialState();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const mk = (...names: string[]) => {
    for (const n of names) mkdirSync(join(root, n));
  };
  const run = (
    tracker: MemoryTracker,
    workspace: ReturnType<typeof makeWorkspace>,
    extra: Record<string, unknown> = {},
  ) =>
    runTerminalWorkspaceSweep({
      workspaceRoot: root,
      tracker,
      trackerConfig,
      workspace,
      state,
      logger: undefined,
      reason: "pressure",
      hasOpenHandles: async () => false,
      ...extra,
    });

  it("removes Backlog workspaces only when the checkout is disposable", async () => {
    mk("FRG-1", "FRG-2", "FRG-3");
    const tracker = new MemoryTracker([
      makeIssue("FRG-1", "Backlog"),
      makeIssue("FRG-2", "Backlog"),
      makeIssue("FRG-3", "Todo"),
    ]);
    const workspace = makeWorkspace();
    const result = await run(tracker, workspace, {
      isDisposableCheckout: async (p: string) => p.endsWith("FRG-1"),
    });
    expect(workspace.cleanupCompletedWorkspace.mock.calls.map((c) => c[0])).toEqual([
      join(root, "FRG-1"),
    ]);
    expect(result).toEqual({ scanned: 3, removed: 1, skipped: 2 });
  });

  it("never touches parked workspaces that are in flight or open", async () => {
    mk("FRG-1", "FRG-2");
    const tracker = new MemoryTracker([
      makeIssue("FRG-1", "Backlog"),
      makeIssue("FRG-2", "Backlog"),
    ]);
    state.running.set("id-FRG-1", { identifier: "FRG-1" } as never);
    const workspace = makeWorkspace();
    await run(tracker, workspace, {
      isDisposableCheckout: async () => true,
      hasOpenHandles: async (p: string) => p.endsWith("FRG-2"),
    });
    expect(workspace.cleanupCompletedWorkspace).not.toHaveBeenCalled();
  });

  it("is disabled by parkedStates: [] and ignores parked states that are active", async () => {
    mk("FRG-1", "FRG-2");
    const tracker = new MemoryTracker([makeIssue("FRG-1", "Backlog"), makeIssue("FRG-2", "Todo")]);
    const workspace = makeWorkspace();
    await run(tracker, workspace, { parkedStates: [], isDisposableCheckout: async () => true });
    await run(tracker, workspace, {
      parkedStates: ["Todo"],
      isDisposableCheckout: async () => true,
    });
    expect(workspace.cleanupCompletedWorkspace).not.toHaveBeenCalled();
  });

  it("default git check keeps dirty checkouts and unpushed commits, removes clean ones", async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
        {
          cwd,
          stdio: "pipe",
        },
      );
    const remote = join(root, "..", `${root.split("/").pop()}-remote.git`);
    mkdirSync(remote);
    git(remote, "init", "-q", "--bare");
    const clone = (name: string) => {
      const dir = join(root, name);
      git(root, "clone", "-q", remote, name);
      return dir;
    };
    const seed = clone("seed");
    writeFileSync(join(seed, "a.txt"), "a");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "init");
    git(seed, "push", "-q", "origin", "HEAD");
    rmSync(seed, { recursive: true, force: true });

    const clean = clone("FRG-1");
    mkdirSync(join(clean, ".forge"));
    writeFileSync(join(clean, ".forge", "mcp.json"), "{}");
    const untracked = clone("FRG-2");
    writeFileSync(join(untracked, "new-module.ts"), "x");
    const unpushed = clone("FRG-3");
    writeFileSync(join(unpushed, "b.txt"), "b");
    git(unpushed, "add", ".");
    git(unpushed, "commit", "-qm", "local only");
    mkdirSync(join(root, "FRG-4")); // not a git repo -> keep

    const tracker = new MemoryTracker(
      ["FRG-1", "FRG-2", "FRG-3", "FRG-4"].map((i) => makeIssue(i, "Backlog")),
    );
    const workspace = makeWorkspace();
    try {
      await run(tracker, workspace);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
    expect(workspace.cleanupCompletedWorkspace.mock.calls.map((c) => c[0])).toEqual([clean]);
  });
});

describe("WorkspaceSweeper", () => {
  const baseDeps = () => ({
    workspaceRoot: "/nonexistent-forge-root",
    tracker: new MemoryTracker([]),
    trackerConfig,
    workspace: makeWorkspace(),
    state: createInitialState(),
    logger: undefined,
  });

  it("runs periodically only when enabled and after the interval", async () => {
    let now = 0;
    const sweeper = new WorkspaceSweeper({ periodic: true, intervalMs: 1000, now: () => now });
    expect(sweeper.maybeSweep(false, baseDeps())).toBeNull();
    now = 1000;
    const run = sweeper.maybeSweep(false, baseDeps());
    expect(run).not.toBeNull();
    await run;
    expect(sweeper.maybeSweep(false, baseDeps())).toBeNull();

    const off = new WorkspaceSweeper({ periodic: false, intervalMs: 1000, now: () => now });
    now = 10_000;
    expect(off.maybeSweep(false, baseDeps())).toBeNull();
  });

  it("sweeps under pressure even with periodic cleanup off, rate-limited", async () => {
    let now = 0;
    const sweeper = new WorkspaceSweeper({
      periodic: false,
      pressureCooldownMs: 500,
      now: () => now,
    });
    const first = sweeper.maybeSweep(true, baseDeps());
    expect(first).not.toBeNull();
    await first;
    now = 100;
    expect(sweeper.maybeSweep(true, baseDeps())).toBeNull();
    now = 600;
    expect(sweeper.maybeSweep(true, baseDeps())).not.toBeNull();
  });

  it("never runs two sweeps at once", () => {
    const sweeper = new WorkspaceSweeper({ periodic: false, pressureCooldownMs: 0 });
    expect(sweeper.maybeSweep(true, baseDeps())).not.toBeNull();
    expect(sweeper.maybeSweep(true, baseDeps())).toBeNull();
  });
});

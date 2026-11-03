import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockStatfs } = vi.hoisted(() => ({ mockStatfs: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = (await importOriginal()) as typeof import("node:fs/promises");
  return {
    ...original,
    statfs: mockStatfs,
  };
});

// Keep the worker from ever resolving so a blocked dispatch is detectable by
// the absence of a running entry.
vi.mock("../../../src/worker/runner.js", () => ({
  runWorker: vi.fn(() => new Promise<never>(() => {})),
}));

import { type DispatchIssueDeps, dispatchIssue } from "../../../src/orchestrator/dispatch-issue.js";
import { selectIssuesToDispatch } from "../../../src/orchestrator/dispatcher.js";
import { buildStateSnapshot } from "../../../src/orchestrator/snapshot.js";
import { createInitialState, type OrchestratorState } from "../../../src/orchestrator/types.js";
import { refreshWorkspaceLocks } from "../../../src/orchestrator/workspace-lock-gate.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";
import { createInodePressureState } from "../../../src/workspace/inode-pressure.js";
import { WORKSPACE_LOCK_HELD, workspaceLockPath } from "../../../src/workspace/lock.js";
import { WorkspaceManager } from "../../../src/workspace/manager.js";

function makeIssue(id: string): NormalizedIssue {
  return {
    id,
    identifier: id.toUpperCase(),
    title: "t",
    description: "",
    state: "Todo",
    priority: 1,
    labels: [],
    blockedBy: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

function makeDeps(state: OrchestratorState, workspaceRoot: string): DispatchIssueDeps {
  return {
    state,
    tracker: { fetchIssueStatesByIds: async () => new Map() } as never,
    agent: {} as never,
    workspace: {
      config: { root: workspaceRoot },
      lockHolder: async () => null,
    } as unknown as WorkspaceManager,
    config: {
      maxTurns: 1,
      promptTemplate: "",
      trackerConfig: {
        kind: "memory",
        project_slug: "x",
        active_states: ["Todo"],
        terminal_states: ["Done"],
      },
    } as never,
    callbacks: {},
    isStopped: () => false,
    isDraining: () => false,
    inodePressure: createInodePressureState(),
    handleWorkerComplete: () => {},
    handleWorkerError: () => {},
  };
}

describe("dispatchIssue — inode/byte dispatch gate (FRG-1886)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "forge-dispatch-gate-test-"));
    mockStatfs.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("dispatches normally when the workspace filesystem is healthy", async () => {
    const state = createInitialState();
    await dispatchIssue(makeDeps(state, root), makeIssue("a"));
    expect(state.running.size).toBe(1);
  });

  it("skips dispatch and logs a warning when free inodes are below 10%", async () => {
    mockStatfs.mockResolvedValue({
      type: 0,
      bsize: 4096,
      blocks: 1000,
      bfree: 1000,
      bavail: 1000,
      files: 1000,
      ffree: 5, // 0.5% free inodes
    } as never);

    const state = createInitialState();
    await dispatchIssue(makeDeps(state, root), makeIssue("a"));

    expect(state.running.size).toBe(0);
    expect(mockStatfs).toHaveBeenCalledWith(root);
  });

  it("skips dispatch and logs a warning when free bytes are below 10%", async () => {
    mockStatfs.mockResolvedValue({
      type: 0,
      bsize: 4096,
      blocks: 1000,
      bfree: 5, // 0.5% free bytes
      bavail: 5,
      files: 1000,
      ffree: 1000,
    } as never);

    const state = createInitialState();
    await dispatchIssue(makeDeps(state, root), makeIssue("a"));

    expect(state.running.size).toBe(0);
  });

  it("allows dispatch when statfs fails (fail-open)", async () => {
    mockStatfs.mockRejectedValue(new Error("statfs boom") as never);

    const state = createInitialState();
    await dispatchIssue(makeDeps(state, root), makeIssue("a"));

    expect(state.running.size).toBe(1);
  });
});

describe("dispatchIssue — BYOK dispatch hold (FRG-2928)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "forge-dispatch-hold-test-"));
    mockStatfs.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("claims nothing, starts no worker, fires no onDispatch, and warns once per issue", async () => {
    const state = createInitialState();
    const deps = makeDeps(state, root);
    const warn = vi.fn();
    const fetchIssueStatesByIds = vi.fn(async () => new Map());
    const onDispatch = vi.fn();
    deps.tracker = { fetchIssueStatesByIds } as never;
    deps.callbacks = { onDispatch };
    deps.config = {
      ...deps.config,
      logger: { warn } as never,
      customWorkflows: true,
      dispatchHold: { reason: "no_provider_key", message: "no key" },
    };

    await dispatchIssue(deps, makeIssue("a"));
    await dispatchIssue(deps, makeIssue("a"));
    await dispatchIssue(deps, makeIssue("b"));
    // Retries and continuations re-enter here with attempt > 1 (FRG-4446).
    await dispatchIssue(deps, makeIssue("b"), 3);

    expect(state.running.size).toBe(0);
    expect(state.claimed.size).toBe(0);
    expect(onDispatch).not.toHaveBeenCalled();
    // Refused before any tracker read or claim write.
    expect(fetchIssueStatesByIds).not.toHaveBeenCalled();
    expect(mockStatfs).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toMatchObject({ issueId: "a", reason: "no_provider_key" });
  });
});

describe("dispatchIssue — workspace dispatch lock (FRG-4527)", () => {
  let root: string;
  let holderProcess: ChildProcess;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "forge-dispatch-lock-test-"));
    mockStatfs.mockReset();
    holderProcess = spawn("sleep", ["30"], { stdio: "ignore" });
  });

  afterEach(() => {
    holderProcess.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });

  function lockedDeps(state: OrchestratorState, warn: ReturnType<typeof vi.fn>) {
    const deps = makeDeps(state, root);
    deps.workspace = new WorkspaceManager({ root, hooks: {} });
    (deps.config as { logger?: unknown }).logger = { warn };
    return deps;
  }

  function holdLock(identifier: string, token = "other-orchestrator") {
    const holder = { pid: holderProcess.pid, token, startedAt: "2026-10-01T00:00:00Z" };
    writeFileSync(workspaceLockPath(join(root, identifier)), JSON.stringify(holder));
  }

  it("refuses, before the claim, an issue whose workspace lock has a live holder", async () => {
    holdLock("A");
    const warn = vi.fn();
    const state = createInitialState();

    await dispatchIssue(lockedDeps(state, warn), makeIssue("a"));

    expect(state.running.size).toBe(0);
    expect(state.claimed.size).toBe(0);
    expect(state.workspaceLocked.has("a")).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: "A",
        holderPid: holderProcess.pid,
        holderMarkedPids: [],
        orphaned: false,
      }),
      WORKSPACE_LOCK_HELD,
    );
    // FRG-5429: the refusal is visible in the state snapshot.
    expect(buildStateSnapshot(state).workspaceLocked).toEqual([
      {
        issueId: "a",
        identifier: "A",
        holderPid: holderProcess.pid,
        holderAgentPid: null,
        holderStartedAt: "2026-10-01T00:00:00Z",
        markedPids: [],
        orphaned: false,
        since: expect.any(String),
        reaping: false,
      },
    ]);
  });

  it("logs a held lock once per holder, and dispatches once it is free", async () => {
    holdLock("A");
    const warn = vi.fn();
    const state = createInitialState();
    const deps = lockedDeps(state, warn);

    const lockWarnings = () => warn.mock.calls.filter(([, msg]) => msg === WORKSPACE_LOCK_HELD);

    await dispatchIssue(deps, makeIssue("a"));
    await dispatchIssue(deps, makeIssue("a"));
    expect(lockWarnings()).toHaveLength(1);

    holdLock("A", "another-holder");
    await dispatchIssue(deps, makeIssue("a"));
    expect(lockWarnings()).toHaveLength(2);

    rmSync(workspaceLockPath(join(root, "A")));
    await dispatchIssue(deps, makeIssue("a"));
    expect(state.workspaceLocked.has("a")).toBe(false);
    expect(state.running.size).toBe(1);
  });

  it("re-checks ranked-last issues each tick and drops freed or departed ones", async () => {
    holdLock("A");
    holdLock("B");
    const state = createInitialState();
    const deps = lockedDeps(state, vi.fn());
    const [a, b] = [makeIssue("a"), makeIssue("b")];
    await dispatchIssue(deps, a);
    await dispatchIssue(deps, b);

    await refreshWorkspaceLocks(deps, [a]);
    expect([...state.workspaceLocked.keys()]).toEqual(["a"]);

    rmSync(workspaceLockPath(join(root, "A")));
    await refreshWorkspaceLocks(deps, [a]);
    expect(state.workspaceLocked.size).toBe(0);
  });
});

describe("selectIssuesToDispatch — workspace-locked issues go last (FRG-4527)", () => {
  it("ranks an issue last refused for a held workspace lock behind the rest", () => {
    const state = createInitialState();
    const first = { ...makeIssue("a"), priority: 1 };
    const second = { ...makeIssue("b"), priority: 2 };
    const config = {
      active_states: ["Todo"],
      terminal_states: ["Done"],
      max_concurrent_agents: 1,
    };
    expect(selectIssuesToDispatch([first, second], state, config)).toEqual([first]);
    state.workspaceLocked.set("a", {
      identifier: "A",
      holderKey: "t@s",
      holderPid: 42,
      holderAgentPid: undefined,
      holderStartedAt: "s",
      markedPids: [],
      orphaned: false,
      sinceMs: 0,
      orphanedSinceMs: null,
      reaping: false,
    });
    expect(selectIssuesToDispatch([first, second], state, config)).toEqual([second]);
  });
});

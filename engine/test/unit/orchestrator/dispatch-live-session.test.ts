import { describe, expect, it, vi } from "vitest";

// Workers never finish on their own, so a dispatched entry stays in `running`.
vi.mock("../../../src/worker/runner.js", () => ({
  runWorker: vi.fn(() => new Promise<never>(() => {})),
}));

import { type DispatchIssueDeps, dispatchIssue } from "../../../src/orchestrator/dispatch-issue.js";
import { refetchAndDispatch } from "../../../src/orchestrator/refetch-dispatch.js";
import { holdUntilSettled } from "../../../src/orchestrator/session-guard.js";
import { createInitialState, type OrchestratorState } from "../../../src/orchestrator/types.js";
import {
  handleWorkerComplete,
  handleWorkerError,
  settleRunningEntry,
  type WorkerOutcomeDeps,
} from "../../../src/orchestrator/worker-outcomes.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";
import { runWorker } from "../../../src/worker/runner.js";
import { createInodePressureState } from "../../../src/workspace/inode-pressure.js";

const SUPPRESSED = "dispatch suppressed; issue already has a live session";

function makeIssue(id = "a"): NormalizedIssue {
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

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

function makeDeps(state: OrchestratorState, logger = makeLogger()): DispatchIssueDeps {
  return {
    state,
    tracker: {
      fetchIssueStatesByIds: async () => new Map(),
      fetchCandidates: async () => [makeIssue()],
    } as never,
    agent: {} as never,
    workspace: {} as never,
    config: {
      maxTurns: 1,
      maxConcurrentAgents: 5,
      maxRetryAttempts: 3,
      maxRetryDelayMs: 60_000,
      promptTemplate: "",
      logger,
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

function outcomeDeps(d: DispatchIssueDeps): WorkerOutcomeDeps {
  return { state: d.state, config: d.config, callbacks: d.callbacks, refetchAndDispatch: vi.fn() };
}

const success = { issueId: "a", success: true, turns: 1, tokens: {} } as never;

describe("dispatchIssue — one live session per issue (FRG-4086)", () => {
  it.each([
    ["running", (s: OrchestratorState) => s.running.set("a", {} as never)],
    ["claimed", (s: OrchestratorState) => s.claimed.add("a")],
    [
      "settling",
      (s: OrchestratorState) =>
        s.settling.set("a", { identifier: "A", exited: new Promise(() => {}) }),
    ],
  ] as const)("refuses and logs a dispatch while the issue is %s", async (reason, occupy) => {
    vi.mocked(runWorker).mockClear();
    const state = createInitialState();
    occupy(state);
    const logger = makeLogger();

    await dispatchIssue(makeDeps(state, logger), makeIssue(), 2);

    expect(runWorker).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { issueId: "a", identifier: "A", attempt: 2, reason },
      SUPPRESSED,
    );
  });

  it("starts one worker when a retry and a poll dispatch the same issue concurrently", async () => {
    vi.mocked(runWorker).mockClear();
    const state = createInitialState();
    const deps = makeDeps(state);

    await Promise.all([dispatchIssue(deps, makeIssue(), 2), dispatchIssue(deps, makeIssue(), 1)]);

    expect(runWorker).toHaveBeenCalledTimes(1);
    expect(state.running.size).toBe(1);
  });

  it("a killed worker's late completion leaves its successor's entry alone", async () => {
    const state = createInitialState();
    const deps = makeDeps(state);
    await dispatchIssue(deps, makeIssue(), 1);
    const killed = state.running.get("a");
    if (!killed) throw new Error("not dispatched");
    settleRunningEntry(outcomeDeps(deps), "a", () => {});
    state.settling.delete("a");
    await dispatchIssue(deps, makeIssue(), 2);
    const successor = state.running.get("a");

    handleWorkerComplete(outcomeDeps(deps), "a", success, 1, killed);
    handleWorkerError(outcomeDeps(deps), "a", "A", new Error("killed"), 1, killed);

    expect(state.running.get("a")).toBe(successor);
    expect(state.completed.has("a")).toBe(false);
    expect(successor?.abortController.signal.aborted).toBe(false);
  });

  it("a kill keeps the issue reserved until the worker has exited", async () => {
    const state = createInitialState();
    const deps = makeDeps(state);
    await dispatchIssue(deps, makeIssue(), 1);
    const entry = state.running.get("a");
    if (!entry) throw new Error("not dispatched");
    let exit!: () => void;
    entry.workerPromise = new Promise<void>((resolve) => {
      exit = resolve;
    });

    settleRunningEntry(outcomeDeps(deps), "a", () => {});
    expect(entry.abortController.signal.aborted).toBe(true);
    expect(state.running.has("a")).toBe(false);
    expect(state.settling.has("a")).toBe(true);

    exit();
    await state.settling.get("a")?.exited;
    expect(state.settling.has("a")).toBe(false);
  });

  it("holdUntilSettled only releases the reservation it created", async () => {
    const state = createInitialState();
    let exitFirst!: () => void;
    holdUntilSettled(
      state,
      "a",
      "A",
      new Promise<void>((r) => {
        exitFirst = r;
      }),
      undefined,
    );
    const first = state.settling.get("a");
    holdUntilSettled(state, "a", "A", new Promise<void>(() => {}), undefined);
    const second = state.settling.get("a");

    exitFirst();
    await first;
    expect(state.settling.get("a")).toBe(second);
  });
});

describe("refetchAndDispatch — retry while the issue has a live session (FRG-4086)", () => {
  function retryDeps(state: OrchestratorState, logger = makeLogger()) {
    const dispatch = vi.fn(async () => {});
    return {
      dispatch,
      logger,
      deps: {
        state,
        tracker: {
          fetchIssueStatesByIds: async () => new Map([["a", "Todo"]]),
          fetchCandidates: async () => [makeIssue()],
        } as never,
        config: {
          maxConcurrentAgents: 5,
          logger,
          trackerConfig: { active_states: ["Todo"] },
        } as never,
        dispatchIssue: dispatch,
        onError: vi.fn(),
      },
    };
  }

  it.each([
    true,
    false,
  ])("does not dispatch while the issue is running (checkState=%s)", async (checkState) => {
    const state = createInitialState();
    state.running.set("a", {} as never);
    state.retryAttempts.set("a", { issueId: "a", identifier: "A", attempt: 2 } as never);
    const { deps, dispatch, logger } = retryDeps(state);

    refetchAndDispatch(deps, "a", 2, checkState);
    await vi.waitFor(() => expect(state.retryAttempts.has("a")).toBe(false));

    expect(dispatch).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { issueId: "a", identifier: "A", attempt: 2, reason: "running" },
      SUPPRESSED,
    );
  });

  it("holds the retry until the killed worker exits, then dispatches", async () => {
    const state = createInitialState();
    let exit!: () => void;
    holdUntilSettled(
      state,
      "a",
      "A",
      new Promise<void>((r) => {
        exit = r;
      }),
      undefined,
    );
    state.retryAttempts.set("a", { issueId: "a", identifier: "A", attempt: 2 } as never);
    const { deps, dispatch, logger } = retryDeps(state);

    refetchAndDispatch(deps, "a", 2, false);
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.retryAttempts.has("a")).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      { issueId: "a", identifier: "A", attempt: 2, reason: "settling" },
      SUPPRESSED,
    );

    exit();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
  });
});

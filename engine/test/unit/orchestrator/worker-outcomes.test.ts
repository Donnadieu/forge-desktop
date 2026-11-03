import { afterEach, describe, expect, it, vi } from "vitest";
import { selectIssuesToDispatch } from "../../../src/orchestrator/dispatcher.js";
import { cancelAllRetries } from "../../../src/orchestrator/retry-queue.js";
import {
  createInitialState,
  type OrchestratorCallbacks,
  type OrchestratorConfig,
  type RunningEntry,
  type TicketTelemetry,
} from "../../../src/orchestrator/types.js";
import {
  buildTicketTelemetry,
  completeSettledFromTracker,
  handleWorkerComplete,
  handleWorkerError,
  recordKilledTicket,
  recordTrackerCompletedTicket,
  settleRunningEntry,
  type WorkerOutcomeDeps,
} from "../../../src/orchestrator/worker-outcomes.js";
import type { WorkerResult } from "../../../src/worker/runner.js";

function makeDeps(): WorkerOutcomeDeps & { callbacks: Required<OrchestratorCallbacks> } {
  const state = createInitialState();
  const config: OrchestratorConfig = {
    pollIntervalMs: 1000,
    maxConcurrentAgents: 1,
    maxTurns: 50,
    stallTimeoutSeconds: 1800,
    maxRetryAttempts: 3,
    maxRetryDelayMs: 60_000,
    retryBaseDelayMs: 1000,
    trackerConfig: {
      kind: "memory",
      project_slug: "x",
      active_states: ["Todo"],
      terminal_states: ["Done"],
    },
    promptTemplate: "",
  };
  const callbacks = {
    onComplete: vi.fn(),
    onError: vi.fn(),
    onDispatch: vi.fn(),
    onEvent: vi.fn(),
    onReconcile: vi.fn(),
    onPollError: vi.fn(),
    onBuildComplete: vi.fn(),
  };
  const refetchAndDispatch = vi.fn();
  return { state, config, callbacks, refetchAndDispatch };
}

function seedRunning(
  deps: WorkerOutcomeDeps,
  issueId: string,
  identifier: string,
  overrides: Partial<RunningEntry> = {},
): RunningEntry {
  const startedAt = performance.now() - 5000;
  const entry: RunningEntry = {
    issueId,
    identifier,
    issue: {
      id: issueId,
      identifier,
      title: "x",
      state: "In Progress",
      priority: 1,
      url: "",
      description: "",
    },
    startedAt,
    wallClockStartedAtMs: Date.now() - 5000,
    lastActivityAt: performance.now(),
    tokens: { input: 0, output: 0 },
    workspacePath: null,
    attempt: 1,
    abortController: new AbortController(),
    workerPromise: Promise.resolve(),
    sessionId: null,
    turnCount: 0,
    lastEvent: "",
    lastMessage: "",
    activity: "",
    helpers: [],
    recent: [],
    host: null,
    turnTimings: [],
    ...overrides,
  };
  deps.state.running.set(issueId, entry);
  return entry;
}

const successResult: WorkerResult = {
  issueId: "issue-1",
  success: true,
  turns: 1,
  tokens: { input: 100, output: 50 },
};

describe("worker-outcomes ticketOutcomes population", () => {
  it("populates ticketOutcomes on handleWorkerComplete", () => {
    const deps = makeDeps();
    seedRunning(deps, "issue-1", "FORGE-1");

    handleWorkerComplete(deps, "issue-1", successResult, 1);

    const outcome = deps.state.ticketOutcomes.get("issue-1");
    expect(outcome).toBeDefined();
    expect(outcome?.identifier).toBe("FORGE-1");
    expect(outcome?.result.success).toBe(true);
    expect(outcome?.durationMs).toBeGreaterThan(0);
  });

  it("synthesizes a ticketOutcomes entry on handleWorkerError so terminal failures aren't dropped", () => {
    const deps = makeDeps();
    seedRunning(deps, "issue-2", "FORGE-2");

    handleWorkerError(deps, "issue-2", "FORGE-2", new Error("boom"), 99);

    const outcome = deps.state.ticketOutcomes.get("issue-2");
    expect(outcome).toBeDefined();
    expect(outcome?.identifier).toBe("FORGE-2");
    expect(outcome?.result.success).toBe(false);
    expect(outcome?.result.error).toBe("boom");
  });

  it("does not crash if handleWorkerComplete is called for an unknown issue", () => {
    const deps = makeDeps();
    expect(() => handleWorkerComplete(deps, "missing", successResult, 1)).not.toThrow();
    expect(deps.state.ticketOutcomes.size).toBe(0);
  });

  it("no-ops onComplete when the entry was already settled (tracker-done double-fire guard)", () => {
    // completeWorkerFromTracker settles + deletes the entry, then fires onComplete
    // itself. When the aborted worker's promise later resolves into
    // handleWorkerComplete, the entry is gone so onComplete must NOT fire again.
    const deps = makeDeps();
    const entry = seedRunning(deps, "issue-1", "FORGE-1");
    settleRunningEntry(deps, "issue-1", () => {}); // simulate the tracker-done settle
    expect(deps.state.running.has("issue-1")).toBe(false);

    handleWorkerComplete(deps, "issue-1", successResult, 1);

    // buildTicketTelemetry read the entry before it was deleted; ensure the guard
    // held and the completion hand-off did not re-run.
    expect(deps.callbacks.onComplete).not.toHaveBeenCalled();
    void entry;
  });

  it("still records a ticketOutcome on handleWorkerError when no running entry is present", () => {
    const deps = makeDeps();
    handleWorkerError(deps, "issue-3", "FORGE-3", new Error("unstarted"), 1);
    const outcome = deps.state.ticketOutcomes.get("issue-3");
    expect(outcome).toBeDefined();
    expect(outcome?.result.error).toBe("unstarted");
    expect(outcome?.durationMs).toBe(0);
  });

  it("does NOT clobber a prior killed-ticket outcome when the aborted worker rejects later", () => {
    // Simulates the killAndRetry → killWorker → recordKilledTicket flow:
    // the kill path lands first with rich telemetry, then the aborted
    // worker's rejected promise calls handleWorkerError. The error path
    // must short-circuit so the rich outcome stays put.
    const deps = makeDeps();
    const onError = vi.fn();
    deps.callbacks.onError = onError;

    const entry = seedRunning(deps, "issue-stalled", "FORGE-S", {
      tokens: { input: 999, output: 333 },
      turnCount: 4,
    });
    recordKilledTicket(deps, entry, "stalled");
    // recordKilledTicket leaves the entry in state.running; killWorker
    // normally deletes it. Replicate that here.
    deps.state.running.delete("issue-stalled");

    const before = deps.state.ticketOutcomes.get("issue-stalled");
    expect(before?.result.turns).toBe(4);
    expect(before?.telemetry?.status).toBe("stalled");

    handleWorkerError(deps, "issue-stalled", "FORGE-S", new Error("AbortError"), 1);

    const after = deps.state.ticketOutcomes.get("issue-stalled");
    expect(after).toBe(before); // same reference — not overwritten
    expect(after?.result.turns).toBe(4);
    expect(after?.result.tokens).toEqual({ input: 999, output: 333 });
    expect(after?.telemetry?.status).toBe("stalled");
    // onError still fires so callers learn of the failure
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("synthesizes result with entry.turnCount/tokens (not zeros) when an entry exists on error", () => {
    const deps = makeDeps();
    const entry = seedRunning(deps, "issue-err", "FORGE-E", {
      tokens: { input: 250, output: 150 },
      turnCount: 7,
    });
    entry.turnTimings.push({
      turnNumber: 1,
      startedAt: entry.startedAt + 10,
      finishedAt: entry.startedAt + 20,
      tokensInputAtStart: 0,
      tokensOutputAtStart: 0,
      eventCount: 1,
      lastEventType: "tool_use",
    });

    handleWorkerError(deps, "issue-err", "FORGE-E", new Error("boom"), 1);

    const outcome = deps.state.ticketOutcomes.get("issue-err");
    expect(outcome?.result.turns).toBe(7);
    expect(outcome?.result.tokens).toEqual({ input: 250, output: 150 });
    expect(outcome?.result.error).toBe("boom");
    // Object copy, not reference share (so later mutations to entry.tokens
    // don't leak into the outcome record).
    expect(outcome?.result.tokens).not.toBe(entry.tokens);
  });
});

describe("worker-outcomes retry holds the agent slot (cap=1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("after a retryable failure, the slot stays occupied so a waiting feature is not dispatched", () => {
    vi.useFakeTimers();
    const deps = makeDeps(); // maxConcurrentAgents: 1, maxRetryAttempts: 3
    seedRunning(deps, "issue-1", "FORGE-1");

    // Retryable failure: preserveWorkspace + !success + attempts remaining.
    handleWorkerComplete(
      deps,
      "issue-1",
      {
        issueId: "issue-1",
        success: false,
        turns: 3,
        tokens: { input: 0, output: 0 },
        preserveWorkspace: true,
        error: "transient",
      },
      1,
    );

    // The feature left `running` but a retry was scheduled — its reservation
    // sits in `retryAttempts`, keeping the agent slot occupied.
    expect(deps.state.running.has("issue-1")).toBe(false);
    expect(deps.state.retryAttempts.has("issue-1")).toBe(true);

    const waiting = {
      id: "issue-2",
      identifier: "FORGE-2",
      title: "waiting",
      description: "",
      state: "Todo",
      priority: 1,
      labels: [],
      blockedBy: [],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    const selected = selectIssuesToDispatch([waiting], deps.state, {
      active_states: ["Todo"],
      terminal_states: ["Done"],
      max_concurrent_agents: 1,
    });
    expect(selected).toHaveLength(0);

    cancelAllRetries(deps.state);
  });
});

describe("recordKilledTicket", () => {
  it("populates ticketOutcomes with status='stalled' and rich telemetry", () => {
    const deps = makeDeps();
    const onTicketComplete = vi.fn();
    deps.callbacks.onTicketComplete = onTicketComplete;
    const entry = seedRunning(deps, "issue-1", "FORGE-1", {
      tokens: { input: 42, output: 17 },
      turnCount: 3,
    });

    const { durationMs } = recordKilledTicket(deps, entry, "stalled");

    expect(durationMs).toBeGreaterThan(0);
    expect(deps.state.secondsRunning).toBeGreaterThan(0);
    const outcome = deps.state.ticketOutcomes.get("issue-1");
    expect(outcome?.result.success).toBe(false);
    expect(outcome?.result.error).toBe("Stalled");
    expect(outcome?.result.turns).toBe(3);
    expect(outcome?.result.tokens).toEqual({ input: 42, output: 17 });
    expect(outcome?.telemetry?.status).toBe("stalled");
    expect(outcome?.telemetry?.errorMessage).toBe("Stalled");
    expect(onTicketComplete).toHaveBeenCalledOnce();
  });

  it("uses errorMessage='Cancelled' for status='cancelled'", () => {
    const deps = makeDeps();
    const entry = seedRunning(deps, "issue-c", "FORGE-C");
    recordKilledTicket(deps, entry, "cancelled");
    const outcome = deps.state.ticketOutcomes.get("issue-c");
    expect(outcome?.result.error).toBe("Cancelled");
    expect(outcome?.telemetry?.status).toBe("cancelled");
  });
});

describe("recordTrackerCompletedTicket", () => {
  it("records a tracker-done ticket as completed/success — never cancelled", () => {
    const deps = makeDeps();
    const onTicketComplete = vi.fn();
    deps.callbacks.onTicketComplete = onTicketComplete;
    const entry = seedRunning(deps, "issue-done", "FORGE-D", {
      tokens: { input: 100, output: 50 },
      turnCount: 4,
    });

    const { durationMs } = recordTrackerCompletedTicket(deps, entry);

    expect(durationMs).toBeGreaterThan(0);
    const outcome = deps.state.ticketOutcomes.get("issue-done");
    expect(outcome?.result.success).toBe(true);
    expect(outcome?.result.error).toBeUndefined();
    expect(outcome?.result.turns).toBe(4);
    expect(outcome?.result.tokens).toEqual({ input: 100, output: 50 });
    expect(outcome?.telemetry?.status).toBe("completed");
    // It counts as a completed ticket so build-done detection sees it.
    expect(deps.state.completed.has("issue-done")).toBe(true);
    expect(onTicketComplete).toHaveBeenCalledOnce();
  });

  it("stores a re-fireable success WorkerResult (completeWorkerFromTracker re-fires it into onComplete)", () => {
    const deps = makeDeps();
    const entry = seedRunning(deps, "issue-done", "FORGE-D", {
      tokens: { input: 100, output: 50 },
      turnCount: 4,
    });

    recordTrackerCompletedTicket(deps, entry);

    // completeWorkerFromTracker reads this stored result back and passes it to
    // callbacks.onComplete, so it must be a well-formed success WorkerResult.
    const result = deps.state.ticketOutcomes.get("issue-done")?.result;
    expect(result).toEqual({
      issueId: "issue-done",
      success: true,
      turns: 4,
      tokens: { input: 100, output: 50 },
    });
  });
});

describe("completeSettledFromTracker", () => {
  it("settles the ticket AND fires onComplete once with the stored success result", () => {
    const deps = makeDeps();
    const entry = seedRunning(deps, "issue-done", "FORGE-D", {
      tokens: { input: 100, output: 50 },
      turnCount: 4,
    });

    completeSettledFromTracker(deps, "issue-done");

    // Entry settled + aborted, recorded completed.
    expect(deps.state.running.has("issue-done")).toBe(false);
    expect(entry.abortController.signal.aborted).toBe(true);
    expect(deps.state.completed.has("issue-done")).toBe(true);
    // onComplete fired once — the Smith review hand-off (markAwaitingReview etc.).
    expect(deps.callbacks.onComplete).toHaveBeenCalledTimes(1);
    expect(deps.callbacks.onComplete).toHaveBeenCalledWith(
      "issue-done",
      { issueId: "issue-done", success: true, turns: 4, tokens: { input: 100, output: 50 } },
      entry.issue,
      false,
    );
  });

  it("no-ops when the entry is already gone (worker completion settled it first)", () => {
    const deps = makeDeps();
    completeSettledFromTracker(deps, "missing");
    expect(deps.callbacks.onComplete).not.toHaveBeenCalled();
  });
});

describe("settleRunningEntry", () => {
  it("records the outcome, aborts the worker, and drops the entry from running", () => {
    const deps = makeDeps();
    const entry = seedRunning(deps, "issue-1", "FORGE-1");
    const recorder = vi.fn();

    settleRunningEntry(deps, "issue-1", recorder);

    expect(recorder).toHaveBeenCalledOnce();
    expect(recorder).toHaveBeenCalledWith(deps, entry);
    // Worker aborted and entry removed so the later (aborted) worker promise
    // no-ops in handleWorkerComplete.
    expect(entry.abortController.signal.aborted).toBe(true);
    expect(deps.state.running.has("issue-1")).toBe(false);
  });

  it("is a no-op when the entry is absent (re-entrancy guard)", () => {
    const deps = makeDeps();
    const recorder = vi.fn();

    expect(() => settleRunningEntry(deps, "missing", recorder)).not.toThrow();
    expect(recorder).not.toHaveBeenCalled();
  });
});

describe("buildTicketTelemetry per-turn token-delta arithmetic", () => {
  it("attributes adjacent-diff tokens to all turns except the last", () => {
    const deps = makeDeps();
    const entry = seedRunning(deps, "issue-mt", "FORGE-MT");
    // 3 turns. Token snapshots at start of each turn: (0,0), (10,5), (30,15).
    // Final entry.tokens: (50, 25).
    entry.turnTimings = [
      {
        turnNumber: 1,
        startedAt: entry.startedAt + 100,
        finishedAt: entry.startedAt + 200,
        tokensInputAtStart: 0,
        tokensOutputAtStart: 0,
        eventCount: 2,
        lastEventType: "tool_use",
      },
      {
        turnNumber: 2,
        startedAt: entry.startedAt + 200,
        finishedAt: entry.startedAt + 400,
        tokensInputAtStart: 10,
        tokensOutputAtStart: 5,
        eventCount: 3,
        lastEventType: "tool_use",
      },
      {
        turnNumber: 3,
        startedAt: entry.startedAt + 400,
        finishedAt: entry.startedAt + 600,
        tokensInputAtStart: 30,
        tokensOutputAtStart: 15,
        eventCount: 5,
        lastEventType: "done",
      },
    ];
    entry.tokens = { input: 50, output: 25 };

    const telemetry = buildTicketTelemetry(
      entry,
      "completed",
      true,
      null,
      1000,
      3,
      entry.tokens,
      null,
    );

    expect(telemetry.turnTimings).toHaveLength(3);
    // Turn 1: nxt(10) - cur(0) = 10 in, 5 out
    expect(telemetry.turnTimings[0].tokensInput).toBe(10);
    expect(telemetry.turnTimings[0].tokensOutput).toBe(5);
    // Turn 2: nxt(30) - cur(10) = 20 in, 10 out
    expect(telemetry.turnTimings[1].tokensInput).toBe(20);
    expect(telemetry.turnTimings[1].tokensOutput).toBe(10);
    // Turn 3 (last): final entry.tokens - cur(30, 15) = 20 in, 10 out
    expect(telemetry.turnTimings[2].tokensInput).toBe(20);
    expect(telemetry.turnTimings[2].tokensOutput).toBe(10);
  });

  it("falls back to entry.startedAt + durationMs for an open final turn", () => {
    const deps = makeDeps();
    const entry = seedRunning(deps, "issue-open", "FORGE-O");
    entry.turnTimings.push({
      turnNumber: 1,
      startedAt: entry.startedAt + 100,
      finishedAt: null,
      tokensInputAtStart: 0,
      tokensOutputAtStart: 0,
      eventCount: 1,
      lastEventType: "usage",
    });
    entry.tokens = { input: 5, output: 3 };

    const telemetry = buildTicketTelemetry(
      entry,
      "failed",
      false,
      "kaboom",
      1000,
      1,
      entry.tokens,
      null,
    );

    const t = telemetry.turnTimings[0];
    // Without a next-turn fallback, the open turn projects to ticket end.
    expect(t.finishedAtMs - t.startedAtMs).toBeGreaterThan(0);
    expect(t.durationMs).toBeGreaterThan(0);
  });
});

describe("worker-outcomes onTicketComplete telemetry", () => {
  it("fires onTicketComplete with bundled telemetry on success", () => {
    const deps = makeDeps();
    const onTicketComplete = vi.fn();
    deps.callbacks.onTicketComplete = onTicketComplete;
    const entry = seedRunning(deps, "issue-1", "FORGE-1");
    const t1Start = entry.startedAt + 100;
    const t1End = entry.startedAt + 1000;
    entry.turnTimings.push({
      turnNumber: 1,
      startedAt: t1Start,
      finishedAt: t1End,
      tokensInputAtStart: 0,
      tokensOutputAtStart: 0,
      eventCount: 12,
      lastEventType: "done",
    });
    entry.tokens = { input: 200, output: 150 };

    handleWorkerComplete(
      deps,
      "issue-1",
      { issueId: "issue-1", success: true, turns: 1, tokens: { input: 200, output: 150 } },
      1,
    );

    expect(onTicketComplete).toHaveBeenCalledOnce();
    const [emittedIssueId, telemetry] = onTicketComplete.mock.calls[0] as [string, TicketTelemetry];
    expect(emittedIssueId).toBe("issue-1");
    expect(telemetry.status).toBe("completed");
    expect(telemetry.success).toBe(true);
    expect(telemetry.turns).toBe(1);
    expect(telemetry.turnTimings).toHaveLength(1);
    expect(telemetry.turnTimings[0].eventCount).toBe(12);
    expect(telemetry.turnTimings[0].lastEventType).toBe("done");
    expect(telemetry.tokens).toEqual({ input: 200, output: 150 });
    expect(telemetry.startedAtMs).toBeGreaterThan(0);
    expect(telemetry.finishedAtMs).toBeGreaterThanOrEqual(telemetry.startedAtMs);
  });

  it("emits status='failed' on worker errors and preserves turnTimings collected so far", () => {
    const deps = makeDeps();
    const onTicketComplete = vi.fn();
    deps.callbacks.onTicketComplete = onTicketComplete;
    const entry = seedRunning(deps, "issue-2", "FORGE-2");
    entry.turnTimings.push({
      turnNumber: 1,
      startedAt: entry.startedAt + 50,
      finishedAt: null, // crashed mid-turn
      tokensInputAtStart: 0,
      tokensOutputAtStart: 0,
      eventCount: 3,
      lastEventType: "tool_use",
    });
    entry.turnCount = 1;

    handleWorkerError(deps, "issue-2", "FORGE-2", new Error("kaboom"), 1);

    expect(onTicketComplete).toHaveBeenCalledOnce();
    const [, telemetry] = onTicketComplete.mock.calls[0] as [string, TicketTelemetry];
    expect(telemetry.status).toBe("failed");
    expect(telemetry.success).toBe(false);
    expect(telemetry.errorMessage).toBe("kaboom");
    expect(telemetry.turnTimings).toHaveLength(1);
    expect(telemetry.turnTimings[0].eventCount).toBe(3);
  });

  it("never throws when onTicketComplete itself throws (orchestrator must continue)", () => {
    const deps = makeDeps();
    deps.callbacks.onTicketComplete = vi.fn().mockImplementation(() => {
      throw new Error("downstream failure");
    });
    seedRunning(deps, "issue-3", "FORGE-3");
    expect(() =>
      handleWorkerComplete(
        deps,
        "issue-3",
        { issueId: "issue-3", success: true, turns: 0, tokens: { input: 0, output: 0 } },
        1,
      ),
    ).not.toThrow();
  });
});

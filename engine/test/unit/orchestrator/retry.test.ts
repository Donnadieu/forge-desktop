import { afterEach, describe, expect, it, vi } from "vitest";
import { selectIssuesToDispatch } from "../../../src/orchestrator/dispatcher.js";
import {
  type RefetchAndDispatchDeps,
  refetchAndDispatch,
} from "../../../src/orchestrator/refetch-dispatch.js";
import {
  calculateRetryDelay,
  cancelAllRetries,
  cancelRetry,
  scheduleRetry,
} from "../../../src/orchestrator/retry-queue.js";
import { createInitialState, type OrchestratorState } from "../../../src/orchestrator/types.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";

describe("calculateRetryDelay", () => {
  it("returns 1s for continuation retries", () => {
    expect(calculateRetryDelay(1, "continuation", 300_000)).toBe(1_000);
    expect(calculateRetryDelay(5, "continuation", 300_000)).toBe(1_000);
  });

  it("returns exponential backoff for failure retries", () => {
    expect(calculateRetryDelay(1, "failure", 300_000)).toBe(10_000);
    expect(calculateRetryDelay(2, "failure", 300_000)).toBe(20_000);
    expect(calculateRetryDelay(3, "failure", 300_000)).toBe(40_000);
    expect(calculateRetryDelay(4, "failure", 300_000)).toBe(80_000);
  });

  it("caps at max delay", () => {
    expect(calculateRetryDelay(10, "failure", 300_000)).toBe(300_000);
  });

  it("uses custom base delay when provided", () => {
    expect(calculateRetryDelay(1, "failure", 300_000, 5_000)).toBe(5_000);
    expect(calculateRetryDelay(2, "failure", 300_000, 5_000)).toBe(10_000);
    expect(calculateRetryDelay(3, "failure", 300_000, 5_000)).toBe(20_000);
  });

  it("uses default base delay when not provided", () => {
    // Default is 10_000
    expect(calculateRetryDelay(1, "failure", 300_000)).toBe(10_000);
    expect(calculateRetryDelay(1, "failure", 300_000, undefined)).toBe(10_000);
  });
});

describe("scheduleRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules a retry and calls callback", async () => {
    vi.useFakeTimers();
    const state = createInitialState();
    const onRetry = vi.fn();

    scheduleRetry(state, "id-1", "MT-1", 1, "continuation", null, 300_000, onRetry);

    expect(state.retryAttempts.has("id-1")).toBe(true);
    expect(state.retryAttempts.get("id-1")?.attempt).toBe(1);

    vi.advanceTimersByTime(1_500);
    expect(onRetry).toHaveBeenCalledWith("id-1");
    // Reservation handoff: the entry is NOT deleted when the timer fires — it
    // stays in retryAttempts (holding the agent slot) until the dispatch path
    // releases it via cancelRetry. Releasing on fire would briefly free the
    // slot during refetchAndDispatch's awaits and allow a double-dispatch.
    expect(state.retryAttempts.has("id-1")).toBe(true);
  });

  it("cancels previous retry when scheduling new one", () => {
    vi.useFakeTimers();
    const state = createInitialState();
    const onRetry = vi.fn();

    scheduleRetry(state, "id-1", "MT-1", 1, "failure", null, 300_000, onRetry);

    scheduleRetry(state, "id-1", "MT-1", 2, "failure", null, 300_000, onRetry);

    // First timer should be cleared
    vi.advanceTimersByTime(15_000); // Past first delay
    expect(onRetry).not.toHaveBeenCalled(); // First was cancelled

    vi.advanceTimersByTime(25_000); // Past second delay (20s)
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("cancelRetry", () => {
  it("removes retry entry and clears timer", () => {
    vi.useFakeTimers();
    const state = createInitialState();
    scheduleRetry(state, "id-1", "MT-1", 1, "failure", null, 300_000, vi.fn());

    expect(state.retryAttempts.has("id-1")).toBe(true);
    cancelRetry(state, "id-1");
    expect(state.retryAttempts.has("id-1")).toBe(false);
    vi.useRealTimers();
  });
});

describe("cancelAllRetries", () => {
  it("cancels all pending retries", () => {
    vi.useFakeTimers();
    const state = createInitialState();
    scheduleRetry(state, "id-1", "MT-1", 1, "failure", null, 300_000, vi.fn());
    scheduleRetry(state, "id-2", "MT-2", 1, "failure", null, 300_000, vi.fn());

    expect(state.retryAttempts.size).toBe(2);
    cancelAllRetries(state);
    expect(state.retryAttempts.size).toBe(0);
    vi.useRealTimers();
  });
});

// FRG cap=1 retry-firing race: when a retry timer fires, the slot reservation
// must stay held continuously — handed from `retryAttempts` to `running` with
// no window where the agent looks free — or a poll tick could double-dispatch a
// waiting feature during refetchAndDispatch's awaited tracker calls.
describe("refetchAndDispatch holds the agent slot continuously", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeIssue(id: string, identifier: string): NormalizedIssue {
    return {
      id,
      identifier,
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

  // Seed the reservation a fired retry timer leaves behind: present in
  // retryAttempts, its timer already elapsed (use a no-op long timer here).
  function seedReservation(state: OrchestratorState, id: string, attempt: number): void {
    state.retryAttempts.set(id, {
      issueId: id,
      identifier: id,
      attempt,
      dueAtMs: 0,
      delayType: "failure",
      error: null,
      timerId: setTimeout(() => {}, 60_000),
    });
  }

  const cfg = {
    active_states: ["Todo"],
    terminal_states: ["Done"],
    max_concurrent_agents: 1,
  };

  // One macrotask hop flushes all pending microtasks (resolved-promise awaits).
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it("keeps the slot occupied through the dispatch await gap, then releases it once running holds it", async () => {
    const state = createInitialState();
    const issue = makeIssue("a", "SMITH-1");
    seedReservation(state, "a", 2);

    let resolveCandidates!: (v: NormalizedIssue[]) => void;
    const candidates = new Promise<NormalizedIssue[]>((r) => {
      resolveCandidates = r;
    });
    let resolveDispatch!: () => void;
    const dispatchGate = new Promise<void>((r) => {
      resolveDispatch = r;
    });
    const dispatchIssue = vi.fn().mockImplementation(async () => {
      // Real dispatchIssue registers the RunningEntry before it resolves.
      state.running.set("a", { issue } as never);
      await dispatchGate;
    });

    const deps = {
      state,
      tracker: {
        fetchCandidates: vi.fn().mockReturnValue(candidates),
        fetchIssueStatesByIds: vi.fn(),
      },
      config: { maxConcurrentAgents: 1, trackerConfig: { active_states: ["Todo"] } },
      dispatchIssue,
      onError: vi.fn(),
    } as unknown as RefetchAndDispatchDeps;

    refetchAndDispatch(deps, "a", 2, false);
    await tick(); // parked on fetchCandidates

    // Slot still reserved — a concurrent poll cannot pick up a waiting feature.
    expect(state.retryAttempts.has("a")).toBe(true);
    expect(selectIssuesToDispatch([makeIssue("b", "SMITH-2")], state, cfg)).toHaveLength(0);

    resolveCandidates([issue]);
    await tick(); // proceed into dispatchIssue, which registers `running`

    expect(state.running.has("a")).toBe(true); // handoff target now holds the slot

    resolveDispatch();
    await tick(); // finally runs

    // Reservation released; `running` carries the slot — no gap, no leak.
    expect(state.retryAttempts.has("a")).toBe(false);
    expect(state.running.has("a")).toBe(true);
    expect(dispatchIssue).toHaveBeenCalledTimes(1);
  });

  it("releases the reservation on a bail path so the slot isn't leaked", async () => {
    const state = createInitialState();
    seedReservation(state, "a", 2);
    const dispatchIssue = vi.fn();

    const deps = {
      state,
      tracker: {
        // checkState=true: issue is no longer in an active state → bail.
        fetchIssueStatesByIds: vi.fn().mockResolvedValue(new Map([["a", "Done"]])),
        fetchCandidates: vi.fn(),
      },
      config: { maxConcurrentAgents: 1, trackerConfig: { active_states: ["Todo"] } },
      dispatchIssue,
      onError: vi.fn(),
    } as unknown as RefetchAndDispatchDeps;

    refetchAndDispatch(deps, "a", 2, true);
    await tick();

    expect(dispatchIssue).not.toHaveBeenCalled();
    expect(state.retryAttempts.has("a")).toBe(false); // finally released it
  });
});

import { describe, expect, it, vi } from "vitest";

// Keep the worker from ever resolving so a dispatched entry stays in
// `state.running` and we can inspect the post-dispatch state directly.
vi.mock("../../../src/worker/runner.js", () => ({
  runWorker: vi.fn(() => new Promise<never>(() => {})),
}));

import { type DispatchIssueDeps, dispatchIssue } from "../../../src/orchestrator/dispatch-issue.js";
import { createInitialState, type OrchestratorState } from "../../../src/orchestrator/types.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";
import { createInodePressureState } from "../../../src/workspace/inode-pressure.js";

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

function makeDeps(state: OrchestratorState): DispatchIssueDeps {
  return {
    state,
    // Empty map → currentState is undefined → dispatch proceeds (fail-open).
    tracker: { fetchIssueStatesByIds: async () => new Map() } as never,
    agent: {} as never,
    workspace: {} as never,
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

describe("dispatchIssue — session-origin reset", () => {
  it("resets the session origin when dispatching into a fully idle anvil", async () => {
    const state = createInitialState();
    // Stale origins left over from a previous Forge build.
    state.sessionStartedAt = performance.now() - 10_000;
    state.buildStartedAt = 1234;

    await dispatchIssue(makeDeps(state), makeIssue("a"));

    expect(state.running.size).toBe(1);
    // The new feature session must start its own clock, not inherit the stale
    // 10s-old origin.
    expect(state.sessionStartedAt).toBeGreaterThan(performance.now() - 1_000);
    // A non-build dispatch must not carry over a stale build-level clock.
    expect(state.buildStartedAt).toBeUndefined();
  });

  it("does not move the origin when a second worker joins an already-active session", async () => {
    const state = createInitialState();
    const deps = makeDeps(state);

    await dispatchIssue(deps, makeIssue("a"));
    const originAfterFirst = state.sessionStartedAt;

    await dispatchIssue(deps, makeIssue("b"));

    expect(state.running.size).toBe(2);
    // The origin is fixed for the whole build; a second concurrent worker must
    // not restart Runtime.
    expect(state.sessionStartedAt).toBe(originAfterFirst);
    // Without a tracker-reported active build there is no build-level clock.
    expect(state.buildStartedAt).toBeUndefined();
  });

  it("holds the origin when dispatching while a retry is still pending", async () => {
    const state = createInitialState();
    state.sessionStartedAt = 5_000;
    // A prior worker is mid-retry-backoff: no running entry, but its slot is
    // held in retryAttempts, so the anvil is not idle.
    state.retryAttempts.set("z", { issueId: "z", attempt: 2 } as never);

    await dispatchIssue(makeDeps(state), makeIssue("a"));

    expect(state.running.size).toBe(1);
    expect(state.sessionStartedAt).toBe(5_000);
  });

  it("keeps the build origin across sequential dispatches while the build is still active", async () => {
    const state = createInitialState();
    state.sessionStartedAt = 5_000;
    state.progress = { total: 3, done: 0 };

    // First ticket of the build starts the build clock.
    await dispatchIssue(makeDeps(state), makeIssue("a"));
    expect(state.running.size).toBe(1);
    const buildOrigin = state.buildStartedAt;
    expect(buildOrigin).toBeDefined();
    expect(buildOrigin).toBeGreaterThan(0);
    // Session clock is not reset because the tracker-reported build is active.
    expect(state.sessionStartedAt).toBe(5_000);

    // Simulate the first worker completing and the anvil briefly going idle
    // before the next ticket is dispatched. The build still has unfinished
    // tickets, so the build clock must not restart.
    state.running.delete("a");
    await dispatchIssue(makeDeps(state), makeIssue("b"));

    expect(state.running.size).toBe(1);
    expect(state.buildStartedAt).toBe(buildOrigin);
    expect(state.sessionStartedAt).toBe(5_000);
  });
});

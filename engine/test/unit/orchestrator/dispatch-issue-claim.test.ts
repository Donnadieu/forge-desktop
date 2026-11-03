import { describe, expect, it, vi } from "vitest";

// Keep the worker from ever resolving so "was this ticket dispatched?" is
// exactly "is there a running entry?".
vi.mock("../../../src/worker/runner.js", () => ({
  runWorker: vi.fn(() => new Promise<never>(() => {})),
}));

import { type DispatchIssueDeps, dispatchIssue } from "../../../src/orchestrator/dispatch-issue.js";
import { createInitialState, type OrchestratorState } from "../../../src/orchestrator/types.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";
import { createInodePressureState } from "../../../src/workspace/inode-pressure.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";

function makeIssue(): NormalizedIssue {
  return {
    id: "issue-1",
    identifier: "FRG-1",
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

function makeDeps(
  state: OrchestratorState,
  tracker: MemoryTracker,
  config: Record<string, unknown>,
): DispatchIssueDeps {
  return {
    state,
    tracker: tracker as never,
    agent: {} as never,
    // No workspace root ⇒ the inode gate is skipped, isolating the claim gate.
    workspace: { config: undefined } as unknown as WorkspaceManager,
    config: {
      maxTurns: 1,
      promptTemplate: "",
      trackerConfig: {
        kind: "memory",
        project_slug: "x",
        active_states: ["Todo"],
        terminal_states: ["Done"],
      },
      ...config,
    } as never,
    callbacks: {},
    isStopped: () => false,
    isDraining: () => false,
    inodePressure: createInodePressureState(),
    handleWorkerComplete: () => {},
    handleWorkerError: () => {},
  };
}

describe("dispatchIssue — ticket claim (FRG-1988)", () => {
  it("does not claim anything with the master flag off", async () => {
    const tracker = new MemoryTracker([makeIssue()]);
    const state = createInitialState();

    await dispatchIssue(makeDeps(state, tracker, {}), makeIssue());

    expect(state.running.size).toBe(1);
    // Unchanged behavior: no assignment written, ticket left in Todo.
    expect(tracker.getIssue("issue-1")?.assignee).toBeUndefined();
    expect(tracker.getIssue("issue-1")?.state).toBe("Todo");
  });

  it("makes the claim visible in the tracker at pickup when the flag is on", async () => {
    const tracker = new MemoryTracker([makeIssue()]);
    const state = createInitialState();

    await dispatchIssue(
      makeDeps(state, tracker, {
        customWorkflows: true,
        claimOptions: { assignee: "agent-1", stateName: "In Progress" },
      }),
      makeIssue(),
    );

    expect(state.running.size).toBe(1);
    expect(tracker.getIssue("issue-1")?.assignee).toBe("agent-1");
    expect(tracker.getIssue("issue-1")?.state).toBe("In Progress");
  });

  it("never lets two agents hold the same ticket", async () => {
    // One tracker, two orchestrators — the parallel-work scenario the ticket
    // is about. The second must find the ticket claimed and stand down.
    const tracker = new MemoryTracker([makeIssue()]);
    const first = createInitialState();
    const second = createInitialState();

    await dispatchIssue(
      makeDeps(first, tracker, {
        customWorkflows: true,
        claimOptions: { assignee: "agent-1" },
      }),
      makeIssue(),
    );
    await dispatchIssue(
      makeDeps(second, tracker, {
        customWorkflows: true,
        claimOptions: { assignee: "agent-2" },
      }),
      makeIssue(),
    );

    expect(first.running.size).toBe(1);
    expect(second.running.size).toBe(0);
    expect(tracker.getIssue("issue-1")?.assignee).toBe("agent-1");
  });

  it("fails closed: a claim error blocks dispatch instead of racing", async () => {
    const tracker = new MemoryTracker([makeIssue()]);
    vi.spyOn(tracker, "claimIssue").mockRejectedValue(new Error("tracker 503"));
    const state = createInitialState();

    await dispatchIssue(
      makeDeps(state, tracker, {
        customWorkflows: true,
        claimOptions: { assignee: "agent-1" },
        logger: { warn: vi.fn(), info: vi.fn() },
      }),
      makeIssue(),
    );

    expect(state.running.size).toBe(0);
  });
});

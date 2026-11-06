import { describe, expect, it, vi } from "vitest";

// Keep the worker from ever resolving so "was this ticket dispatched?" is
// exactly "is there a running entry?".
vi.mock("../../../src/worker/runner.js", () => ({
  runWorker: vi.fn(() => new Promise<never>(() => {})),
}));

import { type DispatchIssueDeps, dispatchIssue } from "../../../src/orchestrator/dispatch-issue.js";
import { selectIssuesToDispatch } from "../../../src/orchestrator/dispatcher.js";
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
    // A claim error is transient: the card keeps its rank.
    expect(state.claimRefused.size).toBe(0);
  });

  it("remembers a card someone else holds, not one it claimed", async () => {
    const tracker = new MemoryTracker([makeIssue()]);
    const state = createInitialState();
    const config = { customWorkflows: true, logger: { warn: vi.fn(), info: vi.fn() } };

    await dispatchIssue(
      makeDeps(state, tracker, { ...config, claimOptions: { assignee: "agent-2" } }),
      makeIssue(),
    );
    expect(state.running.size).toBe(1);
    expect(state.claimRefused.size).toBe(0);

    const other = createInitialState();
    await dispatchIssue(
      makeDeps(other, tracker, { ...config, claimOptions: { assignee: "agent-1" } }),
      makeIssue(),
    );
    expect(other.running.size).toBe(0);
    expect(other.claimRefused.has("issue-1")).toBe(true);
  });

  it("a card held by someone else no longer takes the only free slot every poll", async () => {
    // The ConstructEase stall: a card another person holds sits in a later
    // column, so it ranks first; with one free slot it was tried and refused
    // every poll and the Todo card behind it never ran.
    const held: NormalizedIssue = {
      ...makeIssue(),
      id: "held",
      identifier: "BC-1",
      state: "In Progress",
    };
    const todo: NormalizedIssue = { ...makeIssue(), id: "todo", identifier: "BC-2", state: "Todo" };
    const tracker = new MemoryTracker([held, todo]);
    await tracker.claimIssue(
      { issueId: "held", assignee: "someone-else" },
      { activeStates: ["Todo", "In Progress"] },
    );
    const state = createInitialState();
    const deps = makeDeps(state, tracker, {
      customWorkflows: true,
      claimOptions: { assignee: "forge" },
      logger: { warn: vi.fn(), info: vi.fn() },
      trackerConfig: {
        kind: "memory",
        project_slug: "x",
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Done"],
      },
    });
    const select = () =>
      selectIssuesToDispatch([held, todo], state, {
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Done"],
        max_concurrent_agents: 1,
      });

    // First poll: the held card ranks first and its claim is refused.
    expect(select().map((i) => i.id)).toEqual(["held"]);
    for (const issue of select()) await dispatchIssue(deps, issue);
    expect(state.running.size).toBe(0);
    expect(state.claimRefused.has("held")).toBe(true);

    // Next poll: the free slot goes to the Todo card.
    for (const issue of select()) await dispatchIssue(deps, issue);
    expect([...state.running.keys()]).toEqual(["todo"]);
  });
});

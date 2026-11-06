import { describe, expect, it } from "vitest";
import {
  CLAIM_REFUSED_BACKOFF_MS,
  claimRefusedRecently,
  noteClaimRefused,
  selectIssuesToDispatch,
  shouldDispatchIssue,
  sortIssuesForDispatch,
} from "../../../src/orchestrator/dispatcher.js";
import { createInitialState } from "../../../src/orchestrator/types.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";

function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    id: "id-1",
    identifier: "MT-1",
    title: "Test",
    description: "",
    state: "Todo",
    priority: 2,
    labels: [],
    blockedBy: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("sortIssuesForDispatch", () => {
  it("sorts by priority ascending (urgent first)", () => {
    const issues = [
      makeIssue({ id: "low", priority: 4 }),
      makeIssue({ id: "urgent", priority: 0 }),
      makeIssue({ id: "high", priority: 1 }),
    ];
    const sorted = sortIssuesForDispatch(issues);
    expect(sorted.map((i) => i.id)).toEqual(["urgent", "high", "low"]);
  });

  it("sorts by createdAt for same priority", () => {
    const issues = [
      makeIssue({ id: "new", priority: 2, createdAt: "2024-06-01T00:00:00Z" }),
      makeIssue({ id: "old", priority: 2, createdAt: "2024-01-01T00:00:00Z" }),
    ];
    const sorted = sortIssuesForDispatch(issues);
    expect(sorted.map((i) => i.id)).toEqual(["old", "new"]);
  });

  it("sorts null priority after numeric priorities", () => {
    const issues = [
      makeIssue({ id: "a", priority: null, createdAt: "2024-01-01T00:00:00Z" }),
      makeIssue({ id: "b", priority: 1, createdAt: "2024-01-01T00:00:00Z" }),
      makeIssue({ id: "c", identifier: "MT-0", priority: 0, createdAt: "2024-01-01T00:00:00Z" }),
    ];
    const sorted = sortIssuesForDispatch(issues);
    expect(sorted.map((i) => i.id)).toEqual(["c", "b", "a"]);
  });

  it("uses identifier as tiebreaker when priority and createdAt are equal", () => {
    const issues = [
      makeIssue({ id: "a", identifier: "MT-2", priority: 1, createdAt: "2024-01-01T00:00:00Z" }),
      makeIssue({ id: "b", identifier: "MT-1", priority: 1, createdAt: "2024-01-01T00:00:00Z" }),
    ];
    const sorted = sortIssuesForDispatch(issues);
    expect(sorted.map((i) => i.id)).toEqual(["b", "a"]);
  });

  // Pipeline-stage priority: tickets further along the pipeline dispatch first
  // (merge before starting new work, then walk backwards). Stage order is
  // derived from the `activeStates` list (earliest-first) passed by the caller.
  const pipeline = ["Todo", "In Progress", "AI Review", "QA", "Rework", "Merging"];

  it("prioritizes the furthest-along stage even over an urgent-priority earlier ticket", () => {
    const issues = [
      makeIssue({ id: "todo-urgent", state: "Todo", priority: 0 }),
      makeIssue({ id: "merging-low", state: "Merging", priority: 4 }),
    ];
    const sorted = sortIssuesForDispatch(issues, pipeline);
    expect(sorted.map((i) => i.id)).toEqual(["merging-low", "todo-urgent"]);
  });

  it("orders every stage further-along first (walk backwards from Merging)", () => {
    const issues = [
      makeIssue({ id: "todo", state: "Todo" }),
      makeIssue({ id: "merging", state: "Merging" }),
      makeIssue({ id: "qa", state: "QA" }),
      makeIssue({ id: "inprog", state: "In Progress" }),
      makeIssue({ id: "aireview", state: "AI Review" }),
      makeIssue({ id: "rework", state: "Rework" }),
    ];
    const sorted = sortIssuesForDispatch(issues, pipeline);
    expect(sorted.map((i) => i.id)).toEqual([
      "merging",
      "rework",
      "qa",
      "aireview",
      "inprog",
      "todo",
    ]);
  });

  it("falls back to priority then age within the same stage", () => {
    const issues = [
      makeIssue({ id: "new", state: "QA", priority: 1, createdAt: "2024-06-01T00:00:00Z" }),
      makeIssue({ id: "old", state: "QA", priority: 1, createdAt: "2024-01-01T00:00:00Z" }),
      makeIssue({ id: "urgent", state: "QA", priority: 0, createdAt: "2024-09-01T00:00:00Z" }),
    ];
    const sorted = sortIssuesForDispatch(issues, pipeline);
    expect(sorted.map((i) => i.id)).toEqual(["urgent", "old", "new"]);
  });

  it("sorts states not in activeStates after known stages", () => {
    const issues = [
      makeIssue({ id: "unknown", state: "Somewhere", priority: 0 }),
      makeIssue({ id: "todo", state: "Todo", priority: 4 }),
    ];
    const sorted = sortIssuesForDispatch(issues, pipeline);
    expect(sorted.map((i) => i.id)).toEqual(["todo", "unknown"]);
  });

  it("ignores stage ordering when activeStates is omitted (priority/age only)", () => {
    const issues = [
      makeIssue({ id: "todo-urgent", state: "Todo", priority: 0 }),
      makeIssue({ id: "merging-low", state: "Merging", priority: 4 }),
    ];
    const sorted = sortIssuesForDispatch(issues);
    expect(sorted.map((i) => i.id)).toEqual(["todo-urgent", "merging-low"]);
  });
});

describe("shouldDispatchIssue", () => {
  const config = {
    active_states: ["Todo", "In Progress"],
    terminal_states: ["Done"],
    max_concurrent_agents: 5,
  };

  it("allows dispatch for eligible issue", () => {
    const state = createInitialState();
    const issue = makeIssue();
    expect(shouldDispatchIssue(issue, state, config)).toBe(true);
  });

  it("rejects already running issue", () => {
    const state = createInitialState();
    state.running.set("id-1", {} as any);
    expect(shouldDispatchIssue(makeIssue(), state, config)).toBe(false);
  });

  it("rejects claimed issue", () => {
    const state = createInitialState();
    state.claimed.add("id-1");
    expect(shouldDispatchIssue(makeIssue(), state, config)).toBe(false);
  });

  it("allows dispatch for completed issue (observability only)", () => {
    const state = createInitialState();
    state.completed.add("id-1");
    expect(shouldDispatchIssue(makeIssue(), state, config)).toBe(true);
  });

  it("rejects issue with pending retry", () => {
    const state = createInitialState();
    state.retryAttempts.set("id-1", {} as any);
    expect(shouldDispatchIssue(makeIssue(), state, config)).toBe(false);
  });

  it("rejects issue not in active state", () => {
    const state = createInitialState();
    expect(shouldDispatchIssue(makeIssue({ state: "Done" }), state, config)).toBe(false);
  });

  it("rejects issue with active blockers", () => {
    const state = createInitialState();
    const issue = makeIssue({
      blockedBy: [{ id: "blocker", state: "In Progress" }],
    });
    expect(shouldDispatchIssue(issue, state, config)).toBe(false);
  });

  it("allows issue with completed blockers", () => {
    const state = createInitialState();
    const issue = makeIssue({
      blockedBy: [{ id: "blocker", state: "Done" }],
    });
    expect(shouldDispatchIssue(issue, state, config)).toBe(true);
  });

  it("rejects issue with non-terminal blockers even in non-active state", () => {
    const state = createInitialState();
    const issue = makeIssue({
      blockedBy: [{ id: "blocker", state: "Review" }],
    });
    // "Review" is not in terminal_states, so it should block
    expect(shouldDispatchIssue(issue, state, config)).toBe(false);
  });

  it("rejects when at concurrency limit", () => {
    const state = createInitialState();
    for (let i = 0; i < 5; i++) {
      state.running.set(`running-${i}`, {} as any);
    }
    expect(shouldDispatchIssue(makeIssue(), state, config)).toBe(false);
  });

  it("rejects when per-state concurrency limit reached", () => {
    const state = createInitialState();
    state.running.set("running-1", {
      issue: makeIssue({ id: "running-1", state: "Todo" }),
    } as any);
    state.running.set("running-2", {
      issue: makeIssue({ id: "running-2", state: "Todo" }),
    } as any);
    const perStateConfig = {
      ...config,
      max_concurrent_agents_by_state: { Todo: 2 },
    };
    expect(
      shouldDispatchIssue(makeIssue({ id: "new-1", state: "Todo" }), state, perStateConfig),
    ).toBe(false);
  });

  it("allows dispatch when per-state limit not reached", () => {
    const state = createInitialState();
    state.running.set("running-1", {
      issue: makeIssue({ id: "running-1", state: "In Progress" }),
    } as any);
    const perStateConfig = {
      ...config,
      max_concurrent_agents_by_state: { Todo: 2 },
    };
    expect(
      shouldDispatchIssue(makeIssue({ id: "new-1", state: "Todo" }), state, perStateConfig),
    ).toBe(true);
  });

  it("ignores per-state limit when not configured for that state", () => {
    const state = createInitialState();
    state.running.set("running-1", {
      issue: makeIssue({ id: "running-1", state: "Todo" }),
    } as any);
    const perStateConfig = {
      ...config,
      max_concurrent_agents_by_state: { "In Progress": 1 },
    };
    expect(
      shouldDispatchIssue(makeIssue({ id: "new-1", state: "Todo" }), state, perStateConfig),
    ).toBe(true);
  });
});

describe("selectIssuesToDispatch", () => {
  it("selects issues up to concurrency limit", () => {
    const state = createInitialState();
    const issues = [
      makeIssue({ id: "1", identifier: "MT-1" }),
      makeIssue({ id: "2", identifier: "MT-2" }),
      makeIssue({ id: "3", identifier: "MT-3" }),
    ];
    const selected = selectIssuesToDispatch(issues, state, {
      active_states: ["Todo"],
      terminal_states: ["Done"],
      max_concurrent_agents: 2,
    });
    expect(selected).toHaveLength(2);
  });

  it("respects priority ordering", () => {
    const state = createInitialState();
    const issues = [
      makeIssue({ id: "low", priority: 4 }),
      makeIssue({ id: "urgent", priority: 0 }),
    ];
    const selected = selectIssuesToDispatch(issues, state, {
      active_states: ["Todo"],
      terminal_states: ["Done"],
      max_concurrent_agents: 10,
    });
    expect(selected[0].id).toBe("urgent");
  });

  it("dispatches the furthest-along ticket first when a slot is limited", () => {
    const state = createInitialState();
    const issues = [
      makeIssue({ id: "todo", state: "Todo", priority: 0 }),
      makeIssue({ id: "merging", state: "Merging", priority: 4 }),
    ];
    const selected = selectIssuesToDispatch(issues, state, {
      active_states: ["Todo", "In Progress", "Merging"],
      terminal_states: ["Done"],
      max_concurrent_agents: 1,
    });
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe("merging");
  });

  it("gives the free slot to the next card when a later-stage card is held by someone else", () => {
    const state = createInitialState();
    noteClaimRefused(state, "held");
    const issues = [
      makeIssue({ id: "todo", state: "Todo" }),
      makeIssue({ id: "held", state: "In Progress" }),
    ];
    const selected = selectIssuesToDispatch(issues, state, {
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
      max_concurrent_agents: 1,
    });
    expect(selected.map((i) => i.id)).toEqual(["todo"]);
  });

  it("still tries a held card when a slot is spare", () => {
    const state = createInitialState();
    noteClaimRefused(state, "held");
    const issues = [
      makeIssue({ id: "held", state: "In Progress" }),
      makeIssue({ id: "todo", state: "Todo" }),
    ];
    const selected = selectIssuesToDispatch(issues, state, {
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
      max_concurrent_agents: 2,
    });
    expect(selected.map((i) => i.id)).toEqual(["todo", "held"]);
  });

  it("gives a held card its normal rank back once the backoff has passed", () => {
    const state = createInitialState();
    noteClaimRefused(state, "held", Date.now() - CLAIM_REFUSED_BACKOFF_MS - 1);
    expect(claimRefusedRecently(state, "held")).toBe(false);
    const issues = [
      makeIssue({ id: "todo", state: "Todo" }),
      makeIssue({ id: "held", state: "In Progress" }),
    ];
    const selected = selectIssuesToDispatch(issues, state, {
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
      max_concurrent_agents: 1,
    });
    expect(selected.map((i) => i.id)).toEqual(["held"]);
  });

  it("drops expired refusals when a new one is noted", () => {
    const state = createInitialState();
    noteClaimRefused(state, "old", Date.now() - CLAIM_REFUSED_BACKOFF_MS - 1);
    noteClaimRefused(state, "new");
    expect([...state.claimRefused.keys()]).toEqual(["new"]);
  });
});

// FRG-910 acceptance: Smith caps the dispatcher at 1 concurrent agent. With
// three Todo+smith_feature tickets queued, only one is dispatched per tick;
// once it completes, the next one becomes eligible. These tests pin the
// invariant against the dispatcher itself (not the constant) so a downstream
// change to `selectIssuesToDispatch` can't silently double-dispatch.
describe("Smith cap=1: three smith_feature tickets dispatched serially", () => {
  const smithConfig = {
    active_states: ["Todo"],
    terminal_states: ["Done", "Cancelled"],
    max_concurrent_agents: 1,
  };

  const ticketA = makeIssue({
    id: "a",
    identifier: "SMITH-1",
    priority: 0,
    labels: ["smith_feature"],
    createdAt: "2026-05-01T00:00:00Z",
  });
  const ticketB = makeIssue({
    id: "b",
    identifier: "SMITH-2",
    priority: 1,
    labels: ["smith_feature"],
    createdAt: "2026-05-02T00:00:00Z",
  });
  const ticketC = makeIssue({
    id: "c",
    identifier: "SMITH-3",
    priority: 2,
    labels: ["smith_feature"],
    createdAt: "2026-05-03T00:00:00Z",
  });
  const queue = [ticketA, ticketB, ticketC];

  it("tick 1: selects exactly one (highest priority)", () => {
    const state = createInitialState();
    const selected = selectIssuesToDispatch(queue, state, smithConfig);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe("a");
  });

  it("tick 2 (one running): selects zero — cap=1 holds", () => {
    const state = createInitialState();
    state.running.set("a", { issue: ticketA } as never);
    const selected = selectIssuesToDispatch(queue, state, smithConfig);
    expect(selected).toHaveLength(0);
  });

  it("tick 3 (after completion): next eligible smith_feature is selected", () => {
    const state = createInitialState();
    state.completed.add("a");
    const selected = selectIssuesToDispatch([ticketB, ticketC], state, smithConfig);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe("b");
  });

  it("tick 4 (b running): still cap=1, c blocked", () => {
    const state = createInitialState();
    state.completed.add("a");
    state.running.set("b", { issue: ticketB } as never);
    const selected = selectIssuesToDispatch([ticketC], state, smithConfig);
    expect(selected).toHaveLength(0);
  });

  it("tick 5 (b done): last ticket dispatches", () => {
    const state = createInitialState();
    state.completed.add("a");
    state.completed.add("b");
    const selected = selectIssuesToDispatch([ticketC], state, smithConfig);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe("c");
  });
});

// FRG cap=1 retry-slot bug: a feature that fails retryably is moved out of
// `running` and into `retryAttempts` for the duration of its retry delay. If
// capacity counted only `running`, a waiting `approved` feature would be
// dispatched against the same agent during that window. The in-flight count
// (running + claimed + retryAttempts) closes this — a pending retry still owns
// its slot.
describe("Smith cap=1: pending retry / claim occupies the agent slot", () => {
  const smithConfig = {
    active_states: ["Todo"],
    terminal_states: ["Done", "Cancelled"],
    max_concurrent_agents: 1,
  };
  const ticketA = makeIssue({ id: "a", identifier: "SMITH-1", priority: 0 });
  const ticketB = makeIssue({ id: "b", identifier: "SMITH-2", priority: 1 });

  it("one pending retry → waiting approved feature is NOT picked up", () => {
    // A failed retryably (now in retryAttempts, not running). B is waiting.
    const state = createInitialState();
    state.retryAttempts.set("a", { issueId: "a", attempt: 2 } as never);

    expect(shouldDispatchIssue(ticketB, state, smithConfig)).toBe(false);
    expect(selectIssuesToDispatch([ticketB], state, smithConfig)).toHaveLength(0);
  });

  it("one running + one pending retry → still cap=1, nothing else dispatched", () => {
    const state = createInitialState();
    state.running.set("a", { issue: ticketA } as never);
    state.retryAttempts.set("z", { issueId: "z", attempt: 2 } as never);

    expect(selectIssuesToDispatch([ticketB], state, smithConfig)).toHaveLength(0);
  });

  it("a mid-dispatch claim counts toward the cap", () => {
    const state = createInitialState();
    state.claimed.add("a");

    expect(shouldDispatchIssue(ticketB, state, smithConfig)).toBe(false);
    expect(selectIssuesToDispatch([ticketB], state, smithConfig)).toHaveLength(0);
  });

  it("once the retry resolves (slot freed), the waiting feature dispatches", () => {
    // Retry resolved: A left both running and retryAttempts (e.g. shipped or
    // terminally failed). B is now eligible.
    const state = createInitialState();
    state.completed.add("a");

    expect(selectIssuesToDispatch([ticketB], state, smithConfig)).toHaveLength(1);
  });
});

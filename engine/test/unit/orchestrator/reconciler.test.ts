import { describe, expect, it } from "vitest";
import { reconcileRunningIssues } from "../../../src/orchestrator/reconciler.js";
import { createInitialState } from "../../../src/orchestrator/types.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";

function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    id: "id-1",
    identifier: "MT-1",
    title: "Test",
    description: "",
    state: "In Progress",
    priority: 2,
    labels: [],
    blockedBy: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeRunningEntry(overrides: any = {}) {
  return {
    issueId: "id-1",
    identifier: "MT-1",
    issue: makeIssue(),
    startedAt: performance.now() - 60_000,
    lastActivityAt: performance.now(),
    tokens: { input: 0, output: 0 },
    workspacePath: "/tmp/ws",
    attempt: 1,
    abortController: new AbortController(),
    workerPromise: Promise.resolve(),
    ...overrides,
  };
}

describe("reconcileRunningIssues", () => {
  it("returns empty result when nothing is running", async () => {
    const state = createInitialState();
    const tracker = new MemoryTracker();
    const result = await reconcileRunningIssues(state, tracker, {
      active_states: ["In Progress"],
      terminal_states: ["Done"],
      stall_timeout_seconds: 300,
    });
    expect(result.toKill).toEqual([]);
    expect(result.toRetry).toEqual([]);
  });

  it("marks issue for completion when it moves to a done (success) state", async () => {
    const state = createInitialState();
    state.running.set("id-1", makeRunningEntry());

    const tracker = new MemoryTracker([makeIssue({ state: "Done" })]);

    const result = await reconcileRunningIssues(state, tracker, {
      active_states: ["In Progress"],
      terminal_states: ["Done", "Cancelled"],
      done_states: ["Done"],
      stall_timeout_seconds: 300,
    });
    // "Done" is a success terminal — record completed, never killed-as-cancelled.
    expect(result.toComplete).toContain("id-1");
    expect(result.toKill).not.toContain("id-1");
  });

  it("completes a Smith build when its ticket reaches In Review (done state)", async () => {
    // Regression: Smith workers end a build in "In Review" (never Done). With
    // In Review in terminal_states + done_states the reconciler must complete
    // it (fires onComplete -> markAwaitingReview), not kill it as cancelled.
    const state = createInitialState();
    state.running.set("id-1", makeRunningEntry());

    const tracker = new MemoryTracker([makeIssue({ state: "In Review" })]);

    const result = await reconcileRunningIssues(state, tracker, {
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done", "Cancelled", "In Review"],
      done_states: ["Done", "In Review"],
      stall_timeout_seconds: 300,
    });
    expect(result.toComplete).toContain("id-1");
    expect(result.toKill).not.toContain("id-1");
  });

  it("marks issue for kill (cancelled) when it moves to a cancel terminal state", async () => {
    const state = createInitialState();
    state.running.set("id-1", makeRunningEntry());

    const tracker = new MemoryTracker([makeIssue({ state: "Cancelled" })]);

    const result = await reconcileRunningIssues(state, tracker, {
      active_states: ["In Progress"],
      terminal_states: ["Done", "Cancelled"],
      done_states: ["Done"],
      stall_timeout_seconds: 300,
    });
    expect(result.toKill).toContain("id-1");
    expect(result.toComplete).not.toContain("id-1");
  });

  it("defaults done_states to Done/Closed when omitted", async () => {
    const state = createInitialState();
    state.running.set("id-1", makeRunningEntry());

    const tracker = new MemoryTracker([makeIssue({ state: "Done" })]);

    const result = await reconcileRunningIssues(state, tracker, {
      active_states: ["In Progress"],
      terminal_states: ["Done", "Cancelled"],
      stall_timeout_seconds: 300,
    });
    expect(result.toComplete).toContain("id-1");
  });

  it("marks issue for kill when it disappears from tracker", async () => {
    const state = createInitialState();
    state.running.set("id-1", makeRunningEntry());

    const tracker = new MemoryTracker(); // no issues

    const result = await reconcileRunningIssues(state, tracker, {
      active_states: ["In Progress"],
      terminal_states: ["Done"],
      stall_timeout_seconds: 300,
    });
    expect(result.toKill).toContain("id-1");
    expect(result.staleIds).toContain("id-1");
  });

  it("marks stalled issue for retry", async () => {
    const state = createInitialState();
    state.running.set(
      "id-1",
      makeRunningEntry({
        lastActivityAt: performance.now() - 600_000, // 10 minutes ago
      }),
    );

    const tracker = new MemoryTracker([makeIssue({ state: "In Progress" })]);

    const result = await reconcileRunningIssues(state, tracker, {
      active_states: ["In Progress"],
      terminal_states: ["Done"],
      stall_timeout_seconds: 300, // 5 minutes
    });
    expect(result.toRetry).toContain("id-1");
  });

  it("does not mark active issue as stalled when within timeout", async () => {
    const state = createInitialState();
    state.running.set(
      "id-1",
      makeRunningEntry({
        lastActivityAt: performance.now() - 10_000, // 10 seconds ago
      }),
    );

    const tracker = new MemoryTracker([makeIssue({ state: "In Progress" })]);

    const result = await reconcileRunningIssues(state, tracker, {
      active_states: ["In Progress"],
      terminal_states: ["Done"],
      stall_timeout_seconds: 300,
    });
    expect(result.toRetry).toEqual([]);
    expect(result.toKill).toEqual([]);
  });

  it("returns empty result when fetchIssueStatesByIds throws", async () => {
    const state = createInitialState();
    state.running.set("id-1", makeRunningEntry());

    const failingTracker = {
      kind: "memory" as const,
      fetchCandidates: async () => [],
      fetchIssueStatesByIds: async () => {
        throw new Error("API failure");
      },
      fetchTerminalIssues: async () => [],
    };

    const result = await reconcileRunningIssues(state, failingTracker, {
      active_states: ["In Progress"],
      terminal_states: ["Done"],
      stall_timeout_seconds: 300,
    });
    expect(result.toKill).toEqual([]);
    expect(result.toRetry).toEqual([]);
    expect(result.staleIds).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AgentEvent } from "../../../src/agent/types.js";
import { selectIssuesToDispatch } from "../../../src/orchestrator/dispatcher.js";
import { Orchestrator } from "../../../src/orchestrator/orchestrator.js";
import { createInitialState } from "../../../src/orchestrator/types.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";
import { grantedWorkspaceLock } from "../../support/workspace-lock.js";

function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    id: "id-1",
    identifier: "MT-1",
    title: "Test",
    description: "Test desc",
    state: "Todo",
    priority: 2,
    labels: [],
    blockedBy: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function createMockAgent(): AgentAdapter {
  return {
    name: "mock",
    persistentSession: true,
    async startSession() {
      return { id: "s-1", abortController: new AbortController() };
    },
    async *streamEvents(): AsyncIterable<AgentEvent> {
      yield { type: "done", success: true };
    },
    async stopSession() {},
  };
}

function createMockWorkspace(): WorkspaceManager {
  return {
    ensureWorkspace: vi.fn().mockResolvedValue("/tmp/ws"),
    acquireLock: grantedWorkspaceLock().acquireLock,
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    runHook: vi.fn().mockResolvedValue(undefined),
    writeMcpConfig: vi.fn().mockResolvedValue("/tmp/ws/.forge/mcp.json"),
    toSafeId: vi.fn((id: string) => id),
  } as unknown as WorkspaceManager;
}

describe("Orchestrator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches eligible issues on tick", async () => {
    vi.useFakeTimers();
    const tracker = new MemoryTracker([makeIssue()]);
    const agent = createMockAgent();
    const workspace = createMockWorkspace();
    const dispatched: string[] = [];

    const orchestrator = new Orchestrator(
      tracker,
      agent,
      workspace,
      {
        pollIntervalMs: 1000,
        maxConcurrentAgents: 5,
        maxTurns: 1,
        stallTimeoutSeconds: 300,
        maxRetryAttempts: 3,
        maxRetryDelayMs: 300_000,
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
        promptTemplate: "Fix {{ issue.identifier }}",
      },
      {
        onDispatch: (issue) => dispatched.push(issue.id),
      },
    );

    orchestrator.start();

    // Advance past first tick (immediate)
    await vi.advanceTimersByTimeAsync(50);

    expect(dispatched).toContain("id-1");

    await orchestrator.stop();
  });

  it("respects concurrency limits", () => {
    // Test dispatcher directly to verify concurrency enforcement
    // without timing issues from async workers
    const state = createInitialState();
    // Simulate 2 already-running workers
    state.running.set("running-1", {} as any);
    state.running.set("running-2", {} as any);

    const issues = [
      makeIssue({ id: "3", identifier: "MT-3" }),
      makeIssue({ id: "4", identifier: "MT-4" }),
    ];

    const selected = selectIssuesToDispatch(issues, state, {
      active_states: ["Todo"],
      terminal_states: ["Done"],
      max_concurrent_agents: 2, // Limit is 2, already running 2
    });

    // Should not dispatch any since we're at capacity
    expect(selected).toHaveLength(0);

    // With capacity for 1 more
    const selected2 = selectIssuesToDispatch(issues, state, {
      active_states: ["Todo"],
      terminal_states: ["Done"],
      max_concurrent_agents: 3, // Limit is 3, running 2 => room for 1
    });

    expect(selected2).toHaveLength(1);
  });

  it("skips dispatch when issue state changed between fetch and dispatch", async () => {
    vi.useFakeTimers();
    const issue = makeIssue({ state: "Todo" });
    const tracker = new MemoryTracker([issue]);

    const origFetchCandidates = tracker.fetchCandidates.bind(tracker);
    tracker.fetchCandidates = async (config) => {
      const candidates = await origFetchCandidates(config);
      // Simulate race: issue moves to Done after candidates fetched
      await tracker.updateIssueState("id-1", "Done");
      return candidates;
    };

    const agent = createMockAgent();
    const workspace = createMockWorkspace();
    const dispatched: string[] = [];

    const orchestrator = new Orchestrator(
      tracker,
      agent,
      workspace,
      {
        pollIntervalMs: 100_000,
        maxConcurrentAgents: 5,
        maxTurns: 1,
        stallTimeoutSeconds: 300,
        maxRetryAttempts: 3,
        maxRetryDelayMs: 300_000,
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
        promptTemplate: "Fix it",
      },
      {
        onDispatch: (issue) => dispatched.push(issue.id),
      },
    );

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(dispatched).toHaveLength(0);

    await orchestrator.stop();
  });

  it("schedules continuation retry after successful completion", async () => {
    vi.useFakeTimers();
    const issue = makeIssue({ state: "Todo" });
    const tracker = new MemoryTracker([issue]);
    const agent = createMockAgent();
    const workspace = createMockWorkspace();
    const completed: string[] = [];
    const dispatched: string[] = [];

    const orchestrator = new Orchestrator(
      tracker,
      agent,
      workspace,
      {
        pollIntervalMs: 100_000,
        maxConcurrentAgents: 5,
        maxTurns: 1,
        stallTimeoutSeconds: 300,
        maxRetryAttempts: 3,
        maxRetryDelayMs: 300_000,
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
        promptTemplate: "Fix it",
      },
      {
        onDispatch: (issue) => dispatched.push(issue.id),
        onComplete: (id) => completed.push(id),
      },
    );

    orchestrator.start();
    // First tick dispatches the issue, mock agent completes immediately
    await vi.advanceTimersByTimeAsync(50);

    expect(dispatched).toContain("id-1");
    expect(completed).toContain("id-1");

    // Continuation delay is 1000ms; advance past it + allow async resolution
    await vi.advanceTimersByTimeAsync(1100);
    expect(dispatched.filter((id) => id === "id-1").length).toBeGreaterThanOrEqual(2);

    await orchestrator.stop();
  });

  it("preserves workspace when maxTurns hit for continuation", async () => {
    vi.useFakeTimers();
    const issue = makeIssue({ state: "Todo" });
    const tracker = new MemoryTracker([issue]);
    const agent = createMockAgent();
    const workspace = createMockWorkspace();

    const orchestrator = new Orchestrator(tracker, agent, workspace, {
      pollIntervalMs: 100_000,
      maxConcurrentAgents: 5,
      maxTurns: 1,
      stallTimeoutSeconds: 300,
      maxRetryAttempts: 3,
      maxRetryDelayMs: 300_000,
      trackerConfig: {
        kind: "memory",
        project_slug: "test",
        active_states: ["Todo"],
        terminal_states: ["Done"],
      },
      promptTemplate: "Fix it",
    });

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(50);

    // Workspace should be preserved when maxTurns is hit (for re-dispatch to resume)
    expect(workspace.removeWorkspace).not.toHaveBeenCalled();

    await orchestrator.stop();
  });

  it("stops cleanly", async () => {
    const tracker = new MemoryTracker();
    const agent = createMockAgent();
    const workspace = createMockWorkspace();

    const orchestrator = new Orchestrator(tracker, agent, workspace, {
      pollIntervalMs: 1000,
      maxConcurrentAgents: 5,
      maxTurns: 1,
      stallTimeoutSeconds: 300,
      maxRetryAttempts: 3,
      maxRetryDelayMs: 300_000,
      trackerConfig: {
        kind: "memory",
        project_slug: "test",
        active_states: ["Todo"],
        terminal_states: ["Done"],
      },
      promptTemplate: "Fix it",
    });

    orchestrator.start();
    await orchestrator.stop();

    const state = orchestrator.getState();
    expect(state.running.size).toBe(0);
    expect(state.tickTimerId).toBeNull();
  });

  it("getPollHealth surfaces a thrown poll error and clears it on the next clean poll", async () => {
    vi.useFakeTimers();
    const tracker = new MemoryTracker([makeIssue()]);
    let failNextPoll = true;
    const origFetchCandidates = tracker.fetchCandidates.bind(tracker);
    tracker.fetchCandidates = async (config) => {
      if (failNextPoll) {
        failNextPoll = false;
        throw new Error("Linear project slug is required");
      }
      return origFetchCandidates(config);
    };

    const orchestrator = new Orchestrator(tracker, createMockAgent(), createMockWorkspace(), {
      pollIntervalMs: 1000,
      maxConcurrentAgents: 1,
      maxTurns: 1,
      stallTimeoutSeconds: 300,
      maxRetryAttempts: 3,
      maxRetryDelayMs: 300_000,
      trackerConfig: {
        kind: "memory",
        project_slug: "test",
        active_states: ["Todo"],
        terminal_states: ["Done"],
      },
      promptTemplate: "Fix it",
    });

    orchestrator.start();
    // First tick: fetchCandidates throws → lastPollError set, time stamped.
    await vi.advanceTimersByTimeAsync(50);
    expect(orchestrator.getPollHealth().lastPollError).toBe("Linear project slug is required");
    expect(orchestrator.getPollHealth().lastPollAtMs).not.toBeNull();

    // Second tick (next interval): clean poll → lastPollError cleared.
    await vi.advanceTimersByTimeAsync(1000);
    expect(orchestrator.getPollHealth().lastPollError).toBeNull();

    await orchestrator.stop();
  });

  it("getPollHealth surfaces the empty-queue diagnostic after repeated empty polls (H1 regression)", async () => {
    vi.useFakeTimers();
    // No candidates + a slug the orchestrator will report as the suspect.
    const tracker = new MemoryTracker([]);
    const orchestrator = new Orchestrator(tracker, createMockAgent(), createMockWorkspace(), {
      pollIntervalMs: 1000,
      maxConcurrentAgents: 1,
      maxTurns: 1,
      stallTimeoutSeconds: 300,
      maxRetryAttempts: 3,
      maxRetryDelayMs: 300_000,
      trackerConfig: {
        kind: "memory",
        project_slug: "wrong-slug-xyz",
        active_states: ["Todo"],
        terminal_states: ["Done"],
      },
      promptTemplate: "Fix it",
    });

    orchestrator.start();
    // Polls at t=0,1000,2000,3000 → 4 consecutive empty polls (>= the
    // 3-poll threshold). Before the H1 fix lastPollError stayed null here.
    await vi.advanceTimersByTimeAsync(3500);

    const health = orchestrator.getPollHealth();
    expect(health.consecutiveEmptyPolls).toBeGreaterThanOrEqual(3);
    expect(health.lastPollError).toContain("wrong-slug-xyz");
    expect(health.lastPollError).toContain("Verify the slug");

    await orchestrator.stop();
  });
});

it("latches a terminal build outcome and keeps it in the snapshot after stop", async () => {
  const tracker = new MemoryTracker();
  const agent = createMockAgent();
  const workspace = createMockWorkspace();

  const orchestrator = new Orchestrator(tracker, agent, workspace, {
    pollIntervalMs: 1000,
    maxConcurrentAgents: 1,
    maxTurns: 1,
    stallTimeoutSeconds: 300,
    maxRetryAttempts: 3,
    maxRetryDelayMs: 300_000,
    trackerConfig: {
      kind: "memory",
      project_slug: "test",
      active_states: ["Todo"],
      terminal_states: ["Done"],
    },
    promptTemplate: "Fix it",
  });

  const outcome = {
    status: "completed" as const,
    completedAt: "2026-07-04T12:00:00.000Z",
    deploymentUrl: "https://app.example.com",
    ticketsCompleted: 3,
    ticketsFailed: 0,
    totalTickets: 3,
    message: null,
  };

  orchestrator.setTerminalBuildOutcome(outcome);
  expect(orchestrator.getSnapshot().terminalBuildOutcome).toEqual(outcome);

  orchestrator.start();
  await orchestrator.stop();

  expect(orchestrator.getSnapshot().terminalBuildOutcome).toEqual(outcome);
});

it("ignores repeated calls to setTerminalBuildOutcome (first value wins)", () => {
  const orchestrator = new Orchestrator(
    new MemoryTracker(),
    createMockAgent(),
    createMockWorkspace(),
    {
      pollIntervalMs: 1000,
      maxConcurrentAgents: 1,
      maxTurns: 1,
      stallTimeoutSeconds: 300,
      maxRetryAttempts: 3,
      maxRetryDelayMs: 300_000,
      trackerConfig: {
        kind: "memory",
        project_slug: "test",
        active_states: ["Todo"],
        terminal_states: ["Done"],
      },
      promptTemplate: "Fix it",
    },
  );

  const first = {
    status: "completed" as const,
    completedAt: "2026-07-04T12:00:00.000Z",
    deploymentUrl: "https://first.example.com",
    ticketsCompleted: 1,
    ticketsFailed: 0,
    totalTickets: 1,
    message: null,
  };
  const second = {
    status: "failed" as const,
    completedAt: "2026-07-04T12:01:00.000Z",
    deploymentUrl: null,
    ticketsCompleted: 0,
    ticketsFailed: 1,
    totalTickets: 1,
    message: "oops",
  };

  orchestrator.setTerminalBuildOutcome(first);
  orchestrator.setTerminalBuildOutcome(second);
  expect(orchestrator.getSnapshot().terminalBuildOutcome).toEqual(first);
});
describe("Orchestrator — build-progress refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeProgressOrchestrator(tracker: MemoryTracker, maxConcurrentAgents = 0): Orchestrator {
    return new Orchestrator(tracker, createMockAgent(), createMockWorkspace(), {
      pollIntervalMs: 1000,
      maxConcurrentAgents,
      maxTurns: 1,
      stallTimeoutSeconds: 300,
      maxRetryAttempts: 3,
      maxRetryDelayMs: 300_000,
      trackerConfig: {
        kind: "memory",
        project_slug: "test",
        active_states: ["Todo"],
        terminal_states: ["Done"],
      },
      promptTemplate: "Fix it",
    });
  }

  // Mutable view of the live state so a test can seed a prior progress reading.
  function mutableProgress(orchestrator: Orchestrator): {
    progress: { total: number; done: number } | null;
  } {
    return orchestrator.getState() as unknown as {
      progress: { total: number; done: number } | null;
    };
  }

  it("reads total and done straight from the tracker each poll (Linear is the source of truth)", async () => {
    vi.useFakeTimers();
    const tracker = new MemoryTracker([
      makeIssue({ id: "a", identifier: "MT-A", state: "Todo" }),
      makeIssue({ id: "b", identifier: "MT-B", state: "Todo" }),
      makeIssue({ id: "c", identifier: "MT-C", state: "Done" }),
      makeIssue({ id: "d", identifier: "MT-D", state: "Done" }),
      makeIssue({ id: "e", identifier: "MT-E", state: "Done" }),
    ]);
    const orchestrator = makeProgressOrchestrator(tracker);

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(50);

    // 5 issues total, 3 terminal (Done) — counted from the tracker, not the
    // in-memory completed set.
    expect(orchestrator.getState().progress).toEqual({ total: 5, done: 3 });
    await orchestrator.stop();
  });

  it("counts a ticket parked in a non-active/non-terminal state toward total but not done", async () => {
    vi.useFakeTimers();
    // "In Review" is neither active (Todo) nor terminal (Done): the old
    // active+terminal math dropped it from `total`, which is exactly what made
    // the live bar shrink and freeze. The full-scope count keeps it in `total`.
    const tracker = new MemoryTracker([
      makeIssue({ id: "a", identifier: "MT-A", state: "Todo" }),
      makeIssue({ id: "b", identifier: "MT-B", state: "In Review" }),
      makeIssue({ id: "c", identifier: "MT-C", state: "Done" }),
    ]);
    const orchestrator = makeProgressOrchestrator(tracker);

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(orchestrator.getState().progress).toEqual({ total: 3, done: 1 });
    await orchestrator.stop();
  });

  it("reflects the tracker's fresh count even when it is lower than before (no monotonic guard)", async () => {
    vi.useFakeTimers();
    // Guards the new invariant that made the stuck "6 of 16" bar impossible:
    // there is no local accumulator to freeze, so whatever the tracker reports
    // this poll wins, even if it's smaller (e.g. a ticket left the project) —
    // Linear is the source of truth. (The original freeze was the accumulator
    // vetoing a shrinking derived total; the full regression contract is the
    // throw-instead-of-[] behavior in linear.test.ts plus keep-prior-on-throw
    // below — this test alone only proves the missing guard.)
    const tracker = new MemoryTracker([
      makeIssue({ id: "a", identifier: "MT-A", state: "Todo" }),
      makeIssue({ id: "c", identifier: "MT-C", state: "Done" }),
    ]);
    const orchestrator = makeProgressOrchestrator(tracker);
    mutableProgress(orchestrator).progress = { total: 16, done: 6 };

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(orchestrator.getState().progress).toEqual({ total: 2, done: 1 });
    await orchestrator.stop();
  });

  it("keeps previous counts and still dispatches when the progress read throws", async () => {
    vi.useFakeTimers();
    const tracker = new MemoryTracker([makeIssue({ id: "a", identifier: "MT-A", state: "Todo" })]);
    tracker.fetchProgressCounts = async () => {
      throw new Error("Linear fetchProgressCounts failed");
    };
    const dispatched: string[] = [];
    const orchestrator = new Orchestrator(
      tracker,
      createMockAgent(),
      createMockWorkspace(),
      {
        pollIntervalMs: 1000,
        maxConcurrentAgents: 1,
        maxTurns: 1,
        stallTimeoutSeconds: 300,
        maxRetryAttempts: 3,
        maxRetryDelayMs: 300_000,
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
        promptTemplate: "Fix it",
      },
      {
        onDispatch: (issue) => dispatched.push(issue.id),
      },
    );
    mutableProgress(orchestrator).progress = { total: 4, done: 2 };

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(50);

    // The progress throw must not abort the cycle: dispatch happened, counts untouched.
    expect(dispatched).toContain("a");
    expect(orchestrator.getState().progress).toEqual({ total: 4, done: 2 });
    await orchestrator.stop();
  });

  it("seeds buildStartedAt on active build detection before any ticket dispatch", async () => {
    vi.useFakeTimers();
    // One active + one terminal ticket makes the tracker-reported build active,
    // but maxConcurrentAgents:0 prevents dispatch so we can observe the pre-
    // dispatch seeding of the build clock.
    const tracker = new MemoryTracker([
      makeIssue({ id: "a", identifier: "MT-A", state: "Todo" }),
      makeIssue({ id: "b", identifier: "MT-B", state: "Done" }),
    ]);
    const orchestrator = makeProgressOrchestrator(tracker);

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(50);

    const state = orchestrator.getState();
    expect(state.progress).toEqual({ total: 2, done: 1 });
    expect(state.buildStartedAt).toBeDefined();
    expect(state.buildStartedAt).toBeGreaterThan(0);
    expect(state.running.size).toBe(0);

    await orchestrator.stop();
  });

  it("does not clear buildStartedAt while a retry slot is still held", async () => {
    vi.useFakeTimers();
    const tracker = new MemoryTracker([
      makeIssue({ id: "a", identifier: "MT-A", state: "Done" }),
      makeIssue({ id: "b", identifier: "MT-B", state: "Done" }),
    ]);
    const orchestrator = makeProgressOrchestrator(tracker);

    orchestrator.start();
    // Seed state as if a prior build clock existed and a retry is in-flight.
    const state = orchestrator.getState();
    state.buildStartedAt = 1_000;
    state.retryAttempts.set("a", {
      issueId: "a",
      identifier: "MT-A",
      attempt: 2,
      dueAtMs: performance.now() + 60_000,
      delayType: "failure",
      error: null,
      timerId: setTimeout(() => {}, 60_000),
    } as never);

    await vi.advanceTimersByTimeAsync(50);

    // Tracker says all terminal, but a retry slot is still held — the build
    // clock must survive so Runtime stays continuous until the anvil is idle.
    expect(orchestrator.getState().buildStartedAt).toBe(1_000);

    // Once the retry clears and the anvil is fully idle, the next poll may
    // clear the build clock.
    state.retryAttempts.delete("a");
    orchestrator.triggerPoll();
    await vi.advanceTimersByTimeAsync(50);

    expect(orchestrator.getState().buildStartedAt).toBeUndefined();

    await orchestrator.stop();
  });
});

describe("Orchestrator — tracker-done reconciliation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a mid-flight ticket whose tracker reached Done as completed/success — never cancelled", async () => {
    vi.useFakeTimers();
    // The issue is already "Done" in the tracker while a worker is still
    // mid-flight in state.running — the exact race that used to persist a
    // successful ticket as `cancelled`.
    const issue = makeIssue({ id: "id-done", identifier: "MT-DONE", state: "Done" });
    const tracker = new MemoryTracker([issue]);
    // maxConcurrentAgents:0 ⇒ the tick only reconciles, never dispatches new work.
    const orchestrator = new Orchestrator(tracker, createMockAgent(), createMockWorkspace(), {
      pollIntervalMs: 100_000,
      maxConcurrentAgents: 0,
      maxTurns: 1,
      stallTimeoutSeconds: 300,
      maxRetryAttempts: 3,
      maxRetryDelayMs: 300_000,
      trackerConfig: {
        kind: "memory",
        project_slug: "test",
        active_states: ["Todo"],
        terminal_states: ["Done"],
        // done_states omitted ⇒ reconciler uses DEFAULT_DONE_STATES (incl. "Done").
      },
      promptTemplate: "Fix it",
    });

    orchestrator.start();

    // Seed a real running entry AFTER start() so it's present when the tick
    // reconciles (and not cleared by start()).
    const now = performance.now();
    orchestrator.getState().running.set("id-done", {
      issueId: "id-done",
      identifier: "MT-DONE",
      issue,
      startedAt: now - 5000,
      wallClockStartedAtMs: Date.now() - 5000,
      lastActivityAt: now,
      tokens: { input: 120, output: 60 },
      workspacePath: null,
      attempt: 1,
      abortController: new AbortController(),
      workerPromise: Promise.resolve(),
      sessionId: null,
      turnCount: 3,
      lastEvent: "",
      lastMessage: "",
      host: null,
      turnTimings: [],
    });

    await vi.advanceTimersByTimeAsync(50);

    const state = orchestrator.getState();
    // Reconciled out of flight and counted as completed (not killed/cancelled).
    expect(state.running.has("id-done")).toBe(false);
    expect(state.completed.has("id-done")).toBe(true);
    const outcome = state.ticketOutcomes.get("id-done");
    expect(outcome?.result.success).toBe(true);
    expect(outcome?.telemetry?.status).toBe("completed");
    // Real tokens/turns preserved — not the zeros a cancel would synthesize.
    expect(outcome?.result.turns).toBe(3);
    expect(outcome?.result.tokens).toEqual({ input: 120, output: 60 });

    await orchestrator.stop();
  });

  it("fires onComplete once with the success result on tracker-done (drives the Smith review hand-off)", async () => {
    vi.useFakeTimers();
    // Regression: the tracker-done path recorded telemetry but never invoked
    // onComplete, so the Smith lifecycle hand-off (markAwaitingReview → 48h bug
    // window + Linear In Review) never ran and features stuck at `executing`.
    const issue = makeIssue({ id: "id-done", identifier: "MT-DONE", state: "Done" });
    const tracker = new MemoryTracker([issue]);
    const onCompleteCalls: Array<{
      issueId: string;
      success: boolean;
      turns: number;
      tokens: { input: number; output: number };
      issueId2: string;
      willRetry: boolean | undefined;
    }> = [];
    const orchestrator = new Orchestrator(
      tracker,
      createMockAgent(),
      createMockWorkspace(),
      {
        pollIntervalMs: 100_000,
        maxConcurrentAgents: 0,
        maxTurns: 1,
        stallTimeoutSeconds: 300,
        maxRetryAttempts: 3,
        maxRetryDelayMs: 300_000,
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
        promptTemplate: "Fix it",
      },
      {
        onComplete: (id, result, completedIssue, willRetry) => {
          onCompleteCalls.push({
            issueId: id,
            success: result.success,
            turns: result.turns,
            tokens: result.tokens,
            issueId2: completedIssue.id,
            willRetry,
          });
        },
      },
    );

    orchestrator.start();
    const now = performance.now();
    orchestrator.getState().running.set("id-done", {
      issueId: "id-done",
      identifier: "MT-DONE",
      issue,
      startedAt: now - 5000,
      wallClockStartedAtMs: Date.now() - 5000,
      lastActivityAt: now,
      tokens: { input: 120, output: 60 },
      workspacePath: null,
      attempt: 1,
      abortController: new AbortController(),
      workerPromise: Promise.resolve(),
      sessionId: null,
      turnCount: 3,
      lastEvent: "",
      lastMessage: "",
      host: null,
      turnTimings: [],
    });

    await vi.advanceTimersByTimeAsync(50);

    // Exactly one onComplete, carrying the real success result + issue, willRetry=false.
    expect(onCompleteCalls).toEqual([
      {
        issueId: "id-done",
        success: true,
        turns: 3,
        tokens: { input: 120, output: 60 },
        issueId2: "id-done",
        willRetry: false,
      },
    ]);

    // Extra polls must not re-fire it (the entry is gone; single-fire is preserved).
    await vi.advanceTimersByTimeAsync(200_000);
    expect(onCompleteCalls).toHaveLength(1);

    await orchestrator.stop();
  });

  it("does NOT fire onComplete when a mid-flight ticket reaches a non-done terminal (cancel path)", async () => {
    vi.useFakeTimers();
    // A cancel-category terminal ("Cancelled") is killed-as-cancelled, NOT completed —
    // onComplete must stay silent so no review hand-off runs for cancelled work.
    const issue = makeIssue({ id: "id-cancel", identifier: "MT-CANCEL", state: "Cancelled" });
    const tracker = new MemoryTracker([issue]);
    const onComplete = vi.fn();
    const orchestrator = new Orchestrator(
      tracker,
      createMockAgent(),
      createMockWorkspace(),
      {
        pollIntervalMs: 100_000,
        maxConcurrentAgents: 0,
        maxTurns: 1,
        stallTimeoutSeconds: 300,
        maxRetryAttempts: 3,
        maxRetryDelayMs: 300_000,
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo"],
          terminal_states: ["Done", "Cancelled"],
          done_states: ["Done"],
        },
        promptTemplate: "Fix it",
      },
      { onComplete },
    );

    orchestrator.start();
    const now = performance.now();
    orchestrator.getState().running.set("id-cancel", {
      issueId: "id-cancel",
      identifier: "MT-CANCEL",
      issue,
      startedAt: now - 5000,
      wallClockStartedAtMs: Date.now() - 5000,
      lastActivityAt: now,
      tokens: { input: 0, output: 0 },
      workspacePath: null,
      attempt: 1,
      abortController: new AbortController(),
      workerPromise: Promise.resolve(),
      sessionId: null,
      turnCount: 0,
      lastEvent: "",
      lastMessage: "",
      host: null,
      turnTimings: [],
    });

    await vi.advanceTimersByTimeAsync(50);

    expect(orchestrator.getState().running.has("id-cancel")).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();

    await orchestrator.stop();
  });
});

describe("Orchestrator — completion is authoritative on the tracker (Linear)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const trackerConfig = {
    kind: "memory" as const,
    project_slug: "test",
    active_states: ["Todo"],
    terminal_states: ["Done"],
  };
  const config = {
    pollIntervalMs: 1000,
    maxConcurrentAgents: 1,
    maxTurns: 1,
    stallTimeoutSeconds: 300,
    maxRetryAttempts: 3,
    maxRetryDelayMs: 300_000,
    trackerConfig,
    promptTemplate: "Fix it",
  };

  it("does NOT complete and surfaces the slug diagnostic when the tracker has no tickets at all", async () => {
    vi.useFakeTimers();
    // Genuinely empty / unreachable project: no candidates AND total===0. This is
    // the real "bad slug / build never started" case — it must NOT be mistaken for
    // a completed build.
    const tracker = new MemoryTracker([]);
    let completeCalls = 0;
    let pollErrorMessage: string | null = null;
    const orchestrator = new Orchestrator(
      tracker,
      createMockAgent(),
      createMockWorkspace(),
      config,
      {
        onBuildComplete: () => {
          completeCalls++;
        },
        onPollError: (err: Error) => {
          pollErrorMessage = err.message;
        },
      },
    );

    orchestrator.start();
    // >3 polls so the empty-poll diagnostic trips.
    await vi.advanceTimersByTimeAsync(3500);

    expect(completeCalls).toBe(0);
    expect(pollErrorMessage).toMatch(/slug/i);
    // Tie the assertion to the real mechanism (the 3-consecutive-empty-poll
    // threshold), not just the message text.
    expect(orchestrator.getPollHealth().consecutiveEmptyPolls).toBeGreaterThanOrEqual(3);
    await orchestrator.stop();
  });
});

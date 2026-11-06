import { afterEach, describe, expect, it, vi } from "vitest";
import { inFlightCount, selectIssuesToDispatch } from "../../../src/orchestrator/dispatcher.js";
import { cancelAllRetries } from "../../../src/orchestrator/retry-queue.js";
import { buildStateSnapshot } from "../../../src/orchestrator/snapshot.js";
import { makeWorkerCallbacks } from "../../../src/orchestrator/turn-telemetry.js";
import {
  createInitialState,
  type OrchestratorConfig,
  type RunningEntry,
} from "../../../src/orchestrator/types.js";
import {
  AFTER_RESET_MS,
  LIMIT_CHECK_MS,
  limitActive,
} from "../../../src/orchestrator/usage-limits.js";
import {
  handleWorkerComplete,
  handleWorkerError,
  type WorkerOutcomeDeps,
} from "../../../src/orchestrator/worker-outcomes.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";
import type { WorkerResult } from "../../../src/worker/runner.js";

// 8:16 PM in New York, Nov 5 2026: the work account's spend limit, which said it resets at 11:40 PM.
const NOW = new Date("2026-11-06T01:16:00.000Z");
const RESET = Date.parse("2026-11-06T04:40:00.000Z");
const SPEND =
  "You've hit your individual spend limit · ask your admin to raise it at https://claude.ai/admin-settings/usage · your 5-hour limit resets 11:40pm (America/New_York) (API status 429)";
const FIVE_HOUR = "You've hit your 5-hour limit · resets 11:40pm (America/New_York)";

function makeDeps(
  maxRetryAttempts = 3,
): WorkerOutcomeDeps & { refetchAndDispatch: ReturnType<typeof vi.fn> } {
  const config: OrchestratorConfig = {
    pollIntervalMs: 1000,
    maxConcurrentAgents: 2,
    maxTurns: 50,
    stallTimeoutSeconds: 1800,
    maxRetryAttempts,
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
  return {
    state: createInitialState(),
    config,
    callbacks: { onComplete: vi.fn(), onError: vi.fn() },
    refetchAndDispatch: vi.fn(),
  };
}

function issue(id: string, state = "Todo"): NormalizedIssue {
  return {
    id,
    identifier: id.toUpperCase(),
    title: id,
    description: "",
    state,
    priority: 1,
    labels: [],
    blockedBy: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  } as NormalizedIssue;
}

function seedRunning(
  deps: WorkerOutcomeDeps,
  id: string,
  attempt = 1,
  limitKey = -1,
): RunningEntry {
  const entry = {
    issueId: id,
    identifier: id.toUpperCase(),
    issue: issue(id, "In Progress"),
    startedAt: performance.now() - 2000,
    wallClockStartedAtMs: Date.now() - 2000,
    lastActivityAt: performance.now(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    workspacePath: null,
    attempt,
    abortController: new AbortController(),
    workerPromise: Promise.resolve(),
    sessionId: null,
    turnCount: 1,
    lastEvent: "",
    lastMessage: "",
    activity: "",
    helpers: [],
    recent: [],
    host: null,
    turnTimings: [],
    limitKey,
  } as RunningEntry;
  deps.state.running.set(id, entry);
  return entry;
}

const failed = (id: string, error: string): WorkerResult => ({
  issueId: id,
  success: false,
  turns: 1,
  tokens: { input: 0, output: 0 },
  error,
});

describe("a card whose account hit a usage limit waits for the reset (Forge Desktop)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits until the reset without using a retry, and goes again by itself at the reset", () => {
    vi.useFakeTimers({ now: NOW });
    const deps = makeDeps();
    seedRunning(deps, "c1", 2);
    handleWorkerComplete(deps, "c1", failed("c1", SPEND), 2);

    const wait = deps.state.retryAttempts.get("c1");
    expect(wait?.attempt).toBe(2); // the same attempt: no retry used
    expect(wait?.limitKey).toBe(-1);
    expect(deps.callbacks.onComplete).toHaveBeenCalledWith(
      "c1",
      expect.anything(),
      expect.anything(),
      true,
    );
    expect(deps.state.usageLimits.get(-1)).toMatchObject({
      kind: "spend",
      reason: "spend limit, ask your admin to raise it",
      resetsAt: new Date(RESET).toISOString(),
    });

    // A minute before the reset: still waiting.
    vi.setSystemTime(RESET - 60_000);
    vi.advanceTimersByTime(RESET - 60_000 - NOW.getTime());
    expect(deps.refetchAndDispatch).not.toHaveBeenCalled();

    // At the reset (plus the margin): dispatched again with the same attempt.
    vi.setSystemTime(RESET + AFTER_RESET_MS);
    vi.advanceTimersByTime(60_000 + AFTER_RESET_MS);
    expect(deps.refetchAndDispatch).toHaveBeenCalledWith("c1", 2, true);
    expect(deps.state.retryAttempts.get("c1")?.limitKey).toBeUndefined();
    cancelAllRetries(deps.state);
  });

  it("never gives a card up: hitting the limit on its last attempt still waits", () => {
    vi.useFakeTimers({ now: NOW });
    const deps = makeDeps(3);
    seedRunning(deps, "c1", 3);
    handleWorkerComplete(deps, "c1", failed("c1", FIVE_HOUR), 3);
    expect(deps.state.retryAttempts.get("c1")).toMatchObject({ attempt: 3, limitKey: -1 });

    // Today's behaviour for any other failure on the last attempt: no retry is scheduled.
    const other = makeDeps(3);
    seedRunning(other, "c2", 3);
    handleWorkerComplete(other, "c2", failed("c2", "Tests failed"), 3);
    expect(other.state.retryAttempts.has("c2")).toBe(false);
    cancelAllRetries(deps.state);
  });

  it("a thrown limit error waits the same way", () => {
    vi.useFakeTimers({ now: NOW });
    const deps = makeDeps();
    seedRunning(deps, "c1", 1);
    handleWorkerError(deps, "c1", "C1", new Error(SPEND), 1);
    expect(deps.state.retryAttempts.get("c1")).toMatchObject({ attempt: 1, limitKey: -1 });
    cancelAllRetries(deps.state);
  });

  it("holds no agent slot, starts no other card of that account, and other accounts keep working", () => {
    vi.useFakeTimers({ now: NOW });
    const deps = makeDeps();
    seedRunning(deps, "c1");
    handleWorkerComplete(deps, "c1", failed("c1", SPEND), 1);
    expect(inFlightCount(deps.state)).toBe(0);

    // Role 0 (another account) builds "In Progress" cards; the project's own account does Todo.
    const roleOf = (s: string) => (s === "In Progress" ? 0 : -1);
    const limited = (i: NormalizedIssue) => limitActive(deps.state, roleOf(i.state));
    const picked = selectIssuesToDispatch(
      [issue("todo"), issue("build", "In Progress")],
      deps.state,
      {
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Done"],
        max_concurrent_agents: 2,
        limited,
      },
    );
    expect(picked.map((i) => i.id)).toEqual(["build"]);
    cancelAllRetries(deps.state);
  });

  it("the limit ends when a run of that account gets going, not on the limit message itself", () => {
    vi.useFakeTimers({ now: NOW });
    const deps = makeDeps();
    deps.state.usageLimits.set(-1, {
      key: -1,
      kind: "five_hour",
      reason: "5-hour limit",
      message: FIVE_HOUR,
      link: null,
      resetsAt: new Date(RESET).toISOString(),
      untilMs: RESET,
      sinceMs: NOW.getTime(),
    });
    const entry = seedRunning(deps, "c1");
    const cb = makeWorkerCallbacks(deps.state, {}, entry.abortController.signal);
    cb.onEvent("c1", { type: "text", content: FIVE_HOUR });
    expect(deps.state.usageLimits.size).toBe(1);
    cb.onEvent("c1", { type: "tool_use", tool: "Read", input: {} });
    expect(deps.state.usageLimits.size).toBe(0);
  });

  it("with no reset given it checks again later, and the app sees the cards as waiting for the limit", () => {
    vi.useFakeTimers({ now: NOW });
    const deps = makeDeps();
    seedRunning(deps, "c1");
    handleWorkerComplete(
      deps,
      "c1",
      failed("c1", "Quota exceeded. Check your plan and billing details."),
      1,
    );
    expect(deps.state.usageLimits.get(-1)?.untilMs).toBe(NOW.getTime() + LIMIT_CHECK_MS);

    const snap = buildStateSnapshot(deps.state);
    expect(snap.retrying[0]).toMatchObject({ identifier: "C1", waitingForLimit: true });
    expect(snap.limits?.[0]).toMatchObject({ role: -1, kind: "credits", resetsAt: null });
    cancelAllRetries(deps.state);
  });

  it("a later reset seen by another card pushes every waiting card to it", () => {
    vi.useFakeTimers({ now: NOW });
    const deps = makeDeps();
    seedRunning(deps, "c1");
    seedRunning(deps, "c2");
    handleWorkerComplete(deps, "c1", failed("c1", FIVE_HOUR), 1);
    const later = "You've hit your weekly limit · resets Nov 10, 3pm (America/New_York)";
    handleWorkerComplete(deps, "c2", failed("c2", later), 1);
    vi.setSystemTime(RESET + AFTER_RESET_MS);
    vi.advanceTimersByTime(RESET + AFTER_RESET_MS - NOW.getTime());
    expect(deps.refetchAndDispatch).not.toHaveBeenCalled();
    expect(deps.state.retryAttempts.get("c1")?.limitKey).toBe(-1);
    cancelAllRetries(deps.state);
  });
});

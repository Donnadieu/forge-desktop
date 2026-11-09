import { describe, expect, it } from "vitest";
import { makeWorkerCallbacks } from "../../../src/orchestrator/turn-telemetry.js";
import {
  createInitialState,
  type OrchestratorState,
  type RunningEntry,
} from "../../../src/orchestrator/types.js";

function makeEntry(signal: AbortSignal): RunningEntry {
  return {
    issueId: "a",
    identifier: "A",
    issue: {
      id: "a",
      identifier: "A",
      title: "t",
      description: "",
      state: "Todo",
      priority: 1,
      labels: [],
      blockedBy: [],
      createdAt: "",
      updatedAt: "",
    },
    startedAt: 0,
    wallClockStartedAtMs: Date.now(),
    lastActivityAt: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    workspacePath: null,
    attempt: 1,
    abortController: { signal } as never,
    workerPromise: Promise.resolve(),
    sessionId: null,
    turnCount: 0,
    lastEvent: "",
    lastMessage: "",
    activity: "Starting",
    helpers: [],
    recent: [],
    host: null,
    turnTimings: [],
  };
}

function makeState(entry: RunningEntry): OrchestratorState {
  const state = createInitialState();
  state.running.set(entry.issueId, entry);
  return state;
}

describe("makeWorkerCallbacks — onSessionReady (card sessions: FRG Open session)", () => {
  it("writes the session id and workspace path into the running entry as soon as they're known", () => {
    const controller = new AbortController();
    const entry = makeEntry(controller.signal);
    const state = makeState(entry);
    const cb = makeWorkerCallbacks(state, {}, controller.signal);

    expect(entry.sessionId).toBeNull();
    expect(entry.workspacePath).toBeNull();

    cb.onSessionReady?.("a", "sess-123", "/tmp/ws-a");

    expect(entry.sessionId).toBe("sess-123");
    expect(entry.workspacePath).toBe("/tmp/ws-a");
  });

  it("ignores a session-ready call for an issue whose entry has moved on (a killed worker's late callback)", () => {
    const controller = new AbortController();
    const entry = makeEntry(controller.signal);
    const state = makeState(entry);
    // A newer dispatch replaced the entry with a fresh abort signal before this worker's callback fired.
    const freshController = new AbortController();
    state.running.set(entry.issueId, {
      ...entry,
      abortController: { signal: freshController.signal } as never,
    });
    const cb = makeWorkerCallbacks(state, {}, controller.signal);

    cb.onSessionReady?.("a", "sess-stale", "/tmp/ws-stale");

    expect(state.running.get("a")?.sessionId).toBeNull();
  });

  it("does nothing for an issue with no running entry at all", () => {
    const controller = new AbortController();
    const state = createInitialState();
    const cb = makeWorkerCallbacks(state, {}, controller.signal);
    expect(() => cb.onSessionReady?.("missing", "sess", "/tmp/ws")).not.toThrow();
  });
});

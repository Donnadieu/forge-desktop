import { describe, expect, it } from "vitest";
import { buildStateSnapshot } from "../../../src/orchestrator/snapshot.js";
import {
  createInitialState,
  isBuildActive,
  type RunningEntry,
} from "../../../src/orchestrator/types.js";
import { handleWorkerComplete } from "../../../src/orchestrator/worker-outcomes.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";
import type { WorkerResult } from "../../../src/worker/runner.js";

function makeIssue(id: string, description = ""): NormalizedIssue {
  return {
    id,
    identifier: id.toUpperCase(),
    title: "x",
    description,
    state: "In Progress",
    priority: 1,
    labels: [],
    blockedBy: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

function makeRunningEntry(issueId: string, startedAt: number): RunningEntry {
  return {
    issueId,
    identifier: issueId.toUpperCase(),
    issue: makeIssue(issueId),
    startedAt,
    wallClockStartedAtMs: Date.now(),
    lastActivityAt: startedAt,
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
  };
}

const okResult: WorkerResult = {
  issueId: "x",
  success: true,
  turns: 1,
  tokens: { input: 0, output: 0 },
};

describe("buildStateSnapshot — running session fields", () => {
  it("carries the dispatched ticket body through to the snapshot", () => {
    const state = createInitialState();
    const entry = makeRunningEntry("a", 0);
    entry.issue = makeIssue("a", "## Goal\nWire up the thing.\n\nDetails here.");
    state.running.set("a", entry);

    const snap = buildStateSnapshot(state, 1_000);
    expect(snap.running[0].description).toBe("## Goal\nWire up the thing.\n\nDetails here.");
  });

  it("threads an empty body through as the empty string, not undefined", () => {
    const state = createInitialState();
    const entry = makeRunningEntry("a", 0);
    entry.issue = makeIssue("a");
    state.running.set("a", entry);

    const snap = buildStateSnapshot(state, 1_000);
    // The dashboard keys row clickability off desc.trim(), so an absent body
    // must arrive as "" rather than undefined.
    expect(snap.running[0].description).toBe("");
  });
});

describe("buildStateSnapshot wall-clock vs agent-seconds", () => {
  it("wall-clock is zero while no sessions are running", () => {
    const state = createInitialState();
    // A stale session origin from a prior build must be ignored while idle.
    state.sessionStartedAt = 0;

    const snap = buildStateSnapshot(state, 2_000);
    expect(snap.codexTotals.wallClockSeconds).toBe(0);
    expect(snap.codexTotals.secondsRunning).toBe(0);
  });

  it("finished workers no longer contribute to wall-clock once the anvil is idle", () => {
    const state = createInitialState();
    state.sessionStartedAt = 0;
    // Pre-seed sum-of-agent-seconds as if a worker had already finished.
    state.secondsRunning = 1;

    const snap = buildStateSnapshot(state, 2_000);
    expect(snap.codexTotals.wallClockSeconds).toBe(0);
    expect(snap.codexTotals.secondsRunning).toBeCloseTo(1, 6);
  });

  it("handleWorkerComplete keeps the session origin untouched while incrementing agent-seconds", () => {
    const state = createInitialState();
    state.sessionStartedAt = performance.now() - 5_000;
    const sessionStartBefore = state.sessionStartedAt;

    const entry = makeRunningEntry("a", performance.now() - 1_000);
    state.running.set("a", entry);
    handleWorkerComplete(
      {
        state,
        config: {
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
            active_states: ["In Progress"],
            terminal_states: ["Done"],
          },
          promptTemplate: "",
        },
        callbacks: {},
        refetchAndDispatch: () => {},
      },
      "a",
      okResult,
      1,
    );
    expect(state.secondsRunning).toBeGreaterThanOrEqual(1);
    expect(state.running.has("a")).toBe(false);
    // The completion path must not move the session origin — the origin is
    // owned solely by the idle→active dispatch transition. If completion reset
    // it, Runtime would jump the moment a worker finished.
    expect(state.sessionStartedAt).toBe(sessionStartBefore);
  });

  it("snapshot adds finished agent-seconds (state.secondsRunning) and in-flight agent-seconds together", () => {
    const state = createInitialState();
    // Session opened at t=0 (as dispatch would stamp it).
    state.sessionStartedAt = 0;
    // Pre-seed as if 5 agent-seconds had already finished.
    state.secondsRunning = 5;
    // One in-flight worker started 2s before the snapshot.
    state.running.set("a", makeRunningEntry("a", 0));

    const snap = buildStateSnapshot(state, 2_000);

    expect(snap.codexTotals.wallClockSeconds).toBeCloseTo(2, 6);
    expect(snap.codexTotals.secondsRunning).toBeCloseTo(7, 6);
  });

  it("K=3 concurrent workers running for T seconds each → wall-clock ≈ T, agent-seconds ≈ K*T (regression case)", () => {
    const state = createInitialState();
    // The session opened when the first of the three was dispatched, at t=0.
    state.sessionStartedAt = 0;

    // All three workers started at t=0, snapshot at t=1000ms while still running.
    state.running.set("a", makeRunningEntry("a", 0));
    state.running.set("b", makeRunningEntry("b", 0));
    state.running.set("c", makeRunningEntry("c", 0));

    const snap = buildStateSnapshot(state, 1_000);

    expect(snap.codexTotals.wallClockSeconds).toBeCloseTo(1, 6);
    // 3 workers × 1s in-flight = 3 agent-seconds. Pre-fix this same value
    // would have been displayed as Runtime — that is the bug.
    expect(snap.codexTotals.secondsRunning).toBeCloseTo(3, 6);
    expect(snap.codexTotals.secondsRunning).not.toBeCloseTo(snap.codexTotals.wallClockSeconds, 0);
  });

  it("wall-clock reflects the current session origin, not the global orchestrator start time", () => {
    const state = createInitialState();
    // The session origin dispatch stamped for this feature (1s before the
    // snapshot). The orchestrator's own uptime (~2s) must not leak in.
    state.sessionStartedAt = 1_000;
    state.running.set("feature-a", makeRunningEntry("feature-a", 1_000));

    const snap = buildStateSnapshot(state, 2_000);

    // Runtime is scoped to the feature session (~1s), not the orchestrator
    // uptime (~2s), so it does not carry over a previous Forge build's time.
    expect(snap.codexTotals.wallClockSeconds).toBeCloseTo(1, 6);
    expect(snap.codexTotals.secondsRunning).toBeCloseTo(1, 6);
  });

  it("a new feature run after the previous one finishes starts its own runtime clock", () => {
    const state = createInitialState();
    // Stale origin from the previous build; idle so it is ignored.
    state.sessionStartedAt = 0;
    // Previous Forge build already contributed agent-seconds.
    state.secondsRunning = 10;

    // No running sessions yet: Runtime is idle.
    const idleSnap = buildStateSnapshot(state, 3_000);
    expect(idleSnap.codexTotals.wallClockSeconds).toBe(0);

    // A new Smith feature starts at t=4s; dispatch re-stamps the session origin.
    state.sessionStartedAt = 4_000;
    state.running.set("feature-b", makeRunningEntry("feature-b", 4_000));
    const activeSnap = buildStateSnapshot(state, 5_000);

    // Runtime starts near zero for the new feature, independent of prior build.
    expect(activeSnap.codexTotals.wallClockSeconds).toBeCloseTo(1, 6);
    // Agent-seconds still accumulates across finished + in-flight work.
    expect(activeSnap.codexTotals.secondsRunning).toBeCloseTo(11, 6);
  });

  it("Runtime does not step backward when the earliest running session finishes (H1 regression)", () => {
    const state = createInitialState();
    // Session opened at t=0 by the first worker's dispatch.
    state.sessionStartedAt = 0;
    state.running.set("older", makeRunningEntry("older", 0));
    state.running.set("newer", makeRunningEntry("newer", 500));

    const before = buildStateSnapshot(state, 1_500).codexTotals.wallClockSeconds;
    expect(before).toBeCloseTo(1.5, 6);

    // The earliest worker completes while the build stays active. A derive-from-
    // earliest-entry model would drop Runtime to ~1.0s here; the session origin
    // keeps it monotonic.
    state.running.delete("older");
    const after = buildStateSnapshot(state, 1_500).codexTotals.wallClockSeconds;
    expect(after).toBeCloseTo(1.5, 6);
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("a just-dispatched session reads exactly 0 at the origin boundary", () => {
    const state = createInitialState();
    // Origin equals the snapshot time: the Math.max(0, …) clamp holds it at 0
    // rather than emitting a negative/NaN duration.
    state.sessionStartedAt = 2_000;
    state.running.set("a", makeRunningEntry("a", 2_000));

    const snap = buildStateSnapshot(state, 2_000);
    expect(snap.codexTotals.wallClockSeconds).toBe(0);
  });

  it("Runtime keeps ticking during retry backoff (running empty, a retry still pending)", () => {
    const state = createInitialState();
    state.sessionStartedAt = 0;
    // A worker failed retryably: no running entry, but its slot is held in
    // retryAttempts during the backoff. The anvil is not idle, so Runtime must
    // keep counting rather than blink to 0.
    state.retryAttempts.set("a", {
      issueId: "a",
      identifier: "A",
      attempt: 2,
      dueAtMs: 12_000,
      delayType: "failure",
      error: null,
      timerId: setTimeout(() => {}, 60_000),
    } as never);

    const snap = buildStateSnapshot(state, 2_000);
    expect(snap.codexTotals.wallClockSeconds).toBeCloseTo(2, 6);
  });

  it("multi-ticket Forge build keeps a continuous Runtime clock even when the anvil briefly idles", () => {
    const state = createInitialState();
    state.sessionStartedAt = 5_000;
    // The first ticket of an initial build started the build clock at t=0.
    state.buildStartedAt = 0;
    // One ticket is already terminal, two remain, so the build is still active.
    state.progress = { total: 3, done: 1 };
    // No workers are currently running (gap between two sequential tickets).
    // Runtime must still tick from buildStartedAt, not fall to 0.
    const midGap = buildStateSnapshot(state, 4_000);
    expect(midGap.codexTotals.wallClockSeconds).toBeCloseTo(4, 6);

    // Once the build is fully terminal, Runtime reads 0 even though there are no
    // in-flight workers. (The build clock itself is cleared by the poll cycle;
    // the snapshot is read-only.)
    state.progress = { total: 3, done: 3 };
    const afterBuild = buildStateSnapshot(state, 6_000);
    expect(afterBuild.codexTotals.wallClockSeconds).toBe(0);
  });

  it("uses the build clock while workers are in-flight in an active build", () => {
    const state = createInitialState();
    state.sessionStartedAt = 5_000;
    state.buildStartedAt = 0;
    state.progress = { total: 3, done: 1 };
    state.running.set("a", makeRunningEntry("a", 0));

    const snap = buildStateSnapshot(state, 4_000);

    expect(snap.codexTotals.wallClockSeconds).toBeCloseTo(4, 6);
  });

  it("keeps ticking from the build clock during retry backoff in an active build", () => {
    const state = createInitialState();
    state.sessionStartedAt = 5_000;
    state.buildStartedAt = 0;
    state.progress = { total: 3, done: 1 };
    state.retryAttempts.set("a", {
      issueId: "a",
      identifier: "A",
      attempt: 2,
      dueAtMs: 12_000,
      delayType: "failure",
      error: null,
      timerId: setTimeout(() => {}, 60_000),
    } as never);

    const snap = buildStateSnapshot(state, 4_000);

    expect(snap.codexTotals.wallClockSeconds).toBeCloseTo(4, 6);
  });

  it("isBuildActive is true only while the tracker reports unfinished tickets", () => {
    expect(isBuildActive(null)).toBe(false);
    expect(isBuildActive({ total: 0, done: 0 })).toBe(false);
    expect(isBuildActive({ total: 3, done: 3 })).toBe(false);
    expect(isBuildActive({ total: 3, done: 1 })).toBe(true);
    expect(isBuildActive({ total: 3, done: 4 })).toBe(false);
  });
});

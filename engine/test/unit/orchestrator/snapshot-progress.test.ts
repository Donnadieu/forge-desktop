import { describe, expect, it } from "vitest";
import { buildStateSnapshot } from "../../../src/orchestrator/snapshot.js";
import { createInitialState } from "../../../src/orchestrator/types.js";

describe("buildStateSnapshot — build progress", () => {
  it("is null until the first poll populates counts", () => {
    const state = createInitialState();
    expect(buildStateSnapshot(state).progress).toBeNull();
  });

  it("computes percent = done/total rounded, clamped 0–100", () => {
    const state = createInitialState();
    state.progress = { total: 19, done: 8 };
    // 8/19 = 42.1% → 42
    expect(buildStateSnapshot(state).progress).toEqual({ total: 19, done: 8, percent: 42 });
  });

  it("reports 100% when every ticket is terminal", () => {
    const state = createInitialState();
    state.progress = { total: 12, done: 12 };
    expect(buildStateSnapshot(state).progress).toEqual({ total: 12, done: 12, percent: 100 });
  });

  it("treats a zero total as no-progress (null), never dividing by zero", () => {
    const state = createInitialState();
    state.progress = { total: 0, done: 0 };
    expect(buildStateSnapshot(state).progress).toBeNull();
  });

  it("is restart-safe: done is taken from the cached tracker count, not the in-memory completed set", () => {
    // Simulate a worker restart — `completed` is empty (it resets per process),
    // but the tracker-sourced progress still reflects the 5 already-Done tickets.
    const state = createInitialState();
    expect(state.completed.size).toBe(0);
    state.progress = { total: 10, done: 5 };
    expect(buildStateSnapshot(state).progress).toEqual({ total: 10, done: 5, percent: 50 });
  });
});

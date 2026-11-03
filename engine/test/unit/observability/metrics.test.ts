import { beforeEach, describe, expect, it } from "vitest";
import { MetricsCollector } from "../../../src/observability/metrics.js";

describe("MetricsCollector", () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector();
  });

  it("starts with empty state", () => {
    const snapshot = metrics.getSnapshot();
    expect(snapshot.activeWorkers).toBe(0);
    expect(snapshot.totalTokens).toEqual({ input: 0, output: 0 });
    expect(snapshot.sessionCount).toBe(0);
  });

  it("records and accumulates tokens per session", () => {
    metrics.recordTokens("s1", 100, 50);
    metrics.recordTokens("s1", 200, 100);
    metrics.recordTokens("s2", 500, 200);

    const snapshot = metrics.getSnapshot();
    expect(snapshot.tokensBySession.get("s1")).toEqual({ input: 300, output: 150 });
    expect(snapshot.tokensBySession.get("s2")).toEqual({ input: 500, output: 200 });
    expect(snapshot.totalTokens).toEqual({ input: 800, output: 350 });
    expect(snapshot.sessionCount).toBe(2);
  });

  it("records session durations", () => {
    metrics.recordSessionDuration("s1", 5000);
    metrics.recordSessionDuration("s2", 12000);

    const snapshot = metrics.getSnapshot();
    expect(snapshot.sessionDurations.get("s1")).toBe(5000);
    expect(snapshot.sessionDurations.get("s2")).toBe(12000);
  });

  it("increments retry counts", () => {
    metrics.incrementRetryCount("issue-1");
    metrics.incrementRetryCount("issue-1");
    metrics.incrementRetryCount("issue-2");

    const snapshot = metrics.getSnapshot();
    expect(snapshot.retryCounts.get("issue-1")).toBe(2);
    expect(snapshot.retryCounts.get("issue-2")).toBe(1);
  });

  it("tracks active worker count", () => {
    metrics.setActiveWorkers(3);
    expect(metrics.getSnapshot().activeWorkers).toBe(3);

    metrics.setActiveWorkers(1);
    expect(metrics.getSnapshot().activeWorkers).toBe(1);
  });

  it("reset() clears all state", () => {
    metrics.recordTokens("s1", 100, 50);
    metrics.recordSessionDuration("s1", 5000);
    metrics.incrementRetryCount("issue-1");
    metrics.setActiveWorkers(3);

    metrics.reset();

    const snapshot = metrics.getSnapshot();
    expect(snapshot.activeWorkers).toBe(0);
    expect(snapshot.totalTokens).toEqual({ input: 0, output: 0 });
    expect(snapshot.sessionCount).toBe(0);
    expect(snapshot.retryCounts.size).toBe(0);
    expect(snapshot.sessionDurations.size).toBe(0);
  });

  it("getSnapshot() returns copies, not references", () => {
    metrics.recordTokens("s1", 100, 50);
    const snap1 = metrics.getSnapshot();

    metrics.recordTokens("s1", 200, 100);
    const snap2 = metrics.getSnapshot();

    // snap1 should not be affected by later changes
    expect(snap1.tokensBySession.get("s1")).toEqual({ input: 100, output: 50 });
    expect(snap2.tokensBySession.get("s1")).toEqual({ input: 300, output: 150 });
  });
});

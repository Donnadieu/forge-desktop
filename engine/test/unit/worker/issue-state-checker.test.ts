import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import type { NormalizedIssue, TrackerAdapter } from "../../../src/tracker/types.js";
import { IssueStateChecker } from "../../../src/worker/issue-state-checker.js";

const testIssue: NormalizedIssue = {
  id: "issue-1",
  identifier: "MT-42",
  title: "Test issue",
  description: "Test description",
  state: "In Progress",
  priority: 1,
  labels: [],
  blockedBy: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

interface LogEntry {
  level: string;
  msg: string;
  obj: Record<string, unknown>;
}

function createMockLogger(): { logger: Logger; logs: LogEntry[] } {
  const logs: LogEntry[] = [];
  const push = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    logs.push({ level, msg, obj });
  };
  const logger: Logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    child: () => logger,
  } as unknown as Logger;
  return { logger, logs };
}

function createFailingTracker(failures: number): TrackerAdapter {
  let calls = 0;
  return {
    kind: "memory",
    fetchIssues: async () => [],
    fetchIssueStatesByIds: async () => {
      calls++;
      if (calls <= failures) {
        throw new Error("tracker error");
      }
      return new Map([[testIssue.id, "Done"]]);
    },
  } as unknown as TrackerAdapter;
}

function createThrowingTracker(): TrackerAdapter {
  return {
    kind: "memory",
    fetchIssues: async () => [],
    fetchIssueStatesByIds: async () => {
      throw new Error("persistent tracker error");
    },
  } as unknown as TrackerAdapter;
}

describe("IssueStateChecker", () => {
  it("returns break when issue is no longer active", async () => {
    const checker = new IssueStateChecker(3);
    const { logger } = createMockLogger();
    const tracker: TrackerAdapter = {
      kind: "memory",
      fetchIssues: async () => [],
      fetchIssueStatesByIds: async () => new Map([[testIssue.id, "Done"]]),
    } as unknown as TrackerAdapter;

    const result = await checker.decide(tracker, testIssue, ["In Progress"], logger, {
      turns: 1,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      workspacePath: "/tmp/ws",
      preserveWorkspace: false,
    });

    expect(result).toBe("break");
  });

  it("returns null when issue is still active", async () => {
    const checker = new IssueStateChecker(3);
    const { logger } = createMockLogger();
    const tracker: TrackerAdapter = {
      kind: "memory",
      fetchIssues: async () => [],
      fetchIssueStatesByIds: async () => new Map([[testIssue.id, "In Progress"]]),
    } as unknown as TrackerAdapter;

    const result = await checker.decide(tracker, testIssue, ["In Progress"], logger, {
      turns: 1,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      workspacePath: "/tmp/ws",
      preserveWorkspace: false,
    });

    expect(result).toBeNull();
  });

  it("logs a warning and continues on transient tracker failure", async () => {
    const checker = new IssueStateChecker(3);
    const { logger, logs } = createMockLogger();
    const tracker = createFailingTracker(1);

    const result = await checker.decide(tracker, testIssue, ["In Progress"], logger, {
      turns: 1,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      workspacePath: "/tmp/ws",
      preserveWorkspace: false,
    });

    expect(result).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("warn");
    expect(logs[0].obj).toMatchObject({
      issueId: testIssue.id,
      identifier: testIssue.identifier,
      error: "tracker error",
      consecutiveFailures: 1,
      maxRetries: 3,
    });
  });

  it("resets the failure counter after a successful check", async () => {
    const checker = new IssueStateChecker(3);
    const { logger } = createMockLogger();
    const tracker = createFailingTracker(2);

    // Two failures, then success on the third call.
    const first = await checker.decide(tracker, testIssue, ["In Progress"], logger, {
      turns: 1,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      workspacePath: "/tmp/ws",
      preserveWorkspace: false,
    });
    expect(first).toBeNull();

    const second = await checker.decide(tracker, testIssue, ["In Progress"], logger, {
      turns: 2,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      workspacePath: "/tmp/ws",
      preserveWorkspace: false,
    });
    expect(second).toBeNull();

    // Third call succeeds and returns break (Done).
    const third = await checker.decide(tracker, testIssue, ["In Progress"], logger, {
      turns: 3,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      workspacePath: "/tmp/ws",
      preserveWorkspace: false,
    });
    expect(third).toBe("break");
  });

  it("returns an abort result after max consecutive failures", async () => {
    const checker = new IssueStateChecker(2);
    const { logger, logs } = createMockLogger();
    const tracker = createThrowingTracker();

    const first = await checker.decide(tracker, testIssue, ["In Progress"], logger, {
      turns: 1,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      workspacePath: "/tmp/ws",
      preserveWorkspace: false,
    });
    expect(first).toBeNull();

    const second = await checker.decide(tracker, testIssue, ["In Progress"], logger, {
      turns: 2,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      workspacePath: "/tmp/ws",
      preserveWorkspace: false,
    });

    expect(second).toEqual({
      issueId: testIssue.id,
      turns: 2,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      success: false,
      error: expect.stringContaining("persistent tracker error"),
      workspacePath: "/tmp/ws",
      preserveWorkspace: false,
    });

    const errorLogs = logs.filter((l) => l.level === "error");
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0].obj.consecutiveFailures).toBe(2);
  });
});

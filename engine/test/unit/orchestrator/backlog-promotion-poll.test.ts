import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BacklogPromotionConfig } from "../../../src/orchestrator/backlog-promotion.js";
import { Orchestrator } from "../../../src/orchestrator/orchestrator.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";
import { createMockAgent, createTestIssue } from "../../support/fixtures.js";
import { grantedWorkspaceLock } from "../../support/workspace-lock.js";

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

/** Boot an orchestrator over the app's pipeline and run one poll. */
async function bootAndPoll(
  tracker: MemoryTracker,
  backlogPromotion?: BacklogPromotionConfig,
): Promise<string[]> {
  const dispatched: string[] = [];
  const orchestrator = new Orchestrator(
    tracker,
    createMockAgent(),
    createMockWorkspace(),
    {
      pollIntervalMs: 60_000,
      maxConcurrentAgents: 5,
      maxTurns: 1,
      stallTimeoutSeconds: 300,
      maxRetryAttempts: 3,
      maxRetryDelayMs: 300_000,
      trackerConfig: {
        kind: "memory",
        project_slug: "test",
        active_states: ["Triage", "Todo", "In Progress"],
        terminal_states: ["Done"],
      },
      promptTemplate: "Fix {{ issue.identifier }}",
      backlogPromotion,
    },
    { onDispatch: (issue) => dispatched.push(issue.id) },
  );
  orchestrator.start();
  await vi.advanceTimersByTimeAsync(50);
  await orchestrator.stop();
  return dispatched;
}

function backlogCards(): MemoryTracker {
  return new MemoryTracker([
    createTestIssue({ id: "ready", state: "Backlog", labels: ["ready-for-execution"] }),
    createTestIssue({ id: "new", state: "Backlog", labels: [] }),
  ]);
}

describe("orchestrator poll — backlog promotion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves Backlog alone when promotion is not configured", async () => {
    const tracker = backlogCards();

    expect(await bootAndPoll(tracker)).toEqual([]);
    expect(tracker.getIssue("ready")?.state).toBe("Backlog");
    expect(tracker.getIssue("new")?.state).toBe("Backlog");
  });

  it("moves Backlog cards out and dispatches them in the same poll", async () => {
    const tracker = backlogCards();

    const dispatched = await bootAndPoll(tracker, {
      backlogToTriage: true,
      readyToTodo: true,
      readyLabel: "ready-for-execution",
      maxInTriage: 2,
      intervalMs: 300_000,
    });

    expect(tracker.getIssue("ready")?.state).toBe("Todo");
    expect(tracker.getIssue("new")?.state).toBe("Triage");
    expect(dispatched.sort()).toEqual(["new", "ready"]);
  });
});

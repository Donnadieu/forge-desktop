import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AgentEvent, SessionHandle } from "../../../src/agent/types.js";
import { Orchestrator } from "../../../src/orchestrator/orchestrator.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";
import { grantedWorkspaceLock } from "../../support/workspace-lock.js";

// FRG-4086: a stall kill used to drop the issue from `running` before the
// killed worker exited, so the retry started a second session in the same
// workspace; the killed worker's late completion then deleted the successor's
// entry and the next poll started a third. One live session per issue, always.

const issue: NormalizedIssue = {
  id: "id-1",
  identifier: "MT-1",
  title: "t",
  description: "",
  state: "Todo",
  priority: 1,
  labels: [],
  blockedBy: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

/** An agent that emits one event, then goes quiet (a long tool call) until killed. */
function quietAgent(): AgentAdapter & { starts: number } {
  const agent = {
    name: "quiet",
    persistentSession: false,
    starts: 0,
    async startSession(): Promise<SessionHandle> {
      agent.starts++;
      return { id: `s-${agent.starts}`, abortController: new AbortController() };
    },
    async *streamEvents(handle: SessionHandle): AsyncIterable<AgentEvent> {
      yield { type: "text", content: "working" };
      const { signal } = handle.abortController;
      if (!signal.aborted) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      }
      // Like the Claude CLI: a killed process that already streamed reports done.
      yield { type: "done", success: true };
    },
    async stopSession() {},
  };
  return agent;
}

/** A workspace whose `after_run` hook blocks until the test releases it. */
function slowTeardownWorkspace() {
  const live = { now: 0, max: 0 };
  const releases: Array<() => void> = [];
  const workspace = {
    ensureWorkspace: vi.fn().mockResolvedValue("/tmp/ws/MT-1"),
    acquireLock: grantedWorkspaceLock().acquireLock,
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    writeMcpConfig: vi.fn().mockResolvedValue("/tmp/ws/MT-1/.forge/mcp.json"),
    toSafeId: vi.fn((id: string) => id),
    runHook: vi.fn(async (name: string) => {
      if (name === "before_run") {
        live.now++;
        live.max = Math.max(live.max, live.now);
      } else if (name === "after_run") {
        await new Promise<void>((resolve) => releases.push(resolve));
        live.now--;
      }
    }),
  } as unknown as WorkspaceManager;
  return { workspace, live, releases };
}

function captureLogger() {
  const info = vi.fn();
  const logger = {
    info,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  return { logger, info };
}

/** An orchestrator whose stall detector kills a quiet worker after ~5s. */
function stallingOrchestrator(
  agent: AgentAdapter,
  workspace: WorkspaceManager,
  logger: ReturnType<typeof captureLogger>["logger"],
): Orchestrator {
  return new Orchestrator(new MemoryTracker([issue]), agent, workspace, {
    pollIntervalMs: 1_000,
    maxConcurrentAgents: 5,
    maxTurns: 1,
    stallTimeoutSeconds: 5,
    maxRetryAttempts: 5,
    maxRetryDelayMs: 60_000,
    retryBaseDelayMs: 1_000,
    trackerConfig: {
      kind: "memory",
      project_slug: "test",
      active_states: ["Todo"],
      terminal_states: ["Done"],
    },
    promptTemplate: "Fix {{ issue.identifier }}",
    logger: logger as never,
  });
}

describe("one live session per issue (FRG-4086)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a stall retry waits for the killed worker to exit instead of starting a second session", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    });
    const agent = quietAgent();
    const { workspace, live, releases } = slowTeardownWorkspace();
    const { logger, info } = captureLogger();
    const orchestrator = stallingOrchestrator(agent, workspace, logger);

    orchestrator.start();
    // Stall kill at ~6s, then retries and polls keep firing while the killed
    // worker's teardown hangs.
    await vi.advanceTimersByTimeAsync(30_000);

    expect(agent.starts).toBe(1);
    expect(live.max).toBe(1);
    const state = orchestrator.getState();
    expect(state.running.has(issue.id)).toBe(false);
    expect(state.settling.has(issue.id)).toBe(true);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: issue.id, identifier: "MT-1", reason: "settling" }),
      "dispatch suppressed; issue already has a live session",
    );

    // The killed worker finally exits; only now does the retry start a session.
    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(state.settling.has(issue.id)).toBe(false);
    expect(agent.starts).toBe(2);
    expect(state.running.get(issue.id)?.attempt).toBe(2);
    expect(live.max).toBe(1);

    // stop() drains without aborting live workers: end B, release teardowns.
    state.running.get(issue.id)?.abortController.abort();
    const drain = setInterval(() => {
      for (const release of releases.splice(0)) release();
    }, 10);
    const stopped = orchestrator.stop();
    await vi.advanceTimersByTimeAsync(100);
    await stopped;
    clearInterval(drain);
    expect(live.max).toBe(1);
  });

  it("stop() waits for a killed worker that is still exiting", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    });
    const agent = quietAgent();
    const { workspace, releases } = slowTeardownWorkspace();
    const { logger } = captureLogger();
    const orchestrator = stallingOrchestrator(agent, workspace, logger);

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(30_000);
    const state = orchestrator.getState();
    expect(state.settling.has(issue.id)).toBe(true);

    let stopped = false;
    const stopping = orchestrator.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped).toBe(false);

    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(100);
    await stopping;
    expect(state.settling.size).toBe(0);
    // The pending retry was cancelled, not started into the workspace.
    expect(agent.starts).toBe(1);
  });
});

import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentAdapter, AgentEvent, SessionHandle } from "../../../src/agent/types.js";
import { Orchestrator } from "../../../src/orchestrator/orchestrator.js";
import type { OrchestratorCallbacks } from "../../../src/orchestrator/types.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";
import { createTestIssue } from "../../support/fixtures.js";
import { grantedWorkspaceLock } from "../../support/workspace-lock.js";

/**
 * An agent whose single turn blocks until either its session is aborted (the
 * adapter kill path) or the test calls `finish()` (the session ending on its
 * own).
 */
function createBlockingAgent() {
  const sessions: SessionHandle[] = [];
  let finish!: () => void;
  const finished = new Promise<void>((res) => {
    finish = res;
  });
  const agent: AgentAdapter = {
    name: "blocking",
    persistentSession: false,
    async startSession() {
      const handle = { id: `s-${sessions.length + 1}`, abortController: new AbortController() };
      sessions.push(handle);
      return handle;
    },
    async *streamEvents(handle): AsyncIterable<AgentEvent> {
      const { signal } = handle.abortController;
      const aborted = new Promise<void>((res) => {
        if (signal.aborted) res();
        signal.addEventListener("abort", () => res(), { once: true });
      });
      await Promise.race([aborted, finished]);
      yield { type: "done", success: !signal.aborted };
    },
    async stopSession() {},
  };
  return { agent, sessions, finish };
}

function createWorkspace(): WorkspaceManager {
  return {
    ensureWorkspace: vi.fn().mockResolvedValue("/tmp/ws"),
    acquireLock: grantedWorkspaceLock().acquireLock,
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    runHook: vi.fn().mockResolvedValue(undefined),
    writeMcpConfig: vi.fn().mockResolvedValue("/tmp/ws/.forge/mcp.json"),
    toSafeId: vi.fn((id: string) => id),
  } as unknown as WorkspaceManager;
}

const ISSUE_IDS = ["id-1", "id-2"];

async function startWithRunningWorkers(callbacks: OrchestratorCallbacks = {}) {
  const blocking = createBlockingAgent();
  const workspace = createWorkspace();
  const issues = ISSUE_IDS.map((id, i) => createTestIssue({ id, identifier: `MT-${i + 1}` }));
  const orchestrator = new Orchestrator(
    new MemoryTracker(issues),
    blocking.agent,
    workspace,
    {
      pollIntervalMs: 100_000,
      maxConcurrentAgents: ISSUE_IDS.length,
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
    callbacks,
  );
  orchestrator.start();
  await vi.waitFor(() => expect(blocking.sessions).toHaveLength(ISSUE_IDS.length));
  const workerSignals = ISSUE_IDS.map(
    (id) => orchestrator.getState().running.get(id)?.abortController.signal,
  );
  return { orchestrator, workspace, workerSignals, ...blocking };
}

describe("Orchestrator.stop", () => {
  it("{ abort: true } aborts every running session, records it cancelled, and neither retries nor completes", async () => {
    const onComplete = vi.fn();
    const { orchestrator, sessions, workerSignals } = await startWithRunningWorkers({
      onComplete,
    });
    expect(workerSignals.map((s) => s?.aborted)).toEqual([false, false]);

    await orchestrator.stop({ abort: true });

    expect(workerSignals.map((s) => s?.aborted)).toEqual([true, true]);
    expect(sessions.map((s) => s.abortController.signal.aborted)).toEqual([true, true]);
    const state = orchestrator.getState();
    expect(state.retryAttempts.size).toBe(0);
    for (const id of ISSUE_IDS) {
      expect(state.ticketOutcomes.get(id)?.telemetry?.status).toBe("cancelled");
    }
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("{ abort: true } holds the event loop and resolves only after the killed workers have exited (after_run done)", async () => {
    const { orchestrator, workspace } = await startWithRunningWorkers();
    let releaseAfterRun!: () => void;
    const afterRunGate = new Promise<void>((res) => {
      releaseAfterRun = res;
    });
    vi.mocked(workspace.runHook).mockImplementation(async (name: string) => {
      if (name === "after_run") await afterRunGate;
    });

    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    onTestFinished(() => {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    });

    let stopped = false;
    const stopping = orchestrator.stop({ abort: true }).then(() => {
      stopped = true;
    });
    // The drain holds the event loop open (a ref'd keep-alive) while the
    // killed workers are still exiting, so the process can't exit early.
    const keepAlive = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout;
    expect(keepAlive.hasRef()).toBe(true);
    await vi.waitFor(() =>
      expect(workspace.runHook).toHaveBeenCalledWith(
        "after_run",
        expect.any(String),
        expect.any(Object),
      ),
    );
    expect(stopped).toBe(false);
    expect(clearIntervalSpy).not.toHaveBeenCalledWith(keepAlive);

    releaseAfterRun();
    await stopping;
    expect(stopped).toBe(true);
    expect(clearIntervalSpy).toHaveBeenCalledWith(keepAlive);
  });

  it("without abort drains gracefully: running sessions are never aborted", async () => {
    const { orchestrator, sessions, finish, workerSignals } = await startWithRunningWorkers();

    let stopped = false;
    const stopping = orchestrator.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((res) => setTimeout(res, 20));
    expect(stopped).toBe(false);

    finish();
    await stopping;

    expect(workerSignals.map((s) => s?.aborted)).toEqual([false, false]);
    expect(sessions.map((s) => s.abortController.signal.aborted)).toEqual([false, false]);
    // The completed single-turn workers arm continuation retries during the
    // drain (pre-existing behaviour); clear them so no timer outlives the test.
    for (const retry of orchestrator.getState().retryAttempts.values()) {
      clearTimeout(retry.timerId);
    }
  });

  it("without abort, a multi-turn agent ends after the turn it's on instead of starting another", async () => {
    let turnsStarted = 0;
    let finish!: () => void;
    const finished = new Promise<void>((res) => {
      finish = res;
    });
    const agent: AgentAdapter = {
      name: "multi-turn",
      persistentSession: true,
      async startSession() {
        return { id: "s-1", abortController: new AbortController() };
      },
      async *streamEvents(): AsyncIterable<AgentEvent> {
        turnsStarted++;
        // Turn 1 ends when the test says so; any later turn would never end.
        if (turnsStarted === 1) await finished;
        else await new Promise(() => {});
        yield { type: "done", success: true };
      },
      async stopSession() {},
    };
    const issue = createTestIssue({ id: "id-1", identifier: "MT-1" });
    const orchestrator = new Orchestrator(
      new MemoryTracker([issue]),
      agent,
      createWorkspace(),
      {
        pollIntervalMs: 100_000,
        maxConcurrentAgents: 1,
        maxTurns: 5,
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
      {},
    );
    orchestrator.start();
    await vi.waitFor(() => expect(turnsStarted).toBe(1));

    const stopping = orchestrator.stop();
    finish();
    await stopping;

    expect(turnsStarted).toBe(1);
    expect(orchestrator.getState().running.size).toBe(0);
    for (const retry of orchestrator.getState().retryAttempts.values()) clearTimeout(retry.timerId);
  });
});

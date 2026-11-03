import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AgentAdapter } from "../../../src/agent/types.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";
import { runWorker, type WorkerConfig } from "../../../src/worker/runner.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";
import { grantedWorkspaceLock } from "../../support/workspace-lock.js";

const issue: NormalizedIssue = {
  id: "issue-1",
  identifier: "MT-42",
  title: "Test issue",
  description: "",
  state: "Todo",
  priority: 1,
  labels: [],
  blockedBy: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const config: WorkerConfig = {
  maxTurns: 1,
  promptTemplate: "Fix {{ issue.identifier }}",
  trackerConfig: {
    kind: "memory",
    project_slug: "test",
    active_states: ["Todo"],
    terminal_states: ["Done"],
  },
};

function mockAgent(): AgentAdapter {
  return {
    name: "mock",
    persistentSession: true,
    startSession: vi.fn(async () => ({
      id: "s1",
      pid: 777,
      abortController: new AbortController(),
    })),
    async *streamEvents() {
      yield { type: "done" as const, success: true };
    },
    stopSession: vi.fn(async () => {}),
  };
}

function mockWorkspace(acquireLock: unknown, runHook = vi.fn().mockResolvedValue(undefined)) {
  return {
    ensureWorkspace: vi.fn().mockResolvedValue("/tmp/ws/MT-42"),
    acquireLock,
    runHook,
    writeMcpConfig: vi.fn().mockResolvedValue("/tmp/ws/MT-42/.forge/mcp.json"),
  } as unknown as WorkspaceManager;
}

describe("runWorker workspace dispatch lock (FRG-4527)", () => {
  it("refuses to dispatch into a workspace locked by a live process, and logs it", async () => {
    const warn = vi.fn();
    const logger = { warn, debug: vi.fn(), child: () => logger } as unknown as Logger;
    const holder = { pid: 4242, token: "t", startedAt: "2026-10-01T00:00:00Z", agentPid: 4343 };
    const workspace = mockWorkspace(
      vi.fn().mockResolvedValue({ acquired: false, holder, markedPids: [4444] }),
    );
    const agent = mockAgent();

    await expect(
      runWorker(issue, { ...config, logger }, agent, new MemoryTracker([issue]), workspace),
    ).rejects.toThrow("Workspace for MT-42 is locked by live pid 4242");

    expect(warn).toHaveBeenCalledWith(
      {
        holderPid: 4242,
        holderAgentPid: 4343,
        holderStartedAt: "2026-10-01T00:00:00Z",
        holderMarkedPids: [4444],
      },
      "Workspace lock held by a live process; skipping dispatch",
    );
    expect(workspace.ensureWorkspace).not.toHaveBeenCalled();
    expect(workspace.runHook).not.toHaveBeenCalled();
    expect(agent.startSession).not.toHaveBeenCalled();
  });

  it("takes the lock before touching the workspace, records the agent pid, and releases after the run", async () => {
    const { lock, acquireLock } = grantedWorkspaceLock();
    const order: string[] = [];
    acquireLock.mockImplementation(async () => {
      order.push("lock");
      return { acquired: true, lock };
    });
    lock.release.mockImplementation(async () => {
      order.push("release");
    });
    const runHook = vi.fn(async (name: string) => {
      order.push(name);
    });
    const agent = mockAgent();
    vi.mocked(agent.stopSession).mockImplementation(async () => {
      order.push("stop");
    });
    const workspace = mockWorkspace(acquireLock, runHook);
    vi.mocked(workspace.ensureWorkspace).mockImplementation(async () => {
      order.push("ensure");
      return "/tmp/ws/MT-42";
    });

    const result = await runWorker(issue, config, agent, new MemoryTracker([issue]), workspace);

    expect(result.success).toBe(true);
    expect(acquireLock).toHaveBeenCalledWith(issue);
    expect(lock.recordAgentPid).toHaveBeenCalledWith(777);
    expect(order).toEqual(["lock", "ensure", "before_run", "stop", "after_run", "release"]);
  });

  it("records the agent pid on the persistent runTurn path too", async () => {
    const { lock, acquireLock } = grantedWorkspaceLock();
    const agent: AgentAdapter = {
      ...mockAgent(),
      async *runTurn() {
        yield { type: "done" as const, success: true };
      },
    };
    const result = await runWorker(
      issue,
      config,
      agent,
      new MemoryTracker([issue]),
      mockWorkspace(acquireLock),
    );
    expect(result.success).toBe(true);
    expect(agent.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ handshakeOnly: true }),
    );
    expect(lock.recordAgentPid).toHaveBeenCalledWith(777);
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it("releases the lock when before_run fails", async () => {
    const { lock, acquireLock } = grantedWorkspaceLock();
    const runHook = vi.fn().mockRejectedValue(new Error("hook boom"));
    await expect(
      runWorker(
        issue,
        config,
        mockAgent(),
        new MemoryTracker([issue]),
        mockWorkspace(acquireLock, runHook),
      ),
    ).rejects.toThrow("hook boom");
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it("releases the lock when workspace setup fails", async () => {
    const { lock, acquireLock } = grantedWorkspaceLock();
    const workspace = mockWorkspace(acquireLock);
    vi.mocked(workspace.ensureWorkspace).mockRejectedValue(new Error("clone boom"));
    await expect(
      runWorker(issue, config, mockAgent(), new MemoryTracker([issue]), workspace),
    ).rejects.toThrow("clone boom");
    expect(lock.release).toHaveBeenCalledTimes(1);
  });
});

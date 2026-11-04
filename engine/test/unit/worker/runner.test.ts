import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentAdapter,
  AgentEvent,
  SessionHandle,
  StartSessionParams,
} from "../../../src/agent/types.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";
import { runWorker } from "../../../src/worker/runner.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";
import { grantedWorkspaceLock } from "../../support/workspace-lock.js";

const testIssue: NormalizedIssue = {
  id: "issue-1",
  identifier: "MT-42",
  title: "Test issue",
  description: "Test description",
  state: "Todo",
  priority: 1,
  labels: [],
  blockedBy: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

function createMockAgent(events: AgentEvent[][], persistent = true): AgentAdapter {
  let turnIndex = 0;
  return {
    name: "mock",
    persistentSession: persistent,
    async startSession(_params) {
      return {
        id: `session-${turnIndex}`,
        abortController: new AbortController(),
      };
    },
    async *streamEvents(_handle: SessionHandle) {
      const turnEvents = events[turnIndex] || [{ type: "done" as const, success: true }];
      turnIndex++;
      for (const event of turnEvents) {
        yield event;
      }
    },
    async stopSession() {},
  };
}

function createMockWorkspace(): WorkspaceManager {
  return {
    ensureWorkspace: vi.fn().mockResolvedValue("/tmp/test-workspace"),
    acquireLock: grantedWorkspaceLock().acquireLock,
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    runHook: vi.fn().mockResolvedValue(undefined),
    writeMcpConfig: vi.fn().mockResolvedValue("/tmp/test-workspace/.forge/mcp.json"),
    toSafeId: vi.fn((id: string) => id),
  } as unknown as WorkspaceManager;
}

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

describe("runWorker", () => {
  it("runs a single turn and completes", async () => {
    const agent = createMockAgent([
      [
        { type: "text", content: "Working on it" },
        { type: "done", success: true },
      ],
    ]);

    const tracker = new MemoryTracker([testIssue]);
    // Move to terminal so worker stops after first turn
    tracker.updateIssueState("issue-1", "Done");

    const workspace = createMockWorkspace();

    const result = await runWorker(
      testIssue,
      {
        maxTurns: 5,
        promptTemplate: "Fix {{ issue.identifier }}",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo", "In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
    );

    expect(result.issueId).toBe("issue-1");
    expect(result.turns).toBe(1);
    expect(result.success).toBe(true);
    expect(result.workspacePath).toBeDefined();
    expect(workspace.ensureWorkspace).toHaveBeenCalledWith(testIssue);
    expect(workspace.runHook).toHaveBeenCalledWith(
      "before_run",
      "/tmp/test-workspace",
      expect.objectContaining({ ISSUE_IDENTIFIER: "MT-42" }),
    );
    expect(workspace.runHook).toHaveBeenCalledWith(
      "after_run",
      "/tmp/test-workspace",
      expect.objectContaining({ ISSUE_IDENTIFIER: "MT-42" }),
    );
  });

  it("runs multiple turns while issue stays active", async () => {
    const agent = createMockAgent([
      [{ type: "done", success: true }],
      [{ type: "done", success: true }],
      [{ type: "done", success: true }],
    ]);

    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);

    const workspace = createMockWorkspace();
    const turns: number[] = [];

    const result = await runWorker(
      testIssue,
      {
        maxTurns: 3,
        promptTemplate: "Fix {{ issue.identifier }}",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo", "In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
      {
        onTurnStart: (_id, turn) => turns.push(turn),
      },
    );

    expect(result.turns).toBe(3);
    expect(turns).toEqual([1, 2, 3]);
  });

  it("stops when issue moves to terminal state between turns", async () => {
    let turnCount = 0;
    const agent: AgentAdapter = {
      name: "mock",
      persistentSession: true,
      async startSession() {
        return {
          id: `s-${turnCount}`,
          abortController: new AbortController(),
        };
      },
      async *streamEvents() {
        turnCount++;
        yield { type: "done" as const, success: true };
      },
      async stopSession() {},
    };

    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);

    // After first turn, move issue to Done
    const origFetch = tracker.fetchIssueStatesByIds.bind(tracker);
    let fetchCount = 0;
    tracker.fetchIssueStatesByIds = async (ids: string[]) => {
      fetchCount++;
      if (fetchCount >= 1) {
        tracker.updateIssueState("issue-1", "Done");
      }
      return origFetch(ids);
    };

    const workspace = createMockWorkspace();

    const result = await runWorker(
      testIssue,
      {
        maxTurns: 10,
        promptTemplate: "Work on it",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
    );

    expect(result.turns).toBe(1);
  });

  it("accumulates token usage across turns", async () => {
    const agent = createMockAgent([
      [
        { type: "usage", inputTokens: 100, outputTokens: 50 },
        { type: "done", success: true },
      ],
      [
        { type: "usage", inputTokens: 200, outputTokens: 100 },
        { type: "done", success: true },
      ],
    ]);

    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);
    // Move to done after second turn
    let fetchCount = 0;
    const origFetch = tracker.fetchIssueStatesByIds.bind(tracker);
    tracker.fetchIssueStatesByIds = async (ids: string[]) => {
      fetchCount++;
      if (fetchCount >= 2) tracker.updateIssueState("issue-1", "Done");
      return origFetch(ids);
    };

    const workspace = createMockWorkspace();

    const result = await runWorker(
      testIssue,
      {
        maxTurns: 10,
        promptTemplate: "Work",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
    );

    expect(result.tokens.input).toBe(300);
    expect(result.tokens.output).toBe(150);
  });

  it("passes sessionId to startSession on turn 2+", async () => {
    const startSessionSpy = vi.fn().mockImplementation((_params) => ({
      id: `session-${Date.now()}`,
      abortController: new AbortController(),
    }));

    const agent: AgentAdapter = {
      name: "mock",
      persistentSession: true,
      startSession: startSessionSpy,
      async *streamEvents() {
        yield { type: "done" as const, success: true };
      },
      async stopSession() {},
    };

    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);
    let fetchCount = 0;
    const origFetch = tracker.fetchIssueStatesByIds.bind(tracker);
    tracker.fetchIssueStatesByIds = async (ids: string[]) => {
      fetchCount++;
      if (fetchCount >= 2) tracker.updateIssueState("issue-1", "Done");
      return origFetch(ids);
    };

    const workspace = createMockWorkspace();

    await runWorker(
      testIssue,
      {
        maxTurns: 3,
        promptTemplate: "Fix {{ issue.identifier }}",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo", "In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
    );

    // Turn 1: no sessionId
    expect(startSessionSpy.mock.calls[0][0].sessionId).toBeUndefined();
    // Turn 2: truthy sessionId (triggers --continue)
    expect(startSessionSpy.mock.calls[1][0].sessionId).toBeTruthy();
  });

  it("uses continuation prompt on turn 2+", async () => {
    const startSessionSpy = vi.fn().mockImplementation((_params) => ({
      id: `session-${Date.now()}`,
      abortController: new AbortController(),
    }));

    const agent: AgentAdapter = {
      name: "mock",
      persistentSession: true,
      startSession: startSessionSpy,
      async *streamEvents() {
        yield { type: "done" as const, success: true };
      },
      async stopSession() {},
    };

    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);
    let fetchCount = 0;
    const origFetch = tracker.fetchIssueStatesByIds.bind(tracker);
    tracker.fetchIssueStatesByIds = async (ids: string[]) => {
      fetchCount++;
      if (fetchCount >= 2) tracker.updateIssueState("issue-1", "Done");
      return origFetch(ids);
    };

    const workspace = createMockWorkspace();

    await runWorker(
      testIssue,
      {
        maxTurns: 3,
        promptTemplate: "Fix {{ issue.identifier }}",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo", "In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
    );

    // Turn 1: full rendered prompt
    expect(startSessionSpy.mock.calls[0][0].prompt).toContain("Fix MT-42");
    // Turn 2: continuation guidance, not full template
    expect(startSessionSpy.mock.calls[1][0].prompt).toContain("Continuation guidance");
    expect(startSessionSpy.mock.calls[1][0].prompt).not.toContain("Fix MT-42");
  });

  it("stops on agent error", async () => {
    const agent = createMockAgent([[{ type: "error", message: "Agent crashed" }]]);

    const tracker = new MemoryTracker([testIssue]);
    const workspace = createMockWorkspace();

    const result = await runWorker(
      testIssue,
      {
        maxTurns: 5,
        promptTemplate: "Fix it",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
    );

    // Should still have run after_run hook
    expect(workspace.runHook).toHaveBeenCalledWith(
      "after_run",
      "/tmp/test-workspace",
      expect.objectContaining({ ISSUE_IDENTIFIER: "MT-42" }),
    );
    expect(result.turns).toBe(1);
    expect(result.success).toBe(false);
  });

  it("keeps the agent's reason when a turn fails, so the window can show it", async () => {
    const reason = "Failed to authenticate: OAuth session expired and could not be refreshed";
    const agent = createMockAgent([
      [
        { type: "error", message: reason },
        { type: "done", success: false },
      ],
    ]);
    const tracker = new MemoryTracker([testIssue]);
    const result = await runWorker(
      testIssue,
      {
        maxTurns: 5,
        promptTemplate: "Fix it",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      createMockWorkspace(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe(reason);
  });

  it("writes MCP config when mcpServers provided", async () => {
    const agent = createMockAgent([[{ type: "done", success: true }]]);
    const tracker = new MemoryTracker([testIssue]);
    tracker.updateIssueState("issue-1", "Done");
    const workspace = createMockWorkspace();

    await runWorker(
      testIssue,
      {
        maxTurns: 1,
        promptTemplate: "Fix it",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
        mcpServers: { "forge-linear": { command: "node" } },
      },
      agent,
      tracker,
      workspace,
    );

    expect(workspace.writeMcpConfig).toHaveBeenCalledWith("/tmp/test-workspace", {
      "forge-linear": { command: "node" },
    });
  });

  it("passes approvalPolicy to agent.startSession", async () => {
    const startSessionSpy = vi.fn().mockResolvedValue({
      id: "s-1",
      abortController: new AbortController(),
    });

    const agent: AgentAdapter = {
      name: "mock",
      persistentSession: true,
      startSession: startSessionSpy,
      async *streamEvents() {
        yield { type: "done" as const, success: true };
      },
      async stopSession() {},
    };

    const tracker = new MemoryTracker([testIssue]);
    tracker.updateIssueState("issue-1", "Done");
    const workspace = createMockWorkspace();

    await runWorker(
      testIssue,
      {
        maxTurns: 1,
        approvalPolicy: "bypassPermissions",
        promptTemplate: "Fix {{ issue.identifier }}",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
    );

    expect(startSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPolicy: "bypassPermissions",
      }),
    );
  });

  it("continues when fetchIssueStatesByIds returns empty map (transient API failure)", async () => {
    let turnCount = 0;
    const agent: AgentAdapter = {
      name: "mock",
      persistentSession: true,
      async startSession() {
        return { id: `s-${turnCount}`, abortController: new AbortController() };
      },
      async *streamEvents() {
        turnCount++;
        yield { type: "done" as const, success: true };
      },
      async stopSession() {},
    };

    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);

    let fetchCount = 0;
    tracker.fetchIssueStatesByIds = async (_ids: string[]) => {
      fetchCount++;
      if (fetchCount === 1) return new Map();
      return new Map([["issue-1", "Done"]]);
    };

    const workspace = createMockWorkspace();
    const result = await runWorker(
      testIssue,
      {
        maxTurns: 10,
        promptTemplate: "Work",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
    );

    expect(result.turns).toBe(2);
  });

  it("continues when fetchIssueStatesByIds throws (network error)", async () => {
    let turnCount = 0;
    const agent: AgentAdapter = {
      name: "mock",
      persistentSession: true,
      async startSession() {
        return { id: `s-${turnCount}`, abortController: new AbortController() };
      },
      async *streamEvents() {
        turnCount++;
        yield { type: "done" as const, success: true };
      },
      async stopSession() {},
    };

    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);

    let fetchCount = 0;
    tracker.fetchIssueStatesByIds = async (_ids: string[]) => {
      fetchCount++;
      if (fetchCount === 1) throw new Error("Network timeout");
      return new Map([["issue-1", "Done"]]);
    };

    const workspace = createMockWorkspace();
    const result = await runWorker(
      testIssue,
      {
        maxTurns: 10,
        promptTemplate: "Work",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
    );

    expect(result.turns).toBe(2);
  });

  it("stops the agent session when a run ends normally (no leaked agent process)", async () => {
    const stopSpy = vi.fn().mockResolvedValue(undefined);
    const agent = { ...createMockAgent([[{ type: "done", success: true }]]), stopSession: stopSpy };
    const tracker = new MemoryTracker([{ ...testIssue, state: "Done" }]);
    await runWorker(
      testIssue,
      {
        maxTurns: 5,
        promptTemplate: "Work on it",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo", "In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      createMockWorkspace(),
    );
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("stops turn when read timeout fires", async () => {
    // Create an agent that yields events very slowly
    const stopSpy = vi.fn();
    const agent: AgentAdapter = {
      name: "mock",
      persistentSession: true,
      async startSession() {
        return {
          id: "s-1",
          abortController: new AbortController(),
        };
      },
      async *streamEvents(handle: SessionHandle) {
        // Yield one event, then hang indefinitely until aborted
        yield { type: "text" as const, content: "Starting..." };
        await new Promise<void>((resolve) => {
          handle.abortController.signal.addEventListener("abort", () => resolve());
        });
        yield { type: "done" as const, success: false };
      },
      stopSession: stopSpy,
    };

    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);
    const workspace = createMockWorkspace();

    const result = await runWorker(
      testIssue,
      {
        maxTurns: 5,
        readTimeoutMs: 50, // Very short timeout for test
        promptTemplate: "Work on it",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
    );

    expect(result.success).toBe(false);
    expect(result.turns).toBe(1);
    expect(stopSpy).toHaveBeenCalled();
  });

  it("reports failure when the run is aborted mid-turn, even if the agent says done success (FRG-4086)", async () => {
    // Claude's fallback yields `done success:true` for a killed process that
    // had already streamed events; the orchestrator's kill must still read as
    // a failed run, never a completed one.
    const agent: AgentAdapter = {
      name: "mock",
      persistentSession: true,
      async startSession() {
        return { id: "s-1", abortController: new AbortController() };
      },
      async *streamEvents(handle: SessionHandle) {
        yield { type: "text" as const, content: "Running make all" };
        const signal = handle.abortController.signal;
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        }
        yield { type: "done" as const, success: true };
      },
      async stopSession() {},
    };
    const controller = new AbortController();
    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);

    const running = runWorker(
      testIssue,
      {
        maxTurns: 5,
        promptTemplate: "Work on it",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      createMockWorkspace(),
      {
        signal: controller.signal,
        onEvent: (_id, event) => {
          if (event.type === "text") controller.abort();
        },
      },
    );

    const result = await running;
    expect(result.success).toBe(false);
    expect(result.turns).toBe(1);
  });

  it("reports failure when a runTurn run is aborted mid-turn (FRG-4086)", async () => {
    const agent: AgentAdapter = {
      name: "mock",
      persistentSession: true,
      async startSession() {
        return { id: "s-1", abortController: new AbortController() };
      },
      async *streamEvents() {},
      async *runTurn(handle: SessionHandle) {
        yield { type: "text" as const, content: "Running make all" };
        const signal = handle.abortController.signal;
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        }
        yield { type: "done" as const, success: true };
      },
      async stopSession() {},
    };
    const controller = new AbortController();
    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);

    const result = await runWorker(
      testIssue,
      {
        maxTurns: 5,
        promptTemplate: "Work on it",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      createMockWorkspace(),
      {
        signal: controller.signal,
        onEvent: (_id, event) => {
          if (event.type === "text") controller.abort();
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.turns).toBe(1);
  });

  it("reports failure when aborted before the first turn starts (FRG-4086)", async () => {
    const controller = new AbortController();
    const agent = createMockAgent([[{ type: "done", success: true }]]);
    const workspace = createMockWorkspace();
    // The kill lands while the before_run hook is still running.
    vi.mocked(workspace.runHook).mockImplementation(async (name: string) => {
      if (name === "before_run") controller.abort();
    });
    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);

    const result = await runWorker(
      testIssue,
      {
        maxTurns: 5,
        promptTemplate: "Work on it",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
      { signal: controller.signal },
    );

    expect(result.success).toBe(false);
    expect(result.turns).toBe(0);
  });

  it("does not start a runTurn session when aborted during before_run (FRG-5424)", async () => {
    const controller = new AbortController();
    const startSession = vi.fn(async () => ({ id: "s-1", abortController: new AbortController() }));
    const agent: AgentAdapter = {
      name: "mock",
      persistentSession: true,
      startSession,
      async *streamEvents() {},
      async *runTurn() {
        yield { type: "done" as const, success: true };
      },
      async stopSession() {},
    };
    const workspace = createMockWorkspace();
    vi.mocked(workspace.runHook).mockImplementation(async (name: string) => {
      if (name === "before_run") controller.abort();
    });
    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);

    const result = await runWorker(
      testIssue,
      {
        maxTurns: 5,
        promptTemplate: "Work on it",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
      { signal: controller.signal },
    );

    expect(startSession).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.turns).toBe(0);
    expect(workspace.runHook).toHaveBeenCalledWith(
      "after_run",
      expect.any(String),
      expect.any(Object),
    );
  });

  it("forwards the run signal to a pending handshake and reports its abort as a failure (FRG-5682)", async () => {
    const controller = new AbortController();
    // Like codex: the abort kills the child mid-handshake and rejects startSession.
    const startSession = vi.fn(
      ({ signal }: StartSessionParams) =>
        new Promise<SessionHandle>((_, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const agent: AgentAdapter = {
      name: "mock",
      persistentSession: true,
      startSession,
      async *streamEvents() {},
      async *runTurn() {
        yield { type: "done" as const, success: true };
      },
      async stopSession() {},
    };
    const workspace = createMockWorkspace();
    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);

    const running = runWorker(
      testIssue,
      {
        maxTurns: 5,
        promptTemplate: "Work on it",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(startSession).toHaveBeenCalled());
    expect(startSession.mock.calls[0][0].signal).toBe(controller.signal);
    controller.abort();

    const result = await running;
    expect(result.success).toBe(false);
    expect(result.error).toBe("Aborted");
    expect(workspace.runHook).toHaveBeenCalledWith(
      "after_run",
      expect.any(String),
      expect.any(Object),
    );
  });

  it("still throws a handshake failure that is not an abort (FRG-5682)", async () => {
    const agent = createMockAgent([]);
    agent.startSession = async () => {
      throw new Error("codex app-server crashed");
    };
    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);

    await expect(
      runWorker(
        testIssue,
        {
          maxTurns: 5,
          promptTemplate: "Work on it",
          trackerConfig: {
            kind: "memory",
            project_slug: "test",
            active_states: ["In Progress"],
            terminal_states: ["Done"],
          },
        },
        agent,
        tracker,
        createMockWorkspace(),
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("codex app-server crashed");
  });

  it("single-turn agent runs exactly one turn even if ticket stays active", async () => {
    const agent = createMockAgent(
      [
        [
          { type: "text", content: "Did some work" },
          { type: "done", success: true },
        ],
        // Second turn should NOT be reached
        [
          { type: "text", content: "More work" },
          { type: "done", success: true },
        ],
      ],
      false, // persistentSession = false
    );

    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);

    const result = await runWorker(
      testIssue,
      {
        maxTurns: 50,
        promptTemplate: "{{ issue.title }}",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo", "In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      createMockWorkspace(),
    );

    expect(result.turns).toBe(1);
    expect(result.success).toBe(true);
    expect(result.preserveWorkspace).toBe(true);
  });

  it("persistent agent loops multiple turns when ticket stays active", async () => {
    const agent = createMockAgent(
      [
        [{ type: "done" as const, success: true }],
        [{ type: "done" as const, success: true }],
        [{ type: "done" as const, success: true }],
      ],
      true, // persistentSession = true
    );

    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);

    // After 2 checks move ticket to Done
    let checkCount = 0;
    const origFetch = tracker.fetchIssueStatesByIds.bind(tracker);
    tracker.fetchIssueStatesByIds = async (ids: string[]) => {
      checkCount++;
      if (checkCount >= 3) {
        return new Map([[testIssue.id, "Done"]]);
      }
      return origFetch(ids);
    };

    const result = await runWorker(
      testIssue,
      {
        maxTurns: 50,
        promptTemplate: "{{ issue.title }}",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo", "In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      createMockWorkspace(),
    );

    expect(result.turns).toBe(3);
    expect(result.success).toBe(true);
    expect(result.preserveWorkspace).toBe(false);
  });

  it("logs state check failures and continues while under the retry threshold", async () => {
    const agent = createMockAgent([[{ type: "done" as const, success: true }]], true);

    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);
    let fetchCount = 0;
    tracker.fetchIssueStatesByIds = async (_ids: string[]) => {
      fetchCount++;
      if (fetchCount === 1) throw new Error("Linear API error");
      return new Map([[testIssue.id, "Done"]]);
    };

    const { logger, logs } = createMockLogger();
    const result = await runWorker(
      testIssue,
      {
        maxTurns: 10,
        promptTemplate: "Work",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["In Progress"],
          terminal_states: ["Done"],
        },
        logger,
        maxStateCheckRetries: 3,
      },
      agent,
      tracker,
      createMockWorkspace(),
    );

    expect(result.turns).toBe(2);
    expect(result.success).toBe(true);
    const warnLogs = logs.filter((l) => l.level === "warn");
    expect(warnLogs).toHaveLength(1);
    expect(warnLogs[0].obj).toMatchObject({
      issueId: testIssue.id,
      identifier: testIssue.identifier,
      error: "Linear API error",
      consecutiveFailures: 1,
      maxRetries: 3,
    });
  });

  it("aborts the run after repeated state check failures", async () => {
    const agent = createMockAgent(
      [[{ type: "done" as const, success: true }], [{ type: "done" as const, success: true }]],
      true,
    );

    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);
    tracker.fetchIssueStatesByIds = async (_ids: string[]) => {
      throw new Error("Linear API down");
    };

    const { logger, logs } = createMockLogger();
    const result = await runWorker(
      testIssue,
      {
        maxTurns: 10,
        promptTemplate: "Work",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["In Progress"],
          terminal_states: ["Done"],
        },
        logger,
        maxStateCheckRetries: 2,
      },
      agent,
      tracker,
      createMockWorkspace(),
    );

    expect(result.turns).toBe(2);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Linear API down");
    const errorLogs = logs.filter((l) => l.level === "error");
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0].obj.consecutiveFailures).toBe(2);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AgentEvent } from "../../../src/agent/types.js";
import { Orchestrator } from "../../../src/orchestrator/orchestrator.js";
import type { OrchestratorConfig } from "../../../src/orchestrator/types.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";
import { grantedWorkspaceLock } from "../../support/workspace-lock.js";

function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    id: "id-1",
    identifier: "MT-1",
    title: "Test",
    description: "Test desc",
    state: "Todo",
    priority: 2,
    labels: [],
    blockedBy: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function createMockAgent(): AgentAdapter {
  return {
    name: "mock",
    persistentSession: true,
    async startSession() {
      return { id: "s-1", abortController: new AbortController() };
    },
    async *streamEvents(): AsyncIterable<AgentEvent> {
      yield { type: "done", success: true };
    },
    async stopSession() {},
  };
}

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

function baseConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    pollIntervalMs: 1000,
    maxConcurrentAgents: 5,
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
    promptTemplate: "Fix it",
    ...overrides,
  };
}

describe("Orchestrator per-build cost ceiling (FRG-958)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts the build when accumulated spend exceeds the ceiling", async () => {
    vi.useFakeTimers();
    const tracker = new MemoryTracker([makeIssue()]);
    const dispatched: string[] = [];
    const ceilingEvents: Array<{ spendUsd: number; maxBuildUsd: number }> = [];
    const orchestrator = new Orchestrator(
      tracker,
      createMockAgent(),
      createMockWorkspace(),
      baseConfig({
        costCeiling: { maxBuildUsd: 1, inputUsdPerMtok: 3, outputUsdPerMtok: 15 },
      }),
      {
        onDispatch: (issue) => dispatched.push(issue.id),
        onCostCeilingExceeded: (info) => ceilingEvents.push(info),
      },
    );

    // Pre-load accumulated usage over the $1 cap (1M input @ $3 = $3).
    const state = orchestrator.getState() as { totalTokens: { input: number; output: number } };
    state.totalTokens.input = 1_000_000;

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(ceilingEvents).toHaveLength(1);
    expect(ceilingEvents[0].spendUsd).toBeCloseTo(3);
    expect(ceilingEvents[0].maxBuildUsd).toBe(1);
    // Build aborted before dispatching any new worker.
    expect(dispatched).toHaveLength(0);
    // Orchestrator stopped: tick loop torn down.
    expect(orchestrator.getState().tickTimerId).toBeNull();

    await orchestrator.stop();
  });

  it("fires the ceiling abort exactly once across ticks", async () => {
    vi.useFakeTimers();
    const tracker = new MemoryTracker([makeIssue()]);
    const ceilingEvents: unknown[] = [];

    const orchestrator = new Orchestrator(
      tracker,
      createMockAgent(),
      createMockWorkspace(),
      baseConfig({
        pollIntervalMs: 10,
        costCeiling: { maxBuildUsd: 1, inputUsdPerMtok: 3, outputUsdPerMtok: 15 },
      }),
      { onCostCeilingExceeded: (info) => ceilingEvents.push(info) },
    );

    const state = orchestrator.getState() as { totalTokens: { input: number; output: number } };
    state.totalTokens.input = 5_000_000;

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(200);

    expect(ceilingEvents).toHaveLength(1);

    await orchestrator.stop();
  });

  it("does not interfere with normal dispatch when ceiling is disabled", async () => {
    vi.useFakeTimers();
    const tracker = new MemoryTracker([makeIssue()]);
    const dispatched: string[] = [];

    const orchestrator = new Orchestrator(
      tracker,
      createMockAgent(),
      createMockWorkspace(),
      baseConfig({
        costCeiling: { maxBuildUsd: 0, inputUsdPerMtok: 3, outputUsdPerMtok: 15 },
      }),
      { onDispatch: (issue) => dispatched.push(issue.id) },
    );

    const state = orchestrator.getState() as { totalTokens: { input: number; output: number } };
    state.totalTokens.input = 999_000_000;

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(dispatched).toContain("id-1");

    await orchestrator.stop();
  });
});

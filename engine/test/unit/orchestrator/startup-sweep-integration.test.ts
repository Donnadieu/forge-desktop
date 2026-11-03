import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/worker/runner.js", () => ({
  runWorker: vi.fn(() => new Promise<never>(() => {})),
}));

import type { AgentAdapter, AgentEvent } from "../../../src/agent/types.js";
import { Orchestrator } from "../../../src/orchestrator/orchestrator.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";
import { grantedWorkspaceLock } from "../../support/workspace-lock.js";

/**
 * Poll `predicate` until it holds or the timeout elapses. Replaces a fixed
 * `setTimeout` sleep so the assertion is fast on a quiet machine yet does not
 * flake when the async startup sweep loses the race under CI load (the sweep is
 * kicked off by `start()` but completes on a microtask/IO turn we can't await
 * directly — its private promise is only awaited by the tick loop).
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

const SWEEP_COMPLETE = "workspace startup sweep complete (FRG-1886)";

function makeIssue(id: string, state: string): NormalizedIssue {
  return {
    id,
    identifier: id,
    title: "t",
    description: "",
    state,
    priority: 1,
    labels: [],
    blockedBy: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
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

interface MockWorkspace extends WorkspaceManager {
  cleanupCompletedWorkspace: ReturnType<typeof vi.fn>;
}

function createMockWorkspace(root: string): MockWorkspace {
  return {
    config: { root },
    ensureWorkspace: vi.fn().mockResolvedValue("/tmp/ws"),
    acquireLock: grantedWorkspaceLock().acquireLock,
    cleanupCompletedWorkspace: vi
      .fn()
      .mockResolvedValue({ removed: true, reason: "ok", errors: [] }),
  } as unknown as MockWorkspace;
}

describe("Orchestrator — startup workspace sweep latch (FRG-1886)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "forge-startup-sweep-integration-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function makeStaleWorkspace(identifier: string): Promise<string> {
    const wsPath = join(root, identifier);
    await mkdir(wsPath);
    const marker = join(wsPath, ".forge-ready");
    writeFileSync(marker, "stale");
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(marker, staleTime, staleTime);
    return wsPath;
  }

  it("runs the startup sweep once before the first dispatch", async () => {
    const stalePath = await makeStaleWorkspace("FRG-STALE");

    const tracker = {
      kind: "memory",
      async fetchCandidates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return new Map();
      },
      async fetchTerminalIssues() {
        return [];
      },
      async fetchProgressCounts() {
        return { total: 0, done: 0 };
      },
    } as never;

    const workspace = createMockWorkspace(root);
    const logs: string[] = [];
    const logger = {
      info: (_obj: unknown, msg: string) => logs.push(msg),
      warn: (_obj: unknown, msg: string) => logs.push(msg),
      debug: () => {},
    };

    const orchestrator = new Orchestrator(
      tracker,
      createMockAgent(),
      workspace,
      {
        pollIntervalMs: 1000,
        maxConcurrentAgents: 0,
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
        logger: logger as never,
      },
      {},
    );

    orchestrator.start();
    // Wait for the sweep to actually finish rather than racing a fixed sleep.
    await waitFor(() => logs.includes(SWEEP_COMPLETE));

    expect(logs).toContain(SWEEP_COMPLETE);
    expect(workspace.cleanupCompletedWorkspace).toHaveBeenCalledWith(stalePath, { minAgeMs: 0 });

    await orchestrator.stop();
  });

  it("does not run the startup sweep on subsequent start() calls", async () => {
    await makeStaleWorkspace("FRG-STALE");

    const tracker = {
      kind: "memory",
      async fetchCandidates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return new Map();
      },
      async fetchTerminalIssues() {
        return [];
      },
      async fetchProgressCounts() {
        return { total: 0, done: 0 };
      },
    } as never;

    const workspace = createMockWorkspace(root);
    const logs: string[] = [];
    const logger = {
      info: (_obj: unknown, msg: string) => logs.push(msg),
      warn: (_obj: unknown, msg: string) => logs.push(msg),
      debug: () => {},
    };
    const orchestrator = new Orchestrator(
      tracker,
      createMockAgent(),
      workspace,
      {
        pollIntervalMs: 1000,
        maxConcurrentAgents: 0,
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
        logger: logger as never,
      },
      {},
    );

    orchestrator.start();
    await waitFor(() => logs.includes(SWEEP_COMPLETE));
    expect(workspace.cleanupCompletedWorkspace).toHaveBeenCalledTimes(1);

    // A second start() is a no-op for the timer and must not re-run the sweep.
    // The once-only latch is set synchronously inside start(), so a correct
    // implementation can never enqueue a second sweep — assert immediately, and
    // pin the invariant on the completion-log count so a broken latch (which
    // would log SWEEP_COMPLETE a second time) is caught, not just the call count.
    orchestrator.start();
    expect(workspace.cleanupCompletedWorkspace).toHaveBeenCalledTimes(1);
    expect(logs.filter((m) => m === SWEEP_COMPLETE)).toHaveLength(1);

    await orchestrator.stop();
  });

  it("skips active-issue workspaces during the startup sweep", async () => {
    const activePath = await makeStaleWorkspace("FRG-ACTIVE");

    const tracker = {
      kind: "memory",
      async fetchCandidates() {
        return [makeIssue("FRG-ACTIVE", "Todo")];
      },
      async fetchIssueStatesByIds() {
        return new Map();
      },
      async fetchTerminalIssues() {
        return [];
      },
      async fetchProgressCounts() {
        return { total: 1, done: 0 };
      },
    } as never;

    const workspace = createMockWorkspace(root);
    const logs: string[] = [];
    const logger = {
      info: (_obj: unknown, msg: string) => logs.push(msg),
      warn: (_obj: unknown, msg: string) => logs.push(msg),
      debug: () => {},
    };
    const orchestrator = new Orchestrator(
      tracker,
      createMockAgent(),
      workspace,
      {
        pollIntervalMs: 1000,
        maxConcurrentAgents: 0,
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
        logger: logger as never,
      },
      {},
    );

    orchestrator.start();
    // Wait for the sweep to finish so the negative assertion below is meaningful
    // (it ran and chose to skip, not simply hasn't run yet).
    await waitFor(() => logs.includes(SWEEP_COMPLETE));

    expect(workspace.cleanupCompletedWorkspace).not.toHaveBeenCalledWith(activePath, {
      minAgeMs: 0,
    });

    await orchestrator.stop();
  });
});

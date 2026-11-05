import { describe, expect, it, vi } from "vitest";
import { RoleRouter } from "../../../src/agent/roles.js";
import type { AgentAdapter, AgentEvent, SessionHandle } from "../../../src/agent/types.js";
import { Orchestrator } from "../../../src/orchestrator/orchestrator.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";
import { createTestIssue } from "../../support/fixtures.js";
import { grantedWorkspaceLock } from "../../support/workspace-lock.js";

/** A persistent agent whose every turn moves the card to `next`, and remembers the cards it worked. */
function stageAgent(name: string, tracker: MemoryTracker, next: string) {
  const worked: string[] = [];
  const turns: number[] = [];
  let current = "";
  const agent: AgentAdapter = {
    name,
    persistentSession: true,
    async startSession(params) {
      current = (params as { issue?: { id: string } }).issue?.id ?? "id-1";
      worked.push(current);
      return {
        id: `${name}-${worked.length}`,
        abortController: new AbortController(),
      } as SessionHandle;
    },
    async *runTurn(): AsyncIterable<AgentEvent> {
      turns.push(1);
      await tracker.updateIssueState("id-1", next);
      yield { type: "done", success: true };
    },
    async *streamEvents(): AsyncIterable<AgentEvent> {
      yield { type: "done", success: true };
    },
    async stopSession() {},
  };
  return { agent, worked, turns };
}

function workspace(): WorkspaceManager {
  return {
    ensureWorkspace: vi.fn().mockResolvedValue("/tmp/ws"),
    acquireLock: grantedWorkspaceLock().acquireLock,
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    runHook: vi.fn().mockResolvedValue(undefined),
    writeMcpConfig: vi.fn().mockResolvedValue("/tmp/ws/.forge/mcp.json"),
    toSafeId: vi.fn((id: string) => id),
  } as unknown as WorkspaceManager;
}

describe("roles: each stage's agent (Forge Desktop)", () => {
  it("a card that moves to another role's stage is worked by that role's agent", async () => {
    const tracker = new MemoryTracker([
      createTestIssue({ id: "id-1", identifier: "MT-1", state: "In Progress" }),
    ]);
    const builder = stageAgent("codex", tracker, "AI Review");
    const reviewer = stageAgent("claude", tracker, "Done");
    const router = new RoleRouter(reviewer.agent, [
      { states: ["In Progress"], agent: builder.agent },
    ]);
    const orchestrator = new Orchestrator(
      tracker,
      reviewer.agent,
      workspace(),
      {
        pollIntervalMs: 100_000,
        maxConcurrentAgents: 1,
        maxTurns: 5,
        stallTimeoutSeconds: 300,
        maxRetryAttempts: 3,
        maxRetryDelayMs: 300_000,
        retryBaseDelayMs: 1,
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["In Progress", "AI Review"],
          terminal_states: ["Done"],
        },
        promptTemplate: "Work {{ issue.identifier }}",
        agentForState: (s) => router.agentFor(s),
        roleOf: (s) => router.roleOf(s),
      },
      {},
    );
    orchestrator.start();
    await vi.waitFor(() => expect(tracker.getIssue("id-1")?.state).toBe("Done"), { timeout: 5000 });
    await orchestrator.stop();
    expect(builder.worked).toHaveLength(1);
    // The builder stops after the turn that moved the card: it never works the review stage.
    expect(builder.turns).toHaveLength(1);
    expect(reviewer.worked).toHaveLength(1);
  });
});

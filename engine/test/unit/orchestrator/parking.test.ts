import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentAdapter, SessionHandle } from "../../../src/agent/types.js";
import { BoardReader } from "../../../src/orchestrator/board-reader.js";
import { selectIssuesToDispatch } from "../../../src/orchestrator/dispatcher.js";
import {
  forgetMovedParked,
  isParked,
  PARK_MARKER,
  type ParkedCard,
  readParkMarker,
} from "../../../src/orchestrator/parking.js";
import {
  createInitialState,
  type OrchestratorConfig,
  type RunningEntry,
} from "../../../src/orchestrator/types.js";
import { handleWorkerComplete } from "../../../src/orchestrator/worker-outcomes.js";
import { openLocalStore } from "../../../src/store/local-store.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { NormalizedIssue, TrackerConfig } from "../../../src/tracker/types.js";
import { runWorker } from "../../../src/worker/runner.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";
import { grantedWorkspaceLock } from "../../support/workspace-lock.js";

const trackerConfig: TrackerConfig = {
  kind: "memory",
  project_slug: "",
  team_id: "team-atc",
  active_states: ["Todo", "In Progress"],
  terminal_states: ["Done"],
};

function card(id: string, state: string): NormalizedIssue {
  return {
    id,
    identifier: `ATC-${id}`,
    title: `Card ${id}`,
    description: null,
    state,
    priority: 2,
    labels: [],
    blockedBy: [],
    createdAt: "2026-11-11T00:00:00Z",
    updatedAt: "2026-11-11T00:00:00Z",
  } as NormalizedIssue;
}

const parked = (id: string, state = "In Progress"): ParkedCard => ({
  issueId: id,
  identifier: `ATC-${id}`,
  state,
  next: "AI Review",
  line: "The pull request is open as a draft.",
  parkedAt: "2026-11-11T12:00:00Z",
});

function folder(): string {
  return mkdtempSync(join(tmpdir(), "forge-park-"));
}

function writeMarker(dir: string, body: string): void {
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, PARK_MARKER), body);
}

describe("parking: In Progress is done and the next stage has no column", () => {
  it("reads the agent's note once, then it's gone", () => {
    const dir = folder();
    expect(readParkMarker(dir)).toBeNull();
    writeMarker(
      dir,
      JSON.stringify({ next: "AI Review", line: "The pull request is open as a draft." }),
    );
    expect(readParkMarker(dir)).toEqual({
      next: "AI Review",
      line: "The pull request is open as a draft.",
    });
    expect(existsSync(join(dir, PARK_MARKER))).toBe(false);
    writeMarker(dir, "Waiting on you\n");
    expect(readParkMarker(dir)).toEqual({ next: null, line: "Waiting on you" });
  });

  it("the run ends there, instead of being told to keep going while the card is active", async () => {
    const dir = folder();
    const prompts: string[] = [];
    let turns = 0;
    const agent: AgentAdapter = {
      name: "mock",
      persistentSession: true,
      async startSession(params) {
        prompts.push(params.prompt);
        return { id: `s-${turns}`, abortController: new AbortController() };
      },
      async *streamEvents(_h: SessionHandle) {
        turns++;
        writeMarker(dir, JSON.stringify({ next: "AI Review", line: "Draft pull request open." }));
        yield { type: "done" as const, success: true };
      },
      async stopSession() {},
    };
    const workspace = {
      ensureWorkspace: vi.fn().mockResolvedValue(dir),
      acquireLock: grantedWorkspaceLock().acquireLock,
      removeWorkspace: vi.fn(),
      runHook: vi.fn().mockResolvedValue(undefined),
      writeMcpConfig: vi.fn().mockResolvedValue(join(dir, ".forge/mcp.json")),
      toSafeId: (id: string) => id,
    } as unknown as WorkspaceManager;
    const tracker = new MemoryTracker([card("1", "In Progress")]);
    const result = await runWorker(
      card("1", "In Progress"),
      { maxTurns: 5, promptTemplate: "Build {{ issue.identifier }}", trackerConfig },
      agent,
      tracker,
      workspace,
    );
    expect(turns).toBe(1);
    expect(prompts.some((p) => p.includes("Continuation guidance"))).toBe(false);
    expect(result.success).toBe(true);
    expect(result.parked).toEqual({ next: "AI Review", line: "Draft pull request open." });
  });

  it("a parked card gets no retry and isn't dispatched again", () => {
    const state = createInitialState();
    const put = vi.fn();
    const config = {
      maxTurns: 20,
      maxRetryAttempts: 3,
      maxRetryDelayMs: 60_000,
      retryBaseDelayMs: 1000,
      trackerConfig,
      parking: { put, remove: vi.fn() },
    } as unknown as OrchestratorConfig;
    const entry = {
      issueId: "1",
      identifier: "ATC-1",
      issue: card("1", "In Progress"),
      startedAt: performance.now(),
      wallClockStartedAtMs: Date.now(),
      lastActivityAt: performance.now(),
      tokens: { input: 0, output: 0 },
      workspacePath: "/w/ATC-1",
      attempt: 1,
      abortController: new AbortController(),
      workerPromise: Promise.resolve(),
      turnCount: 1,
      turnTimings: [],
    } as unknown as RunningEntry;
    state.running.set("1", entry);
    handleWorkerComplete(
      { state, config, callbacks: {}, refetchAndDispatch: vi.fn() },
      "1",
      {
        issueId: "1",
        turns: 1,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        success: true,
        workspacePath: "/w/ATC-1",
        preserveWorkspace: true,
        parked: { next: "AI Review", line: "Draft pull request open." },
      },
      1,
    );
    expect(state.retryAttempts.has("1")).toBe(false);
    expect(state.parked.get("1")).toMatchObject({
      state: "In Progress",
      next: "AI Review",
      line: "Draft pull request open.",
    });
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: "1", identifier: "ATC-1" }),
    );
    const picked = selectIssuesToDispatch([card("1", "In Progress"), card("2", "Todo")], state, {
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
      max_concurrent_agents: 4,
      parked: (issue) => isParked(state, issue),
    });
    expect(picked.map((i) => i.id)).toEqual(["2"]);
  });

  it("stays parked after a restart", () => {
    const path = join(folder(), "forge.sqlite");
    const first = openLocalStore(path);
    first.putParked(parked("1"));
    first.close();
    const again = openLocalStore(path);
    expect(again.listParked()).toEqual([parked("1")]);
    again.removeParked("1");
    expect(again.listParked()).toEqual([]);
    again.close();
  });

  it("the tracker wins: a card a teammate moved isn't parked any more", () => {
    const state = createInitialState();
    state.parked.set("1", parked("1"));
    state.parked.set("2", parked("2"));
    state.parked.set("3", parked("3"));
    const remove = vi.fn();
    forgetMovedParked(state, [card("1", "In Progress"), card("2", "Todo")], remove);
    expect([...state.parked.keys()]).toEqual(["1"]);
    expect(remove.mock.calls.map((c) => c[0]).sort()).toEqual(["2", "3"]);
    expect(isParked(state, card("1", "In Progress"))).toBe(true);
    expect(isParked(state, card("1", "AI Review"))).toBe(false);
  });

  it("the board shows which cards wait on the person", async () => {
    const tracker = {
      kind: "memory",
      fetchCandidates: async () => [],
      fetchBoard: async () => [
        { ...card("1", "In Progress"), url: null, assignee: null, branchName: null, prUrl: null },
      ],
    } as never;
    const reader = new BoardReader(tracker, trackerConfig, ["Todo", "In Progress", "Done"]);
    await reader.refresh();
    const view = reader.view(
      [],
      () => false,
      (id) => (id === "1" ? parked("1") : undefined),
    );
    expect(view.columns[1]?.cards[0]?.parked).toEqual({
      next: "AI Review",
      line: "The pull request is open as a draft.",
      since: "2026-11-11T12:00:00Z",
    });
  });
});

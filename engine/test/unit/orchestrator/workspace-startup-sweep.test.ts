import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkspaceStartupSweep } from "../../../src/orchestrator/workspace-startup-sweep.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { NormalizedIssue, TrackerConfig } from "../../../src/tracker/types.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";

function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    id: "id-1",
    identifier: "FRG-1",
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

function makeTracker(activeIdentifiers: string[]): MemoryTracker {
  const issues = activeIdentifiers.map((identifier) =>
    makeIssue({ id: identifier, identifier, state: "Todo" }),
  );
  return new MemoryTracker(issues);
}

function makeWorkspace(root: string): WorkspaceManager {
  return {
    config: { root },
    cleanupCompletedWorkspace: vi
      .fn()
      .mockResolvedValue({ removed: true, reason: "ok", errors: [] }),
  } as unknown as WorkspaceManager;
}

const trackerConfig: TrackerConfig = {
  kind: "memory",
  project_slug: "test",
  active_states: ["Todo"],
  terminal_states: ["Done"],
};

describe("runWorkspaceStartupSweep", () => {
  let root: string;
  let logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "forge-startup-sweep-test-"));
    logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const staleMarker = async (workspacePath: string, nowMs: number): Promise<void> => {
    const markerPath = join(workspacePath, ".forge-ready");
    writeFileSync(markerPath, new Date(nowMs).toISOString());
    await utimes(
      markerPath,
      new Date(nowMs - 25 * 60 * 60 * 1000),
      new Date(nowMs - 25 * 60 * 60 * 1000),
    );
  };

  it("returns zero results when the workspace root is empty", async () => {
    const tracker = makeTracker([]);
    const workspace = makeWorkspace(root);

    const result = await runWorkspaceStartupSweep({
      workspaceRoot: root,
      tracker,
      trackerConfig,
      workspace,
      logger: logger as never,
    });

    expect(result.scanned).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.inodesFreed).toBe(0);
  });

  it("removes a stale workspace whose issue is not active and has no open handles", async () => {
    const tracker = makeTracker([]);
    const workspace = makeWorkspace(root);
    const wsPath = join(root, "FRG-STALE");
    await mkdir(wsPath);
    const nowMs = Date.now() + 25 * 60 * 60 * 1000;
    await staleMarker(wsPath, nowMs);

    const result = await runWorkspaceStartupSweep({
      workspaceRoot: root,
      tracker,
      trackerConfig,
      workspace,
      logger: logger as never,
      nowMs,
      hasOpenHandles: async () => false,
      estimateInodeCount: async () => 42,
    });

    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.inodesFreed).toBe(42);
    expect(workspace.cleanupCompletedWorkspace).toHaveBeenCalledWith(wsPath, { minAgeMs: 0 });
  });

  it("skips active-issue workspaces", async () => {
    const tracker = makeTracker(["FRG-ACTIVE"]);
    const workspace = makeWorkspace(root);
    const activePath = join(root, "FRG-ACTIVE");
    await mkdir(activePath);
    const nowMs = Date.now() + 25 * 60 * 60 * 1000;
    await staleMarker(activePath, nowMs);

    const result = await runWorkspaceStartupSweep({
      workspaceRoot: root,
      tracker,
      trackerConfig,
      workspace,
      logger: logger as never,
      nowMs,
      hasOpenHandles: async () => false,
      estimateInodeCount: async () => 1,
    });

    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(0);
    expect(workspace.cleanupCompletedWorkspace).not.toHaveBeenCalled();
  });

  it("skips stale workspaces that still have open file handles", async () => {
    const tracker = makeTracker([]);
    const workspace = makeWorkspace(root);
    const wsPath = join(root, "FRG-BUSY");
    await mkdir(wsPath);
    const nowMs = Date.now() + 25 * 60 * 60 * 1000;
    await staleMarker(wsPath, nowMs);

    const result = await runWorkspaceStartupSweep({
      workspaceRoot: root,
      tracker,
      trackerConfig,
      workspace,
      logger: logger as never,
      nowMs,
      hasOpenHandles: async () => true,
      estimateInodeCount: async () => 1,
    });

    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(0);
    expect(workspace.cleanupCompletedWorkspace).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("skips workspaces whose .forge-ready marker is too fresh", async () => {
    const tracker = makeTracker([]);
    const workspace = makeWorkspace(root);
    const wsPath = join(root, "FRG-FRESH");
    await mkdir(wsPath);
    writeFileSync(join(wsPath, ".forge-ready"), new Date().toISOString());

    const result = await runWorkspaceStartupSweep({
      workspaceRoot: root,
      tracker,
      trackerConfig,
      workspace,
      logger: logger as never,
      hasOpenHandles: async () => false,
      estimateInodeCount: async () => 1,
    });

    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(0);
    expect(workspace.cleanupCompletedWorkspace).not.toHaveBeenCalled();
  });

  it("skips workspaces that cleanup refuses to remove", async () => {
    const tracker = makeTracker([]);
    const workspace = makeWorkspace(root);
    workspace.cleanupCompletedWorkspace = vi
      .fn()
      .mockResolvedValue({ removed: false, reason: "too fresh", errors: [] });
    const wsPath = join(root, "FRG-REFUSED");
    await mkdir(wsPath);
    const nowMs = Date.now() + 25 * 60 * 60 * 1000;
    await staleMarker(wsPath, nowMs);

    const result = await runWorkspaceStartupSweep({
      workspaceRoot: root,
      tracker,
      trackerConfig,
      workspace,
      logger: logger as never,
      nowMs,
      hasOpenHandles: async () => false,
      estimateInodeCount: async () => 1,
    });

    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("logs a summary with count and approximate inodes freed", async () => {
    const tracker = makeTracker([]);
    const workspace = makeWorkspace(root);
    const wsPath = join(root, "FRG-LOG");
    await mkdir(wsPath);
    const nowMs = Date.now() + 25 * 60 * 60 * 1000;
    await staleMarker(wsPath, nowMs);

    await runWorkspaceStartupSweep({
      workspaceRoot: root,
      tracker,
      trackerConfig,
      workspace,
      logger: logger as never,
      nowMs,
      hasOpenHandles: async () => false,
      estimateInodeCount: async () => 100,
    });

    const summary = logger.info.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("startup sweep complete"),
    );
    expect(summary).toBeDefined();
    const payload = summary?.[0] as Record<string, unknown>;
    expect(payload.scanned).toBe(1);
    expect(payload.removed).toBe(1);
    expect(payload.approximateInodesFreed).toBe(100);
  });

  it("sweeps nothing when the tracker cannot be reached", async () => {
    const tracker = {
      fetchCandidates: vi.fn().mockRejectedValue(new Error("tracker down")),
    } as never;
    const workspace = makeWorkspace(root);
    const wsPath = join(root, "FRG-UNREACHABLE");
    await mkdir(wsPath);
    const nowMs = Date.now() + 25 * 60 * 60 * 1000;
    await staleMarker(wsPath, nowMs);

    const result = await runWorkspaceStartupSweep({
      workspaceRoot: root,
      tracker,
      trackerConfig,
      workspace,
      logger: logger as never,
      nowMs,
      hasOpenHandles: async () => false,
      estimateInodeCount: async () => 1,
    });

    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(0);
    expect(workspace.cleanupCompletedWorkspace).not.toHaveBeenCalled();
  });
});

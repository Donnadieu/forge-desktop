import { describe, expect, it, vi } from "vitest";
import { claimForDispatch } from "../../../src/orchestrator/claim-gate.js";
import type { NormalizedIssue, TrackerAdapter } from "../../../src/tracker/types.js";

function makeIssue(): NormalizedIssue {
  return {
    id: "issue-1",
    identifier: "FRG-1",
    title: "t",
    description: "",
    state: "Todo",
    priority: 1,
    labels: [],
    blockedBy: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

const trackerConfig = {
  kind: "memory",
  project_slug: "x",
  active_states: ["Todo"],
  terminal_states: ["Done"],
};

const silentLogger = { warn: vi.fn(), info: vi.fn() } as never;

describe("claimForDispatch", () => {
  it("does not touch the tracker when the master flag is off", async () => {
    const claimIssue = vi.fn();
    const decision = await claimForDispatch(
      { kind: "memory", claimIssue } as unknown as TrackerAdapter,
      { customWorkflows: false, trackerConfig },
      makeIssue(),
    );

    expect(decision).toEqual({ dispatch: true, claimed: false, reason: "flag-off" });
    expect(claimIssue).not.toHaveBeenCalled();
  });

  it("claims and dispatches when the flag is on and the ticket is free", async () => {
    const claimIssue = vi.fn(async () => ({ claimed: true, heldBy: "viewer-1" }));
    const decision = await claimForDispatch(
      { kind: "linear", claimIssue } as unknown as TrackerAdapter,
      {
        customWorkflows: true,
        trackerConfig,
        claimOptions: { assignee: "me", stateName: "In Progress" },
      },
      makeIssue(),
    );

    expect(decision).toEqual({ dispatch: true, claimed: true });
    expect(claimIssue).toHaveBeenCalledWith(
      { issueId: "issue-1", assignee: "me", stateName: "In Progress" },
      { activeStates: ["Todo"] },
    );
  });

  it("blocks dispatch when another agent already holds the ticket", async () => {
    const claimIssue = vi.fn(async () => ({
      claimed: false,
      heldBy: "agent-2",
      reason: "already-claimed" as const,
    }));

    const decision = await claimForDispatch(
      { kind: "linear", claimIssue } as unknown as TrackerAdapter,
      { customWorkflows: true, trackerConfig, logger: silentLogger },
      makeIssue(),
    );

    expect(decision).toEqual({ dispatch: false, reason: "already-claimed" });
  });

  it("fails closed when the claim throws", async () => {
    const claimIssue = vi.fn(async () => {
      throw new Error("linear 503");
    });

    const decision = await claimForDispatch(
      { kind: "linear", claimIssue } as unknown as TrackerAdapter,
      { customWorkflows: true, trackerConfig, logger: silentLogger },
      makeIssue(),
    );

    // Deliberately the opposite of the surrounding state re-validation, which
    // fails open: an unverified claim is not a claim.
    expect(decision).toEqual({ dispatch: false, reason: "claim-error" });
  });

  it("dispatches unclaimed when the tracker has no claim support", async () => {
    const decision = await claimForDispatch(
      { kind: "memory" } as unknown as TrackerAdapter,
      { customWorkflows: true, trackerConfig, logger: silentLogger },
      makeIssue(),
    );

    expect(decision).toEqual({
      dispatch: true,
      claimed: false,
      reason: "tracker-cannot-claim",
    });
  });
});

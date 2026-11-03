import { describe, expect, it } from "vitest";
import type { StateSnapshot } from "../../../src/observability/types.js";
import { toStateJson } from "../../../src/server/state-json.js";

function makeSnapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    generatedAt: "2026-07-04T12:00:00.000Z",
    counts: { running: 0, retrying: 0 },
    running: [],
    retrying: [],
    workspaceLocked: [],
    codexTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0,
      wallClockSeconds: 0,
    },
    progress: { total: 3, done: 3, percent: 100 },
    terminalBuildOutcome: undefined,
    rateLimits: null,
    ...overrides,
  };
}

describe("toStateJson", () => {
  it("serializes workspace_locked refusals in snake_case (FRG-5429)", () => {
    const json = toStateJson(
      makeSnapshot({
        workspaceLocked: [
          {
            issueId: "abc",
            identifier: "MT-1",
            holderPid: 42,
            holderAgentPid: null,
            holderStartedAt: "2026-07-04T11:00:00.000Z",
            markedPids: [43, 44],
            orphaned: true,
            since: "2026-07-04T11:59:00.000Z",
            reaping: false,
          },
        ],
      }),
    );
    expect(json.workspace_locked).toEqual([
      {
        issue_id: "abc",
        issue_identifier: "MT-1",
        holder_pid: 42,
        holder_agent_pid: null,
        holder_started_at: "2026-07-04T11:00:00.000Z",
        marked_pids: [43, 44],
        orphaned: true,
        since: "2026-07-04T11:59:00.000Z",
        reaping: false,
      },
    ]);
  });

  it("serializes terminal_build_outcome as null when none is set", () => {
    const json = toStateJson(makeSnapshot());
    expect(json.terminal_build_outcome).toBeNull();
  });

  it("serializes a completed terminal outcome", () => {
    const snapshot = makeSnapshot({
      terminalBuildOutcome: {
        status: "completed",
        completedAt: "2026-07-04T12:05:00.000Z",
        deploymentUrl: "https://app.example.com",
        smithUrl: "https://app-smith.fly.dev/smith/",
        ticketsCompleted: 3,
        ticketsFailed: 0,
        totalTickets: 3,
        message: null,
      },
    });
    const json = toStateJson(snapshot);
    expect(json.terminal_build_outcome).toEqual({
      status: "completed",
      completed_at: "2026-07-04T12:05:00.000Z",
      deployment_url: "https://app.example.com",
      smith_url: "https://app-smith.fly.dev/smith/",
      tickets_completed: 3,
      tickets_failed: 0,
      total_tickets: 3,
      message: null,
    });
  });

  it("serializes a failed terminal outcome", () => {
    const snapshot = makeSnapshot({
      terminalBuildOutcome: {
        status: "failed",
        completedAt: "2026-07-04T12:05:00.000Z",
        deploymentUrl: null,
        smithUrl: null,
        ticketsCompleted: 2,
        ticketsFailed: 1,
        totalTickets: 3,
        message: "1 of 3 tasks did not finish successfully.",
      },
    });
    const json = toStateJson(snapshot);
    expect(json.terminal_build_outcome).toEqual({
      status: "failed",
      completed_at: "2026-07-04T12:05:00.000Z",
      deployment_url: null,
      smith_url: null,
      tickets_completed: 2,
      tickets_failed: 1,
      total_tickets: 3,
      message: "1 of 3 tasks did not finish successfully.",
    });
  });

  // B-L4: a failed build can still carry a deployment_url (all tickets done but
  // the live preview didn't verify) — the one field-combination the handler
  // produces that neither the completed nor the null-url failed case covers.
  it("serializes a failed terminal outcome that still carries a deployment_url", () => {
    const snapshot = makeSnapshot({
      terminalBuildOutcome: {
        status: "failed",
        completedAt: "2026-07-04T12:05:00.000Z",
        deploymentUrl: "https://example.fly.dev",
        smithUrl: "https://example-smith.fly.dev/smith/",
        ticketsCompleted: 3,
        ticketsFailed: 0,
        totalTickets: 3,
        message: "The app built but the live deployment could not be verified.",
      },
    });
    const json = toStateJson(snapshot);
    expect(json.terminal_build_outcome).toEqual({
      status: "failed",
      completed_at: "2026-07-04T12:05:00.000Z",
      deployment_url: "https://example.fly.dev",
      smith_url: "https://example-smith.fly.dev/smith/",
      tickets_completed: 3,
      tickets_failed: 0,
      total_tickets: 3,
      message: "The app built but the live deployment could not be verified.",
    });
  });
});

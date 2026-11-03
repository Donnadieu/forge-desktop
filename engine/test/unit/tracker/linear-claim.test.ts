import { describe, expect, it, vi } from "vitest";
import { claimLinearIssue } from "../../../src/tracker/linear-claim.js";

const VIEWER = "viewer-1";
const OTHER = "agent-2";

interface Snapshot {
  id: string;
  assignee: { id: string } | null;
  state: { id: string; name: string } | null;
  team: { id: string } | null;
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: "issue-1",
    assignee: null,
    state: { id: "state-todo", name: "Todo" },
    team: { id: "team-1" },
    ...overrides,
  };
}

/**
 * Scripted GraphQL executor. `reads` is consumed one entry per snapshot query,
 * so a test can make the confirming re-read differ from the initial read —
 * which is the whole point of the compare-and-set.
 */
function makeGraphql(reads: Snapshot[], opts: { updateSuccess?: boolean } = {}) {
  const calls: string[] = [];
  let readIndex = 0;
  const graphql = vi.fn(async (query: string) => {
    if (query.includes("IssueClaimSnapshot")) {
      calls.push("read");
      const snap = reads[Math.min(readIndex, reads.length - 1)];
      readIndex += 1;
      return { issue: snap };
    }
    if (query.includes("IssueClaim")) {
      calls.push("write");
      return {
        issueUpdate: { success: opts.updateSuccess ?? true, issue: reads[reads.length - 1] },
      };
    }
    throw new Error(`unexpected query: ${query}`);
  });
  // Stands in for the write client's cached resolver; records the lookup so
  // tests can assert the claim state was resolved.
  const resolveStateId = vi.fn(async () => {
    calls.push("state");
    return "state-inprogress";
  });
  return { graphql: graphql as never, resolveStateId, calls };
}

const resolveAssignee = async (a: string) => (a === "me" ? VIEWER : a);

describe("claimLinearIssue", () => {
  it("claims an unassigned issue and confirms with a re-read", async () => {
    const { graphql, resolveStateId, calls } = makeGraphql([
      snapshot(),
      snapshot({ assignee: { id: VIEWER } }),
    ]);

    const result = await claimLinearIssue(graphql, resolveAssignee, resolveStateId, {
      issueId: "issue-1",
      assignee: "me",
    });

    expect(result).toEqual({ claimed: true, heldBy: VIEWER });
    // read → write → read. The trailing read is the confirmation.
    expect(calls).toEqual(["read", "write", "read"]);
  });

  it("refuses without writing when another agent already holds the issue", async () => {
    const { graphql, resolveStateId, calls } = makeGraphql([snapshot({ assignee: { id: OTHER } })]);

    const result = await claimLinearIssue(graphql, resolveAssignee, resolveStateId, {
      issueId: "issue-1",
      assignee: "me",
    });

    expect(result).toEqual({ claimed: false, heldBy: OTHER, reason: "already-claimed" });
    // The absence of "write" is the assertion that matters: a blind write here
    // would steal a ticket another agent is already working.
    expect(calls).toEqual(["read"]);
  });

  it("reports a lost race when the confirming re-read shows a different holder", async () => {
    // Both agents saw an unassigned issue; the other one wrote last.
    const { graphql, resolveStateId } = makeGraphql([
      snapshot(),
      snapshot({ assignee: { id: OTHER } }),
    ]);

    const result = await claimLinearIssue(graphql, resolveAssignee, resolveStateId, {
      issueId: "issue-1",
      assignee: "me",
    });

    expect(result).toEqual({ claimed: false, heldBy: OTHER, reason: "lost-race" });
  });

  it("re-claiming an issue we already hold is idempotent", async () => {
    const { graphql, resolveStateId } = makeGraphql([
      snapshot({ assignee: { id: VIEWER } }),
      snapshot({ assignee: { id: VIEWER } }),
    ]);

    await expect(
      claimLinearIssue(graphql, resolveAssignee, resolveStateId, {
        issueId: "issue-1",
        assignee: "me",
      }),
    ).resolves.toEqual({ claimed: true, heldBy: VIEWER });
  });

  it("refuses an issue that left the active states between poll and pickup", async () => {
    const { graphql, resolveStateId, calls } = makeGraphql([
      snapshot({ state: { id: "state-done", name: "Done" } }),
    ]);

    const result = await claimLinearIssue(
      graphql,
      resolveAssignee,
      resolveStateId,
      { issueId: "issue-1", assignee: "me" },
      { activeStates: ["Todo", "In Progress"] },
    );

    expect(result).toEqual({ claimed: false, reason: "not-active" });
    expect(calls).toEqual(["read"]);
  });

  it("moves the issue into the claim state so the claim is visible on the board", async () => {
    const { graphql, resolveStateId, calls } = makeGraphql([
      snapshot(),
      snapshot({
        assignee: { id: VIEWER },
        state: { id: "state-inprogress", name: "In Progress" },
      }),
    ]);

    await claimLinearIssue(graphql, resolveAssignee, resolveStateId, {
      issueId: "issue-1",
      assignee: "me",
      stateName: "In Progress",
    });

    expect(calls).toContain("state");
    const writeCall = (graphql as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(
      (c) => String(c[0]).includes("mutation IssueClaim"),
    );
    expect((writeCall?.[1] as { input: Record<string, unknown> }).input).toEqual({
      assigneeId: VIEWER,
      stateId: "state-inprogress",
    });
  });

  it("rejects when the issue cannot be found (deleted between poll and pickup)", async () => {
    // A missing issue is "we do not know", not "claimed by someone" — it must
    // reject so the fail-closed dispatch skips it rather than proceed.
    const graphql = vi.fn(async () => ({ issue: null })) as never;
    const resolveStateId = vi.fn(async () => "state-x");

    await expect(
      claimLinearIssue(graphql, resolveAssignee, resolveStateId, {
        issueId: "gone-1",
        assignee: "me",
      }),
    ).rejects.toThrow(/not found/);
  });

  it("throws rather than reporting a refusal when the mutation itself fails", async () => {
    const { graphql, resolveStateId } = makeGraphql([snapshot()], { updateSuccess: false });

    // A failed write is "we do not know who holds it", which callers must be
    // able to tell apart from "someone else holds it".
    await expect(
      claimLinearIssue(graphql, resolveAssignee, resolveStateId, {
        issueId: "issue-1",
        assignee: "me",
      }),
    ).rejects.toThrow(/success=false/);
  });
});

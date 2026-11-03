/**
 * Linear ticket claiming (FRG-1988).
 *
 * The acceptance bar is "no two agents ever hold the same ticket". Linear's
 * GraphQL API has no conditional update — no `issueUpdate(... if assignee is
 * null)` — so exclusivity cannot be delegated to the server. What this module
 * does instead is a compare-and-set:
 *
 *   1. read the current assignee/state,
 *   2. refuse immediately if someone else already holds it,
 *   3. write the claim,
 *   4. **re-read** and confirm we are still the holder.
 *
 * Step 4 is the load-bearing one. Two agents that pass step 2 concurrently both
 * write; the re-read lets a claimant notice it lost *when* its confirming read
 * follows the other's write. It is not a perfect mutual exclusion: it narrows
 * the window, it does not close it (see the residual-interleave note at the
 * re-read below). Callers treat an unconfirmed claim as no claim (fail closed).
 *
 * PRECONDITION (FRG-1988): every concurrent claimant must resolve to a
 * *distinct* tracker identity. Two Forge processes sharing one Linear API key
 * both resolve `assignee:"me"` to the same viewer id, so both re-reads see that
 * shared id and both believe they won — the compare-and-set cannot tell them
 * apart. Concurrent pollers must therefore run under distinct Linear
 * identities; this is documented in `docs/merge-queue.md`.
 */

import type { LinearGraphQLExecutor } from "./linear-writes.js";
import type { ClaimIssueArgs, ClaimResult } from "./types.js";

interface ClaimSnapshot {
  id: string;
  assignee: { id: string } | null;
  state: { id: string; name: string } | null;
  team: { id: string } | null;
}

const CLAIM_SNAPSHOT_QUERY = `query IssueClaimSnapshot($id: String!) {
  issue(id: $id) {
    id
    assignee { id }
    state { id name }
    team { id }
  }
}`;

const CLAIM_MUTATION = `mutation IssueClaim($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id assignee { id } state { id name } }
  }
}`;

async function readSnapshot(
  graphql: LinearGraphQLExecutor,
  issueId: string,
): Promise<ClaimSnapshot> {
  const data = await graphql<{ issue: ClaimSnapshot | null }>(CLAIM_SNAPSHOT_QUERY, {
    id: issueId,
  });
  if (!data.issue) {
    throw new Error(`Linear issue "${issueId}" not found while claiming`);
  }
  return data.issue;
}

/**
 * Claim `args.issueId` for `args.assignee`, resolving `"me"` through
 * `resolveAssignee` and any target state through `resolveStateId` (the write
 * client's per-team cached resolver). See the module comment for why this is
 * read → write → re-read rather than a single mutation.
 */
export async function claimLinearIssue(
  graphql: LinearGraphQLExecutor,
  resolveAssignee: (assignee: string) => Promise<string>,
  resolveStateId: (teamId: string, name: string) => Promise<string>,
  args: ClaimIssueArgs,
  options?: { activeStates?: string[] },
): Promise<ClaimResult> {
  const assigneeId = await resolveAssignee(args.assignee);
  const before = await readSnapshot(graphql, args.issueId);

  // Someone else is already on it. Do not write — a blind write here is
  // exactly the ticket-stealing behavior this feature exists to prevent.
  if (before.assignee && before.assignee.id !== assigneeId) {
    return { claimed: false, heldBy: before.assignee.id, reason: "already-claimed" };
  }

  // A ticket that has moved out of the dispatchable set between poll and
  // pickup is not ours to take, even though nobody holds it.
  const activeStates = options?.activeStates;
  if (activeStates?.length && before.state && !activeStates.includes(before.state.name)) {
    return { claimed: false, reason: "not-active" };
  }

  const input: Record<string, unknown> = { assigneeId };
  if (args.stateName && before.team && before.state?.name !== args.stateName) {
    input.stateId = await resolveStateId(before.team.id, args.stateName);
  }

  const updated = await graphql<{
    issueUpdate: { success: boolean; issue: ClaimSnapshot | null };
  }>(CLAIM_MUTATION, { id: args.issueId, input });
  if (!updated.issueUpdate.success) {
    throw new Error(`Linear issueUpdate returned success=false claiming "${args.issueId}"`);
  }

  // Confirming re-read. The mutation's own echo is not enough: it reflects our
  // write, not the winner of a concurrent one. Residual window: with the
  // interleave write-A → reread-A → write-B → reread-B, A confirms before B
  // overwrites and both return claimed:true. Distinct claimant identities (see
  // the module precondition) are what make this re-read a real check.
  const after = await readSnapshot(graphql, args.issueId);
  if (after.assignee?.id !== assigneeId) {
    return {
      claimed: false,
      heldBy: after.assignee?.id,
      reason: "lost-race",
    };
  }
  return { claimed: true, heldBy: assigneeId };
}

/**
 * Basecamp to-do claiming, mirroring `linear-claim.ts`'s compare-and-set
 * pattern exactly (design doc, "Collision-avoidance (claim) — final
 * recommendation"). Basecamp has the same structural limitation as Linear:
 * no conditional/optimistic-lock update in its API — `PUT todos/{id}.json`
 * always wins, whoever sends it last. What this module does instead:
 *
 *   1. read the to-do's current assignee list,
 *   2. refuse immediately (no write) if anyone other than our own identity
 *      already holds it,
 *   3. write the claim (assignee_ids set to ourselves),
 *   4. **re-read** and confirm we are still the sole holder.
 *
 * Step 4 is the load-bearing one, with the same residual-interleave caveat
 * `linear-claim.ts` documents: two agents that pass step 2 concurrently both
 * write, and the re-read only narrows (does not close) the race window.
 *
 * Divergence from Linear worth flagging explicitly: Linear's claim mutation
 * can move the issue's workflow state in the same write as the assignment
 * (`ClaimIssueArgs.stateName`). A Basecamp Card Table card is a single
 * object that is natively both assignable (its own `assignees` field) and
 * stage-tracked (its column) — confirmed live against a real card in
 * ConstructEase's Basecamp, which shows an `assignees` array directly on the
 * card payload. An earlier version of this adapter assumed Basecamp had no
 * such combined resource and worked around it with a `cardId:todoId`
 * compound id and an HTML-comment marker; that premise was wrong, and the
 * workaround has been removed (see `basecamp.ts`'s header comment and
 * `basecamp-normalize.ts`). This module now reads/writes the card's own
 * `assignee_ids` directly — "who holds it" (assignment) and "what stage it's
 * in" (column) are still deliberately orthogonal writes (claim never moves
 * the column; callers that also want a state move on claim call
 * `updateIssueState` separately), they just both happen to live on the same
 * underlying object now.
 *
 * PRECONDITION, same as Linear's (`docs/merge-queue.md`): every concurrent
 * claimant must resolve to a *distinct* Basecamp identity. The design doc's
 * flagged gap #2 is exactly this — Forge needs its own dedicated Basecamp
 * person, not Omar's, or Forge cannot tell "Omar is doing this by hand" from
 * "Forge already claimed this", and reusing one shared identity across two
 * concurrent Forge processes makes this compare-and-set unable to tell them
 * apart either.
 */
import type { BasecampExecutor } from "./basecamp.js";
import type { ClaimIssueArgs, ClaimIssueOptions, ClaimResult } from "./types.js";

interface RawBasecampCardAssignees {
  id: number;
  assignees: Array<{ id: number }> | null;
  // See basecamp-normalize.ts: Basecamp's real API nests this under
  // `parent`, not `column`.
  parent: { title: string } | null;
}

async function readCard(
  executor: BasecampExecutor,
  bucketId: string,
  cardId: string,
): Promise<RawBasecampCardAssignees> {
  const { data } = await executor<RawBasecampCardAssignees>(
    "GET",
    `/buckets/${bucketId}/card_tables/cards/${cardId}.json`,
  );
  return data;
}

/**
 * Claim `args.issueId` (the card's own Basecamp id — see `basecamp-normalize.ts`
 * for why no compound id is needed) for `args.assignee`, resolving `"me"`
 * through `resolveAssignee` (the tracker's own `identityId`, no API round
 * trip needed — Basecamp has no equivalent to Linear's `viewer` query since
 * Forge's identity is configured, not discovered). See the module comment
 * for why this is read → write → re-read rather than a single mutation.
 */
export async function claimBasecampIssue(
  executor: BasecampExecutor,
  bucketId: string,
  resolveAssignee: (assignee: string) => Promise<string>,
  args: ClaimIssueArgs,
  options?: ClaimIssueOptions,
): Promise<ClaimResult> {
  const cardId = args.issueId;
  const assigneeId = await resolveAssignee(args.assignee);
  const beforeCard = await readCard(executor, bucketId, cardId);
  const before = (beforeCard.assignees ?? []).map((a) => String(a.id));

  // Someone else is already on it. Do not write — a blind write here is
  // exactly the ticket-stealing behavior this feature exists to prevent.
  const otherHolder = before.find((id) => id !== assigneeId);
  if (otherHolder) {
    return { claimed: false, heldBy: otherHolder, reason: "already-claimed" };
  }

  // A card that has moved out of the dispatchable column set between poll
  // and pickup is not ours to take, even though nobody holds it.
  if (options?.activeStates?.length) {
    const columnTitle = beforeCard.parent?.title ?? null;
    if (columnTitle && !options.activeStates.includes(columnTitle)) {
      return { claimed: false, reason: "not-active" };
    }
  }

  const nextAssigneeIds = Array.from(new Set([...before, assigneeId]));
  await executor("PUT", `/buckets/${bucketId}/card_tables/cards/${cardId}.json`, {
    assignee_ids: nextAssigneeIds.map(Number),
  });

  // Confirming re-read. The write's own request body is not enough: it
  // reflects our write, not the winner of a concurrent one. Residual window:
  // with the interleave write-A -> reread-A -> write-B -> reread-B, A confirms
  // before B overwrites and both return claimed:true. Distinct claimant
  // identities (see the module precondition) are what make this re-read real.
  const afterCard = await readCard(executor, bucketId, cardId);
  const after = (afterCard.assignees ?? []).map((a) => String(a.id));
  const otherAfterWrite = after.find((id) => id !== assigneeId);
  if (otherAfterWrite) {
    return { claimed: false, heldBy: otherAfterWrite, reason: "lost-race" };
  }
  return { claimed: true, heldBy: assigneeId };
}

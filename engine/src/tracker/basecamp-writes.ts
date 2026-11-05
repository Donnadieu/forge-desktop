import type { BasecampExecutor } from "./basecamp.js";
import { type BasecampStageName, resolveStage } from "./basecamp-normalize.js";
import type { IssueComment } from "./types.js";

/**
 * Write helpers injected by `BasecampTracker`. Decouples write logic from the
 * tracker's private fetch wiring so this file can stay test-friendly and
 * within the architecture's per-file size budget — the same split
 * `linear-writes.ts` uses for Linear's mutation helpers.
 *
 * ## Moving a card: why not a plain PUT
 *
 * `moveCard` uses Basecamp's dedicated `POST /card_tables/:id/moves.json`
 * endpoint, not a PUT on the card resource with a `column_id` body field.
 * Verified against the live API: a bare `PUT .../cards/:id.json` with
 * `{column_id}` silently no-ops (200, column unchanged) or 400s, depending
 * on the source column's underlying Basecamp archetype. Basecamp's Kanban
 * columns carry a `type` distinct from their (renamable) display `title` —
 * e.g. a project's own "Backlog" column may really be Basecamp's built-in
 * `Kanban::Triage` type under the hood, and moving a card *out* of a
 * Triage/NotNow-archetype column needs the real move endpoint; moving *into*
 * one happens to tolerate the plain PUT, which is why this went unnoticed
 * until a bulk move out of such a column was attempted for real.
 */
export class BasecampWriteClient {
  constructor(
    private readonly executor: BasecampExecutor,
    private readonly bucketId: string,
    private readonly columns: Partial<Record<BasecampStageName, string>>,
    private readonly cardTableId: string,
  ) {}

  /**
   * Move an issue's card to the Basecamp column matching `stateName` (design
   * doc, "State mapping"). `stateName` may fold through any of Done's
   * terminal aliases (`Closed`/`Cancelled`/`Canceled`/`Duplicate`) — see
   * `resolveStage`.
   *
   * A card reaching `Done` is itself the completion signal — there is no
   * separate to-do to mark complete. See `basecamp.ts`'s header comment for
   * why: a Forge-scoped card is natively assignable and stage-tracked in one
   * object, so moving its column IS the writeback; nothing else needs
   * updating.
   */
  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    const cardId = issueId;
    const stage = resolveStage(stateName);
    if (!stage) {
      throw new Error(
        `Unknown Basecamp pipeline stage "${stateName}". Expected one of the WORKFLOW.md stages (or a Done alias: Closed/Cancelled/Canceled/Duplicate).`,
      );
    }
    const columnId = this.columns[stage];
    if (!columnId) {
      throw new Error(
        `No Basecamp column id configured for stage "${stage}" — the dedicated Forge Card Table must have a column for every WORKFLOW.md stage before this adapter can move cards.`,
      );
    }

    await this.moveCard(cardId, columnId);
  }

  async moveCard(cardId: string, columnId: string): Promise<void> {
    if (!this.cardTableId) {
      throw new Error(
        "No Basecamp card_table_id configured — required to move a card (see basecamp-writes.ts's header comment for why a bare card PUT is not enough).",
      );
    }
    // Always insert at the top of the destination column (position 0).
    // Forge does not depend on a card's position within a column for any
    // dispatch/priority decision (see WORKFLOW.md: ordering is derived from
    // active_states' order, not card position), so an arbitrary fixed
    // position is fine here.
    await this.executor("POST", `/card_tables/${this.cardTableId}/moves.json`, {
      source_id: Number(cardId),
      target_id: Number(columnId),
      position: 0,
    });
  }

  /**
   * Release a claim without finishing the work (design doc, "Writeback",
   * step 3) — on a failure path where Forge gives up rather than finishes,
   * unassign so the card returns to the dispatchable pool instead of
   * looking permanently claimed by a dead run. Not part of `TrackerAdapter`
   * (no other adapter exposes an explicit un-claim), but Basecamp's own
   * writeback contract calls for it, so it is exposed as an adapter-specific
   * extra method the orchestrator's failure path can call directly.
   */
  async unassignIssue(issueId: string): Promise<void> {
    const cardId = issueId;
    await this.executor("PUT", `/buckets/${this.bucketId}/card_tables/cards/${cardId}.json`, {
      assignee_ids: [],
    });
  }

  /**
   * Post a comment on the issue's card (design doc, "Writeback", step 1 —
   * comment first, before moving to Done, so a finished-but-uncommented card
   * never ships with no trace of what Forge did). Basecamp comments attach
   * to a "recording" — cards are recordings too, so this posts directly to
   * the card's own recording id, no linked to-do required.
   */
  async createComment(issueId: string, body: string): Promise<string> {
    const cardId = issueId;
    const { data } = await this.executor<{ id: number }>(
      "POST",
      `/buckets/${this.bucketId}/recordings/${cardId}/comments.json`,
      { content: body },
    );
    return String(data.id);
  }

  async fetchIssueComments(issueId: string): Promise<IssueComment[]> {
    const cardId = issueId;
    const { data } = await this.executor<
      Array<{ id: number; content: string; created_at: string }>
    >("GET", `/buckets/${this.bucketId}/recordings/${cardId}/comments.json`);
    return data.map((c) => ({ id: String(c.id), body: c.content, createdAt: c.created_at }));
  }
}

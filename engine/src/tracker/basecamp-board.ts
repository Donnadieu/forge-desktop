/**
 * Every card in the Card Table's columns, for the app's board. Unlike
 * fetchCandidates (which reads only the columns agents work and swallows
 * errors), this reads all the board's columns and throws, so the board can say
 * "couldn't reach Basecamp" instead of showing an empty board.
 *
 * Basecamp cards have no labels and no pull request field: Backlog cards get
 * their labels from `Label:` lines in their comments (the triage marker), and
 * cards past Todo get their pull request from their content or comments. Both
 * need one comments read per card, so the result is kept per card until the
 * card or its comment count changes.
 *
 * New in Forge Desktop.
 */
import type { BasecampExecutor } from "./basecamp.js";
import {
  type BasecampStageName,
  extractLabels,
  extractPrUrl,
  PR_LOOKUP_STAGES,
  type RawBasecampCard,
  resolveStage,
} from "./basecamp-normalize.js";
import { paginateBasecamp } from "./basecamp-paginate.js";
import type { BoardCard } from "./types.js";

type ColumnMap = Partial<Record<BasecampStageName, string>>;

interface CommentFacts {
  key: string;
  labels: string[];
  prUrl: string | null;
}

export class BasecampBoard {
  private readonly facts = new Map<string, CommentFacts>();

  constructor(
    private readonly executor: BasecampExecutor,
    private readonly bucketId: string,
    private readonly columns: ColumnMap,
  ) {}

  async read(states: string[]): Promise<BoardCard[]> {
    if (!this.bucketId) throw new Error("Basecamp project (bucket) id is required");
    const out: BoardCard[] = [];
    const seen = new Set<string>();
    for (const name of states) {
      const stage = resolveStage(name);
      const columnId = stage ? this.columns[stage] : undefined;
      if (!stage || !columnId) continue;
      const cards = await paginateBasecamp<RawBasecampCard>(
        (path) =>
          this.executor<RawBasecampCard[]>("GET", path).then((r) => ({
            items: r.data,
            nextPath: r.nextPath,
          })),
        `/buckets/${this.bucketId}/card_tables/lists/${columnId}/cards.json`,
      );
      const board = await Promise.all(cards.map((card) => this.toBoardCard(card, stage)));
      out.push(...board);
      for (const c of cards) seen.add(String(c.id));
    }
    for (const id of this.facts.keys()) if (!seen.has(id)) this.facts.delete(id);
    return out;
  }

  private async toBoardCard(card: RawBasecampCard, stage: BasecampStageName): Promise<BoardCard> {
    const wantsLabels = stage === "Backlog";
    const wantsPr = PR_LOOKUP_STAGES.has(stage);
    let labels: string[] = [];
    let prUrl = extractPrUrl(card.content) ?? null;
    if ((wantsLabels || (wantsPr && !prUrl)) && (card.comments_count ?? 1) > 0) {
      const facts = await this.commentFacts(card);
      if (wantsLabels) labels = facts.labels;
      if (wantsPr && !prUrl) prUrl = facts.prUrl;
    }
    const assignee = card.assignees?.[0];
    return {
      id: String(card.id),
      identifier: `BC-${card.id}`,
      title: card.title,
      // The stage the card's column is mapped to, so a renamed column still lands right.
      state: stage,
      url: card.app_url ?? null,
      assignee: assignee ? assignee.name : null,
      branchName: `basecamp/bc-${card.id}`,
      prUrl,
      priority: null,
      updatedAt: card.updated_at ?? "",
      labels,
      blockedBy: [],
    };
  }

  /** Labels and the pull request from the card's comments; read again only when the card changed. */
  private async commentFacts(card: RawBasecampCard): Promise<CommentFacts> {
    const id = String(card.id);
    const key = `${card.updated_at ?? ""}:${card.comments_count ?? ""}`;
    const known = this.facts.get(id);
    if (known && known.key === key) return known;
    const comments = await paginateBasecamp<{ content?: string | null }>(
      (path) =>
        this.executor<Array<{ content?: string | null }>>("GET", path).then((r) => ({
          items: r.data,
          nextPath: r.nextPath,
        })),
      `/buckets/${this.bucketId}/recordings/${id}/comments.json`,
    );
    const bodies = comments.map((c) => c.content ?? "");
    const facts: CommentFacts = {
      key,
      labels: Array.from(new Set(bodies.flatMap(extractLabels))),
      prUrl: bodies.map(extractPrUrl).find(Boolean) ?? null,
    };
    this.facts.set(id, facts);
    return facts;
  }
}

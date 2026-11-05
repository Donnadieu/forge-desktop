import { createLogger } from "../observability/logger.js";
import type { BasecampExecutor } from "./basecamp.js";
import {
  type BasecampStageName,
  extractLabels,
  extractPrUrl,
  LABEL_LOOKUP_STAGES,
  normalizeBasecampCard,
  PR_LOOKUP_STAGES,
  type RawBasecampCard,
  resolveStages,
} from "./basecamp-normalize.js";
import { paginateBasecamp } from "./basecamp-paginate.js";
import type { NormalizedIssue, ProgressCounts, TrackerConfig } from "./types.js";

const log = createLogger({ level: "warn", pretty: false });

type ColumnMap = Partial<Record<BasecampStageName, string>>;

/**
 * Best-effort: read the bodies of a card's comments. One failure (network,
 * 404, rate limit) must not fail the whole poll — it returns `[]`, leaving
 * whatever the caller derives from comments unset, same posture as
 * `fetchIssueStatesByIds`.
 */
async function fetchCommentBodies(
  executor: BasecampExecutor,
  bucketId: string,
  cardId: string,
): Promise<string[]> {
  try {
    const { data } = await executor<Array<{ content: string }>>(
      "GET",
      `/buckets/${bucketId}/recordings/${cardId}/comments.json`,
    );
    return data.map((comment) => comment.content);
  } catch (error) {
    log.warn({ err: error, cardId }, "Basecamp comments lookup failed for one card");
    return [];
  }
}

/**
 * Fill in `existingPrUrl` from comments — a GitHub PR link a different
 * process/bot/human may have attached before Forge ever dispatched the card
 * (see `NormalizedIssue.existingPrUrl`) — for any issue that doesn't already
 * have one from its own card body, limited to stages where a PR is
 * plausible (`PR_LOOKUP_STAGES`) to keep the extra per-card API call bounded.
 */
async function enrichWithExistingPrUrls(
  executor: BasecampExecutor,
  bucketId: string,
  issues: NormalizedIssue[],
): Promise<NormalizedIssue[]> {
  await Promise.all(
    issues.map(async (issue) => {
      if (issue.existingPrUrl) return;
      if (!PR_LOOKUP_STAGES.has(issue.state as BasecampStageName)) return;
      const bodies = await fetchCommentBodies(executor, bucketId, issue.id);
      issue.existingPrUrl = bodies.map(extractPrUrl).find(Boolean);
    }),
  );
  return issues;
}

/**
 * Fill in `labels` from comment `Label:` lines (see `extractLabels`) for
 * cards in `LABEL_LOOKUP_STAGES`. `issues[i]` must be the normalized
 * `cards[i]`; a card whose list entry reports zero comments is skipped
 * without a fetch.
 */
async function enrichWithCommentLabels(
  executor: BasecampExecutor,
  bucketId: string,
  cards: RawBasecampCard[],
  issues: NormalizedIssue[],
): Promise<void> {
  await Promise.all(
    issues.map(async (issue, i) => {
      if (!LABEL_LOOKUP_STAGES.has(issue.state as BasecampStageName)) return;
      if (cards[i].comments_count === 0) return;
      const bodies = await fetchCommentBodies(executor, bucketId, issue.id);
      issue.labels = Array.from(new Set(bodies.flatMap(extractLabels)));
    }),
  );
}

async function fetchColumnCards(
  executor: BasecampExecutor,
  bucketId: string,
  columnId: string,
): Promise<RawBasecampCard[]> {
  return paginateBasecamp<RawBasecampCard>(
    (path) =>
      executor<RawBasecampCard[]>("GET", path).then((r) => ({
        items: r.data,
        nextPath: r.nextPath,
      })),
    `/buckets/${bucketId}/card_tables/lists/${columnId}/cards.json`,
  );
}

/**
 * Fetch every card sitting in one of `stages`' Basecamp columns. Stages with
 * no configured column id are skipped with a warning rather than failing the
 * whole read — a partially-configured Card Table should degrade, not crash
 * the poll (same posture as Linear's try/catch-and-log-empty on failure).
 */
async function fetchCardsForStages(
  executor: BasecampExecutor,
  bucketId: string,
  columns: ColumnMap,
  stages: BasecampStageName[],
): Promise<RawBasecampCard[]> {
  const cards: RawBasecampCard[] = [];
  for (const stage of stages) {
    const columnId = columns[stage];
    if (!columnId) {
      log.warn({ stage }, "No Basecamp column id configured for stage; skipping");
      continue;
    }
    cards.push(...(await fetchColumnCards(executor, bucketId, columnId)));
  }
  return cards;
}

/**
 * Fetch dispatchable candidates: cards currently sitting in one of
 * `config.active_states`' columns. `config.assignee` is resolved by the
 * caller (the tracker already knows its own `identityId` without an API
 * round trip, unlike Linear's "me" -> viewer lookup) and passed through
 * pre-resolved.
 */
export async function fetchCandidates(
  executor: BasecampExecutor,
  bucketId: string,
  columns: ColumnMap,
  config: TrackerConfig,
  resolvedAssignee: string | undefined,
): Promise<NormalizedIssue[]> {
  if (!bucketId) {
    throw new Error("Basecamp project (bucket) id is required");
  }
  try {
    const stages = resolveStages(config.active_states);
    const cards = await fetchCardsForStages(executor, bucketId, columns, stages);
    let issues = cards.map(normalizeBasecampCard);
    await enrichWithCommentLabels(executor, bucketId, cards, issues);
    if (resolvedAssignee) {
      issues = issues.filter((i) => i.assignee === resolvedAssignee);
    }
    issues = await enrichWithExistingPrUrls(executor, bucketId, issues);
    return issues;
  } catch (error) {
    log.warn({ err: error }, "Basecamp fetchCandidates failed");
    return [];
  }
}

/**
 * Fetch terminal-state cards (folded into the single `Done` column; see
 * `resolveStages`). Used by the reconciler to find cards that reached a
 * done/cancelled state and mirror that status locally.
 */
export async function fetchTerminalIssues(
  executor: BasecampExecutor,
  bucketId: string,
  columns: ColumnMap,
  config: TrackerConfig,
): Promise<NormalizedIssue[]> {
  if (!bucketId) {
    throw new Error("Basecamp project (bucket) id is required");
  }
  try {
    const stages = resolveStages(config.terminal_states);
    const cards = await fetchCardsForStages(executor, bucketId, columns, stages);
    return cards.map(normalizeBasecampCard);
  } catch (error) {
    log.warn({ err: error }, "Basecamp fetchTerminalIssues failed");
    return [];
  }
}

/**
 * Count the project's build-scoped cards straight from Basecamp: `total` is
 * every card in a column within `active_states` ∪ `terminal_states`, `done`
 * is the terminal (`Done`-folded) subset. Basecamp is the source of truth, so
 * this is a fresh read with no local counter — mirrors `linear-progress.ts`.
 * Throws on error so the caller can keep its prior reading instead of
 * blanking the bar on a transient blip.
 */
export async function fetchProgressCounts(
  executor: BasecampExecutor,
  bucketId: string,
  columns: ColumnMap,
  config: TrackerConfig,
): Promise<ProgressCounts> {
  if (!bucketId) {
    throw new Error("Basecamp project (bucket) id is required");
  }
  const activeStages = resolveStages(config.active_states);
  const terminalStages = resolveStages(config.terminal_states);
  const scopeStages = Array.from(new Set([...activeStages, ...terminalStages]));
  const terminalSet = new Set(terminalStages);

  const cards = await fetchCardsForStages(executor, bucketId, columns, scopeStages);

  let total = 0;
  let done = 0;
  for (const card of cards) {
    total += 1;
    const title = card.parent?.title;
    if (title && terminalSet.has(title as BasecampStageName)) done += 1;
  }
  return { total, done };
}

/**
 * Fetch the current column title (pipeline state) for each of `ids` (each a
 * card's own Basecamp id, see `basecamp-normalize.ts`). Best-effort per id:
 * a single card lookup failure drops that id from the result map rather than
 * failing the whole batch.
 */
export async function fetchIssueStatesByIds(
  executor: BasecampExecutor,
  bucketId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();

  const result = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const { data } = await executor<RawBasecampCard>(
          "GET",
          `/buckets/${bucketId}/card_tables/cards/${id}.json`,
        );
        if (data.parent?.title) result.set(id, data.parent.title);
      } catch (error) {
        log.warn({ err: error, id }, "Basecamp fetchIssueStatesByIds failed for one id");
      }
    }),
  );
  return result;
}

import type { NormalizedIssue } from "./types.js";

/**
 * Forge's real internal pipeline stages (`WORKFLOW.md`), 1:1 with the ten
 * columns a dedicated Forge Card Table must have per project (design doc
 * `docs/design-docs/004-basecamp-task-source.md`, "State mapping — superseded
 * by Card Table columns"). `updateIssueState` resolves a tracker-facing state
 * name to one of these before looking up the column id to move a card into.
 */
export const BASECAMP_STAGE_NAMES = [
  "Backlog",
  "Triage",
  "Todo",
  "In Progress",
  "AI Review",
  "QA",
  "Human Review",
  "Rework",
  "Merging",
  "Done",
] as const;

export type BasecampStageName = (typeof BASECAMP_STAGE_NAMES)[number];

/**
 * Terminal-state spellings that all fold into the single `Done` column —
 * Basecamp "has no reason to split these into separate columns" per the
 * design doc. `updateIssueState("issue-1", "Cancelled")` and
 * `updateIssueState("issue-1", "Done")` both resolve to the same column.
 */
const DONE_FOLD_ALIASES = ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"];

/**
 * Stages where a card may plausibly already carry a PR opened by a process
 * other than Forge (another engineer, a different bot) before Forge ever
 * saw it — e.g. a migrated card dropped straight into `AI Review` with its
 * build already done. Only these stages are worth the extra comments fetch
 * in `fetchCandidates`; earlier stages (`Backlog`, `Triage`, `Todo`) never
 * have a PR yet, so skipping them keeps the per-poll API cost down.
 */
export const PR_LOOKUP_STAGES: ReadonlySet<BasecampStageName> = new Set([
  "In Progress",
  "AI Review",
  "QA",
  "Human Review",
  "Rework",
  "Merging",
]);

/**
 * Stages where `fetchCandidates` reads a card's comments for label marker
 * lines (see `extractLabels`). Only `Backlog`: it is where a triaged card
 * waits with its `ready-for-execution` marker for the backlog promotion
 * sweep (`orchestrator/backlog-promotion.ts`). Active stages skip the extra
 * per-card comments fetch.
 */
export const LABEL_LOOKUP_STAGES: ReadonlySet<BasecampStageName> = new Set(["Backlog"]);

const LABEL_LINE = /^\s*labels?:\s*([a-z0-9][\w-]*(?:\s*,\s*[a-z0-9][\w-]*)*)/gim;

/**
 * Pull label names out of a comment's `Label: <name>` lines. Basecamp cards
 * have no native label field, so the workflow's "add the
 * `ready-for-execution` label" step is written as a line in the card's
 * `## Forge Triage` comment instead, e.g.
 * `<p><strong>Label:</strong> <code>ready-for-execution</code> (…)</p>`.
 * HTML tags are dropped first; the line must START with `Label:` (or
 * `Labels:`, comma-separated), so prose that merely mentions a label does
 * not count. Names come back lowercased.
 */
export function extractLabels(text: string | null | undefined): string[] {
  if (!text) return [];
  // Basecamp keeps rich text as HTML with no line breaks between blocks, so a
  // block's end (and <br>) is a new line; other tags just drop.
  const plain = text
    .replace(/<br\s*\/?>|<\/(?:p|div|h[1-6]|li|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  const labels: string[] = [];
  for (const match of plain.matchAll(LABEL_LINE)) {
    for (const name of match[1].split(",")) labels.push(name.trim().toLowerCase());
  }
  return labels;
}

/**
 * Pull the first GitHub pull-request URL out of free text (HTML card content
 * or a plain-text comment body). Matches `github.com/<org>/<repo>/pull/<n>`
 * with an optional `https://` scheme and tolerates trailing HTML like
 * `</p>` or a closing `"` from an `<a href="...">` tag right after the URL.
 */
export function extractPrUrl(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const match = text.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
  return match?.[0];
}

/**
 * Resolve an arbitrary tracker-facing state name (case-insensitive) to one of
 * the ten canonical Forge pipeline stages, folding any terminal spelling
 * variant into `"Done"`. Returns null when the name matches nothing — callers
 * decide whether that is an error or a silent skip.
 */
export function resolveStage(stateName: string): BasecampStageName | null {
  const lower = stateName.trim().toLowerCase();
  if (DONE_FOLD_ALIASES.some((alias) => alias.toLowerCase() === lower)) {
    return "Done";
  }
  return BASECAMP_STAGE_NAMES.find((stage) => stage.toLowerCase() === lower) ?? null;
}

/**
 * Resolve a list of tracker-facing state names to the distinct set of
 * canonical pipeline stages they represent (folding Done's aliases together
 * and dropping anything unrecognized, in encounter order).
 */
export function resolveStages(stateNames: string[]): BasecampStageName[] {
  const seen = new Set<BasecampStageName>();
  for (const name of stateNames) {
    const stage = resolveStage(name);
    if (stage) seen.add(stage);
  }
  return Array.from(seen);
}

export interface RawBasecampCard {
  id: number;
  title: string;
  content: string | null;
  assignees: Array<{ id: number; name: string }> | null;
  app_url: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** Lets label lookup skip the comments fetch for a card with none. */
  comments_count?: number;
  // Basecamp's real API nests the owning column under `parent`, not
  // `column` — verified directly against the live API (card list and
  // single-card detail endpoints both return `parent`, never `column`).
  parent: { id: number; title: string } | null;
}

/**
 * Normalize a Basecamp Card Table card into a `NormalizedIssue`. Every
 * candidate/terminal issue Forge sees from Basecamp is a card (not a bare
 * to-do) — cards are the stage tracker; a card only exists once a to-do has
 * been deliberately scoped into Forge's work (design doc, "Scope, don't
 * convert the whole backlog").
 *
 * The card's own id IS the issue id (see `basecamp.ts`'s header comment for
 * why the earlier compound `cardId:todoId` id and HTML-comment marker were
 * removed) — no linking back to a to-do is needed for claim, state, or
 * comments.
 */
export function normalizeBasecampCard(card: RawBasecampCard): NormalizedIssue {
  return {
    id: String(card.id),
    identifier: `BC-${card.id}`,
    title: card.title,
    description: card.content ?? "",
    // The canonical stage name when the column title matches one (any case).
    state: card.parent ? (resolveStage(card.parent.title) ?? card.parent.title) : "",
    // No native priority field on Basecamp cards/to-dos (design doc).
    priority: null,
    assignee: card.assignees?.[0] ? String(card.assignees[0].id) : undefined,
    // No native label/tag field on Basecamp cards or to-dos (design doc,
    // verified against the CLI/API). `fetchCandidates` fills this in from
    // comment `Label:` lines for `LABEL_LOOKUP_STAGES`.
    labels: [],
    branchName: `basecamp/bc-${card.id}`,
    url: card.app_url ?? undefined,
    // Basecamp has no native blocking/relation model (design doc) — always
    // empty, and `linkIssues` is correspondingly left unimplemented.
    blockedBy: [],
    createdAt: card.created_at ?? "",
    updatedAt: card.updated_at ?? "",
    // Covers the case where the PR link was pasted straight into the card's
    // own body rather than a comment. `fetchCandidates` fills this in from
    // comments too when this is still unset and the card's stage warrants it.
    existingPrUrl: extractPrUrl(card.content),
  };
}

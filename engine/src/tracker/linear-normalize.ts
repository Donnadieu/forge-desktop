import type { NormalizedIssue } from "./types.js";

export interface RawLinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  branchName: string | null;
  url: string | null;
  state: { name: string } | null;
  assignee: { id: string; displayName: string } | null;
  labels: { nodes: Array<{ name: string }> } | null;
  createdAt: string | null;
  updatedAt: string | null;
  inverseRelations: {
    nodes: Array<{
      type: string;
      issue: {
        id: string;
        identifier: string;
        state: { name: string } | null;
      };
    }>;
  } | null;
}

// PITFALL: Linear returns the full inverseRelations graph regardless of which
// relation kinds we care about — filter client-side to `blocks` (the inverse
// of `blockedBy`) instead of trying to push the filter into the GraphQL arg.
export function normalizeLinearIssue(raw: RawLinearIssue): NormalizedIssue {
  const blockedBy = (raw.inverseRelations?.nodes || [])
    .filter((r) => r.type === "blocks")
    .map((r) => ({
      id: r.issue.id,
      identifier: r.issue.identifier,
      state: r.issue.state?.name || "",
    }));

  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description || "",
    state: raw.state?.name || "",
    priority: raw.priority ?? null,
    assignee: raw.assignee?.id,
    labels: (raw.labels?.nodes || []).map((l) => l.name.toLowerCase()),
    branchName: raw.branchName || undefined,
    url: raw.url || undefined,
    blockedBy,
    createdAt: raw.createdAt || "",
    updatedAt: raw.updatedAt || "",
  };
}

/**
 * GraphQL fragments for the optional `labels` filter. Returns the partial
 * variable declaration and filter clause to splice into a query, plus the
 * normalized filter list (or `undefined` for "no filter"). Centralised so
 * `fetchCandidates` and `fetchTerminalIssues` stay in lock-step.
 *
 * Trust boundary: `varDecl` and `clause` are constants that depend ONLY on
 * whether `filter` is truthy — they never embed `labels[]` content. Label
 * values flow through GraphQL `variables`, which Linear parses safely. Do
 * not "improve" this by interpolating values into the strings; that would
 * open a GraphQL-injection vector that doesn't exist today.
 */
export function buildLabelFilterFragments(labels: string[] | undefined): {
  filter: string[] | undefined;
  varDecl: string;
  clause: string;
} {
  const filter = normalizeLabelFilter(labels);
  return {
    filter,
    varDecl: filter ? ", $labels: [String!]" : "",
    clause: filter ? "labels: { name: { in: $labels } }" : "",
  };
}

/**
 * Returns a deduped, trimmed, **lowercased** copy of `labels` when at least one
 * entry survives, or `undefined` to signal "no filter — let everything through".
 *
 * Lowercasing keeps the contract documented on `TrackerConfig.labels`
 * ("case-insensitive — adapters lowercase before comparing") consistent across
 * adapters: the memory tracker compares lowercased issue labels against this
 * filter, and the Linear adapter sends the lowercased list to Linear's
 * `labels.name.in` GraphQL filter. Linear's filter is case-sensitive on the
 * server, so this requires the actual workspace labels to be lowercase — which
 * matches the Smith convention (`smith_feature`/`smith_bug`).
 *
 * Callers may pass an empty array to mean "no filter" without surprising
 * behavior.
 */
export function normalizeLabelFilter(labels: string[] | undefined): string[] | undefined {
  if (!labels || labels.length === 0) return undefined;
  const cleaned = Array.from(
    new Set(labels.map((l) => l.trim().toLowerCase()).filter((l) => l.length > 0)),
  );
  return cleaned.length > 0 ? cleaned : undefined;
}

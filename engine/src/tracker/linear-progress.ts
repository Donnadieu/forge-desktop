import { buildLabelFilterFragments } from "./linear-normalize.js";
import { type LinearConnection, paginateConnection } from "./linear-paginate.js";
import { linearScope } from "./linear-scope.js";
import type { LinearGraphQLExecutor } from "./linear-writes.js";
import type { ProgressCounts, TrackerConfig } from "./types.js";

/**
 * The lean `state.name`-only projection lets us afford a larger page than the
 * full-issue reads (`fetchCandidates`/`fetchTerminalIssues` use 50).
 */
const PROGRESS_PAGE_SIZE = 100;

interface ProgressNode {
  state: { name: string } | null;
}

/**
 * Count the project's build-scoped tickets straight from Linear: `total` is
 * every issue in the project that is in an active or terminal build state
 * (within the configured label scope), `done` is the terminal subset. One
 * paginated read of just `state.name` — Linear is the source of truth for the
 * build's progress, so there is no local counter.
 *
 * Tickets parked in states outside the build pipeline (e.g. "Backlog",
 * "Human Review") are excluded from `total` so the progress bar reflects only
 * the work this build is responsible for. Throws on error so the caller can
 * keep its prior reading instead of blanking the bar on a transient blip.
 *
 * There is deliberately no monotonic guard: whatever Linear reports this poll
 * wins, even if it is lower than before. Linear list reads are eventually
 * consistent, so a successful-but-partial read may briefly shrink the bar; that
 * is accepted because the count is cosmetic and self-heals on the next poll —
 * re-adding a guard here would resurrect the stuck-bar bug this replaced.
 */
export async function fetchProgressCounts(
  graphql: LinearGraphQLExecutor,
  config: TrackerConfig,
): Promise<ProgressCounts> {
  const scope = linearScope(config);

  const terminal = new Set(config.terminal_states);
  // Build scope = states the orchestrator dispatches from or considers terminal.
  // This keeps Backlog / Human Review / triage tickets from inflating the bar.
  const scopeStates = new Set([...config.active_states, ...config.terminal_states]);
  const labelFragments = buildLabelFilterFragments(config.labels);
  const stateNames = Array.from(scopeStates);
  const query = `
    query FetchProgressCounts(${scope.varDecl}, $states: [String!]!, $first: Int!, $after: String${labelFragments.varDecl}) {
      issues(
        filter: {
          ${scope.clause}
          state: { name: { in: $states } }
          ${labelFragments.clause}
        }
        first: $first
        after: $after
      ) {
        nodes { state { name } }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const baseVariables: Record<string, unknown> = {
    ...scope.variables,
    states: stateNames,
  };
  if (labelFragments.filter) baseVariables.labels = labelFragments.filter;

  const nodes = await paginateConnection<{ issues: LinearConnection<ProgressNode> }, ProgressNode>(
    graphql,
    query,
    baseVariables,
    (data) => data.issues,
    PROGRESS_PAGE_SIZE,
  );

  let total = 0;
  let done = 0;
  for (const node of nodes) {
    total += 1;
    // `state` is nullable in Linear's schema (draft/triage issues); a null-state
    // ticket is still a real ticket, so it counts toward `total` but not `done`.
    const name = node.state?.name;
    if (name && terminal.has(name)) done += 1;
  }

  return { total, done };
}

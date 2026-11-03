import type { LinearGraphQLExecutor } from "./linear-writes.js";

export interface LinearPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

/** A Linear GraphQL connection: a page of `nodes` plus its cursor `pageInfo`. */
export interface LinearConnection<TNode> {
  nodes: TNode[];
  pageInfo: LinearPageInfo;
}

/**
 * Drive a Linear cursor-paginated connection to exhaustion and return every
 * node. The `query` must declare `$first: Int!` and `$after: String` and expose
 * `pageInfo { hasNextPage endCursor }`; `first`/`after` are managed here, while
 * `baseVariables` (slug, state/label filters, …) is sent on every page.
 *
 * Centralises the cursor bookkeeping that `fetchCandidates`,
 * `fetchTerminalIssues`, and `fetchProgressCounts` would otherwise each
 * hand-roll. Guards against a non-advancing cursor: if Linear ever reports
 * another page while returning a null or unchanged `endCursor`, the loop stops
 * instead of re-fetching the same page forever (which would wedge the caller's
 * poll).
 */
export async function paginateConnection<TData, TNode>(
  graphql: LinearGraphQLExecutor,
  query: string,
  baseVariables: Record<string, unknown>,
  selectConnection: (data: TData) => LinearConnection<TNode>,
  pageSize: number,
): Promise<TNode[]> {
  const nodes: TNode[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const variables: Record<string, unknown> = { ...baseVariables, first: pageSize };
    if (cursor) variables.after = cursor;

    const connection = selectConnection(await graphql<TData>(query, variables));
    nodes.push(...connection.nodes);

    const next = connection.pageInfo.endCursor;
    hasMore = connection.pageInfo.hasNextPage && next !== null && next !== cursor;
    cursor = next;
  }

  return nodes;
}

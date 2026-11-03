/**
 * Every card in the project's columns, for the app's board. Unlike
 * fetchCandidates (which reads only the columns agents work and swallows
 * errors), this reads all the board's columns and throws, so the board can say
 * "couldn't reach Linear" instead of showing an empty board.
 *
 * New in Forge Desktop.
 */
import { type LinearConnection, paginateConnection } from "./linear-paginate.js";
import type { LinearGraphQLExecutor } from "./linear-writes.js";
import type { BoardCard } from "./types.js";

interface RawBoardIssue {
  id: string;
  identifier: string;
  title: string;
  url?: string | null;
  priority?: number | null;
  branchName?: string | null;
  updatedAt: string;
  state: { name: string };
  assignee?: { displayName?: string | null; name?: string | null } | null;
  attachments?: { nodes: Array<{ url?: string | null; sourceType?: string | null }> } | null;
}

const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

const QUERY = `
  query BoardCards($slug: String!, $states: [String!]!, $first: Int!, $after: String) {
    issues(
      filter: { project: { slugId: { eq: $slug } }, state: { name: { in: $states } } }
      first: $first
      after: $after
    ) {
      nodes {
        id
        identifier
        title
        url
        priority
        branchName
        updatedAt
        state { name }
        assignee { displayName name }
        attachments(first: 10) { nodes { url sourceType } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export function toBoardCard(raw: RawBoardIssue): BoardCard {
  const pr = (raw.attachments?.nodes ?? [])
    .map((a) => a.url ?? "")
    .filter((u) => PR_URL.test(u))
    .pop();
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    state: raw.state.name,
    url: raw.url ?? null,
    assignee: raw.assignee?.displayName ?? raw.assignee?.name ?? null,
    branchName: raw.branchName ?? null,
    prUrl: pr ?? null,
    priority: raw.priority ?? null,
    updatedAt: raw.updatedAt,
  };
}

export async function fetchBoardCards(
  graphql: LinearGraphQLExecutor,
  slug: string,
  states: string[],
): Promise<BoardCard[]> {
  const nodes = await paginateConnection<
    { issues: LinearConnection<RawBoardIssue> },
    RawBoardIssue
  >(graphql, QUERY, { slug, states }, (data) => data.issues, 50);
  return nodes.map(toBoardCard);
}

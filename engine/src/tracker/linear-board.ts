/**
 * Every card in the project's columns, for the app's board. Unlike
 * fetchCandidates (which reads only the columns agents work and swallows
 * errors), this reads all the board's columns and throws, so the board can say
 * "couldn't reach Linear" instead of showing an empty board.
 *
 * New in Forge Desktop.
 */
import { type LinearConnection, paginateConnection } from "./linear-paginate.js";
import type { LinearScope } from "./linear-scope.js";
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
  labels?: { nodes: Array<{ name: string }> } | null;
  inverseRelations?: {
    nodes: Array<{
      type: string;
      issue?: { identifier: string; state?: { type?: string | null } | null } | null;
    }>;
  } | null;
}

/** Linear state types that mean the work is over: a blocker in one of these no longer blocks. */
const FINISHED = new Set(["completed", "canceled"]);

const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

const query = (scope: LinearScope) => `
  query BoardCards(${scope.varDecl}, $states: [String!]!, $first: Int!, $after: String) {
    issues(
      filter: { ${scope.clause}, state: { name: { in: $states } } }
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
        labels(first: 10) { nodes { name } }
        inverseRelations(first: 10) { nodes { type issue { identifier state { type } } } }
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
    labels: (raw.labels?.nodes ?? []).map((l) => l.name),
    blockedBy: (raw.inverseRelations?.nodes ?? [])
      .filter((r) => r.type === "blocks" && r.issue && !FINISHED.has(r.issue.state?.type ?? ""))
      .map((r) => r.issue?.identifier ?? ""),
  };
}

export async function fetchBoardCards(
  graphql: LinearGraphQLExecutor,
  scope: LinearScope,
  states: string[],
): Promise<BoardCard[]> {
  const nodes = await paginateConnection<
    { issues: LinearConnection<RawBoardIssue> },
    RawBoardIssue
  >(graphql, query(scope), { ...scope.variables, states }, (data) => data.issues, 50);
  return nodes.map(toBoardCard);
}

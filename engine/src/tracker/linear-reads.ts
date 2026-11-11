import { createLogger } from "../observability/logger.js";
import {
  buildLabelFilterFragments,
  normalizeLinearIssue,
  type RawLinearIssue,
} from "./linear-normalize.js";
import { type LinearConnection, paginateConnection } from "./linear-paginate.js";
import { linearScope } from "./linear-scope.js";
import type { LinearGraphQLExecutor } from "./linear-writes.js";
import type { NormalizedIssue, TrackerConfig } from "./types.js";

export interface LinearIssueRef {
  id: string;
  identifier: string;
  title: string;
  state: { name: string };
  project: { id: string } | null;
  team: {
    id: string;
    states: { nodes: Array<{ id: string; name: string }> };
  };
}

const log = createLogger({ level: "warn", pretty: false });

/** Page size for project-level issue reads. */
const PAGE_SIZE = 50;

/**
 * Existing `blocks` relations for `issueId`, used to make feature→feature
 * dependency linking idempotent and acyclic (FRG-952):
 *  - `blockedByIssueIds`: issues that block this one (this issue's
 *    inverseRelations of type `blocks`).
 *  - `blocksIssueIds`: issues this one blocks (this issue's relations of
 *    type `blocks`).
 * Best-effort: any failure returns empty sets so linking still proceeds
 * (the worst case is the pre-existing duplicate/cycle behaviour).
 */
export async function getBlockRelations(
  graphql: LinearGraphQLExecutor,
  issueId: string,
): Promise<{ blockedByIssueIds: string[]; blocksIssueIds: string[] }> {
  try {
    const query = `
      query BlockRelations($id: String!) {
        issue(id: $id) {
          relations(first: 100) { nodes { type relatedIssue { id } } }
          inverseRelations(first: 100) { nodes { type issue { id } } }
        }
      }
    `;
    const data = await graphql<{
      issue: {
        relations: { nodes: Array<{ type: string; relatedIssue: { id: string } | null }> };
        inverseRelations: { nodes: Array<{ type: string; issue: { id: string } | null }> };
      } | null;
    }>(query, { id: issueId });
    const issue = data.issue;
    if (!issue) return { blockedByIssueIds: [], blocksIssueIds: [] };
    const blocksIssueIds = (issue.relations?.nodes ?? [])
      .filter((n) => n.type === "blocks" && n.relatedIssue)
      .map((n) => (n.relatedIssue as { id: string }).id);
    const blockedByIssueIds = (issue.inverseRelations?.nodes ?? [])
      .filter((n) => n.type === "blocks" && n.issue)
      .map((n) => (n.issue as { id: string }).id);
    return { blockedByIssueIds, blocksIssueIds };
  } catch (error) {
    log.warn(
      { err: error, issueId },
      "Linear getBlockRelations failed — treating as no existing relations",
    );
    return { blockedByIssueIds: [], blocksIssueIds: [] };
  }
}

/**
 * Fetch a single Linear issue by its human identifier (e.g. "FRG-1801").
 * Returns enough to validate workflow states and verify project ownership.
 */
export async function fetchIssueByIdentifier(
  graphql: LinearGraphQLExecutor,
  identifier: string,
): Promise<LinearIssueRef | null> {
  try {
    const data = await graphql<{
      issues: {
        nodes: Array<LinearIssueRef>;
      };
    }>(
      `query IssueByIdentifier($identifier: String!) {
        issues(filter: { identifier: { eq: $identifier } }, first: 1) {
          nodes {
            id
            identifier
            title
            state { name }
            project { id }
            team {
              id
              states { nodes { id name } }
            }
          }
        }
      }`,
      { identifier },
    );
    return data.issues.nodes[0] ?? null;
  } catch (error) {
    log.warn({ err: error, identifier }, "Linear fetchIssueByIdentifier failed");
    return null;
  }
}

/**
 * Fetch all "open" issues in a project (states whose type is backlog,
 * unstarted, or started). Used by Smith bug intake to deduplicate against
 * orphan Linear tickets that were filed outside the DB-first lifecycle
 * (FRG-1795). Returns full issue nodes including `description` so the caller
 * can normalize and compare content client-side.
 */
export async function fetchOpenProjectIssues(
  graphql: LinearGraphQLExecutor,
  projectId: string,
): Promise<NormalizedIssue[]> {
  try {
    const query = `
      query OpenProjectIssues($projectId: ID!, $first: Int!, $after: String) {
        issues(
          filter: {
            project: { id: { eq: $projectId } }
            state: { type: { in: ["backlog", "unstarted", "started"] } }
          }
          first: $first
          after: $after
        ) {
          nodes {
            id
            identifier
            title
            description
            priority
            branchName
            url
            state { name }
            assignee { id displayName }
            labels { nodes { name } }
            createdAt
            updatedAt
            inverseRelations {
              nodes {
                type
                issue {
                  id
                  identifier
                  state { name }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const nodes = await paginateConnection<
      { issues: LinearConnection<RawLinearIssue> },
      RawLinearIssue
    >(
      (q, v) => graphql(q, v),
      query,
      { projectId },
      (data) => data.issues,
      PAGE_SIZE,
    );

    return nodes.map(normalizeLinearIssue);
  } catch (error) {
    log.warn({ err: error }, "Linear fetchOpenProjectIssues failed");
    return [];
  }
}

/**
 * Fetch terminal-state issues in a project. Used by the reconciler to find
 * tickets that have reached a done/canceled state in Linear and mirror that
 * status locally.
 */
export async function fetchTerminalIssues(
  graphql: LinearGraphQLExecutor,
  config: TrackerConfig,
): Promise<NormalizedIssue[]> {
  const scope = linearScope(config);

  try {
    const labelFragments = buildLabelFilterFragments(config.labels);
    const query = `
      query FetchTerminalIssues(${scope.varDecl}, $states: [String!]!, $first: Int!, $after: String${labelFragments.varDecl}) {
        issues(
          filter: {
            ${scope.clause}
            state: { name: { in: $states } }
            ${labelFragments.clause}
          }
          first: $first
          after: $after
        ) {
          nodes {
            id
            identifier
            title
            description
            priority
            branchName
            url
            state { name }
            assignee { id displayName }
            labels { nodes { name } }
            createdAt
            updatedAt
            inverseRelations {
              nodes {
                type
                issue {
                  id
                  identifier
                  state { name }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const baseVariables: Record<string, unknown> = {
      ...scope.variables,
      states: config.terminal_states,
    };
    if (labelFragments.filter) baseVariables.labels = labelFragments.filter;

    const nodes = await paginateConnection<
      { issues: LinearConnection<RawLinearIssue> },
      RawLinearIssue
    >(
      (q, v) => graphql(q, v),
      query,
      baseVariables,
      (data) => data.issues,
      PAGE_SIZE,
    );

    return nodes.map(normalizeLinearIssue);
  } catch (error) {
    log.warn({ err: error }, "Linear fetchTerminalIssues failed");
    return [];
  }
}

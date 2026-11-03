import { createLogger } from "../observability/logger.js";
import { fetchBoardCards } from "./linear-board.js";
import { claimLinearIssue } from "./linear-claim.js";
import {
  LinearGraphQLError,
  type LinearGraphQLErrorEntry,
  LinearHttpError,
} from "./linear-errors.js";
import {
  buildLabelFilterFragments,
  normalizeLinearIssue,
  type RawLinearIssue,
} from "./linear-normalize.js";
import { type LinearConnection, paginateConnection } from "./linear-paginate.js";
import { fetchProgressCounts as fetchLinearProgressCounts } from "./linear-progress.js";
import {
  fetchIssueByIdentifier as fetchIssueByIdentifierRead,
  fetchOpenProjectIssues as fetchOpenProjectIssuesRead,
  fetchTerminalIssues as fetchTerminalIssuesRead,
  type LinearIssueRef,
  getBlockRelations as readBlockRelations,
} from "./linear-reads.js";
import { LinearWriteClient } from "./linear-writes.js";
import type {
  BoardCard,
  ClaimIssueArgs,
  ClaimResult,
  CreateIssueArgs,
  CreateIssueResult,
  IssueComment,
  IssueRelationType,
  NormalizedIssue,
  ProgressCounts,
  TrackerAdapter,
  TrackerConfig,
} from "./types.js";

export { LinearGraphQLError, LinearHttpError } from "./linear-errors.js";

const log = createLogger({ level: "warn", pretty: false });

/** Page size for the full-issue project reads (candidates + terminal). */
const LINEAR_PAGE_SIZE = 50;

interface GraphQLResponse<T> {
  data?: T;
  errors?: LinearGraphQLErrorEntry[];
}

export class LinearTracker implements TrackerAdapter {
  readonly kind = "linear";
  private endpoint: string;
  private apiKey: string;
  private viewerId: string | null = null;
  private readonly writes: LinearWriteClient;

  constructor(endpoint?: string, apiKey?: string) {
    this.endpoint = endpoint || "https://api.linear.app/graphql";
    this.apiKey = apiKey || "";
    this.writes = new LinearWriteClient((q, v) => this.graphql(q, v));
  }

  private async resolveAssignee(assignee: string): Promise<string> {
    if (assignee.trim().toLowerCase() !== "me") return assignee;
    if (this.viewerId) return this.viewerId;

    const data = await this.graphql<{ viewer: { id: string } }>(`query { viewer { id } }`);
    this.viewerId = data.viewer.id;
    return this.viewerId;
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    if (!this.apiKey) {
      throw new Error("Linear API key is required");
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new LinearHttpError(response.status, response.statusText);
    }

    const json = (await response.json()) as GraphQLResponse<T>;
    if (json.errors?.length) {
      throw new LinearGraphQLError(
        `Linear GraphQL error: ${json.errors.map((e) => e.message).join(", ")}`,
        json.errors[0]?.extensions?.code,
        json.errors,
      );
    }
    if (!json.data) {
      throw new Error("Linear API returned no data");
    }
    return json.data;
  }

  async fetchCandidates(config: TrackerConfig): Promise<NormalizedIssue[]> {
    if (!config.project_slug) {
      throw new Error("Linear project slug is required");
    }

    try {
      const labelFragments = buildLabelFilterFragments(config.labels);
      // PITFALL #3: Use project: { slugId: { eq: $slug } } for project filtering
      const query = `
        query FetchCandidates($slug: String!, $states: [String!]!, $first: Int!, $after: String${labelFragments.varDecl}) {
          issues(
            filter: {
              project: { slugId: { eq: $slug } }
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
        slug: config.project_slug,
        states: config.active_states,
      };
      if (labelFragments.filter) baseVariables.labels = labelFragments.filter;

      const nodes = await paginateConnection<
        { issues: LinearConnection<RawLinearIssue> },
        RawLinearIssue
      >(
        (q, v) => this.graphql(q, v),
        query,
        baseVariables,
        (data) => data.issues,
        LINEAR_PAGE_SIZE,
      );
      const allIssues = nodes.map(normalizeLinearIssue);

      // Apply assignee filter if configured
      if (config.assignee) {
        const resolvedAssignee = await this.resolveAssignee(config.assignee);
        return allIssues.filter((i) => i.assignee === resolvedAssignee);
      }

      return allIssues;
    } catch (error) {
      log.warn({ err: error }, "Linear fetchCandidates failed");
      return [];
    }
  }

  // PITFALL #1: Use issues(filter: { id: { in: $ids } }), NOT nodes(ids: [...])
  async fetchBoard(config: TrackerConfig, states: string[]): Promise<BoardCard[]> {
    if (!config.project_slug) throw new Error("Linear project slug is required");
    return fetchBoardCards((q, v) => this.graphql(q, v), config.project_slug, states);
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();

    try {
      const result = new Map<string, string>();
      // Batch in groups of 50
      for (let i = 0; i < ids.length; i += 50) {
        const batchIds = ids.slice(i, i + 50);
        const query = `
          query FetchIssueStates($ids: [ID!]!, $first: Int!) {
            issues(filter: { id: { in: $ids } }, first: $first) {
              nodes {
                id
                state { name }
              }
            }
          }
        `;

        const data = await this.graphql<{
          issues: { nodes: Array<{ id: string; state: { name: string } }> };
        }>(query, { ids: batchIds, first: batchIds.length });

        for (const node of data.issues.nodes) {
          result.set(node.id, node.state.name);
        }
      }
      return result;
    } catch (error) {
      log.warn({ err: error }, "Linear fetchIssueStatesByIds failed");
      return new Map();
    }
  }

  fetchTerminalIssues(config: TrackerConfig): Promise<NormalizedIssue[]> {
    return fetchTerminalIssuesRead((q, v) => this.graphql(q, v), config);
  }

  /**
   * Fetch all "open" issues in a project (states whose type is backlog,
   * unstarted, or started). Used by Smith bug intake to deduplicate against
   * orphan Linear tickets that were filed outside the DB-first lifecycle
   * (FRG-1795). Returns full issue nodes including `description` so the caller
   * can normalize and compare content client-side.
   */
  fetchOpenProjectIssues(projectId: string): Promise<NormalizedIssue[]> {
    return fetchOpenProjectIssuesRead((q, v) => this.graphql(q, v), projectId);
  }

  /**
   * Count the project's tickets straight from Linear (see
   * `fetchProgressCounts` in linear-progress.ts). Linear is the source of truth
   * for build progress, so this is a fresh read with no local accumulation.
   */
  async fetchProgressCounts(config: TrackerConfig): Promise<ProgressCounts> {
    return fetchLinearProgressCounts((q, v) => this.graphql(q, v), config);
  }

  /**
   * Fetch a single issue by its human identifier (e.g. "FRG-1801").
   * Best-effort: returns null on any error.
   */
  async fetchIssueByIdentifier(identifier: string): Promise<LinearIssueRef | null> {
    return fetchIssueByIdentifierRead((q, v) => this.graphql(q, v), identifier);
  }

  /**
   * Move an issue to a workflow state by resolved state ID. Use when the caller
   * has already validated the state belongs to the issue's team.
   */
  /**
   * Claim an issue for this agent (FRG-1988). Delegates to the compare-and-set
   * helper — see `linear-claim.ts` for why a single mutation is not enough.
   */
  async claimIssue(
    args: ClaimIssueArgs,
    options?: { activeStates?: string[] },
  ): Promise<ClaimResult> {
    return claimLinearIssue(
      (q, v) => this.graphql(q, v),
      (assignee) => this.resolveAssignee(assignee),
      (teamId, name) => this.writes.resolveStateId(teamId, name),
      args,
      options,
    );
  }

  async updateIssueStateById(
    issueId: string,
    stateId: string,
  ): Promise<{ id: string; state: { name: string } }> {
    return this.writes.updateIssueStateById(issueId, stateId);
  }

  /**
   * Move an issue to a workflow state. `stateName` may be a single name or an
   * ordered list of candidate names — the first that exists in the team workflow
   * wins, matched case-insensitively. This tolerates spelling variants the team
   * actually uses (e.g. Linear's default "Canceled" vs. our config's
   * "Cancelled") so a transition can't fail on a one-letter mismatch.
   */
  async updateIssueState(issueId: string, stateName: string | string[]): Promise<void> {
    const teamData = await this.graphql<{
      issue: {
        team: {
          states: { nodes: Array<{ id: string; name: string }> };
        };
      };
    }>(
      `query IssueTeamStates($id: String!) {
        issue(id: $id) {
          team {
            states { nodes { id name } }
          }
        }
      }`,
      { id: issueId },
    );

    const states = teamData.issue.team.states.nodes;
    const candidates = Array.isArray(stateName) ? stateName : [stateName];
    let target: { id: string; name: string } | undefined;
    for (const candidate of candidates) {
      target = states.find((s) => s.name.toLowerCase() === candidate.toLowerCase());
      if (target) break;
    }
    if (!target) {
      throw new Error(
        `None of [${candidates.join(", ")}] found in team workflow. Available: ${states.map((s) => s.name).join(", ")}`,
      );
    }

    await this.graphql<{ issueUpdate: { success: boolean } }>(
      `mutation MoveIssueToState($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
        }
      }`,
      { id: issueId, stateId: target.id },
    );
  }

  createIssue(args: CreateIssueArgs): Promise<CreateIssueResult> {
    return this.writes.createIssue(args);
  }

  linkIssues(fromIssueId: string, toIssueId: string, type: IssueRelationType): Promise<void> {
    return this.writes.linkIssues(fromIssueId, toIssueId, type);
  }

  async createComment(issueId: string, body: string): Promise<string> {
    const data = await this.graphql<{
      commentCreate: { success: boolean; comment: { id: string } };
    }>(
      `mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { id }
        }
      }`,
      { issueId, body },
    );

    return data.commentCreate.comment.id;
  }

  async fetchIssueComments(issueId: string): Promise<IssueComment[]> {
    try {
      const query = `
        query FetchComments($id: String!) {
          issue(id: $id) {
            comments(first: 50) {
              nodes { id body createdAt }
            }
          }
        }
      `;
      const data = await this.graphql<{
        issue: { comments: { nodes: Array<{ id: string; body: string; createdAt: string }> } };
      }>(query, { id: issueId });
      return data.issue.comments.nodes;
    } catch (error) {
      log.warn({ err: error }, "Linear fetchIssueComments failed");
      return [];
    }
  }

  getBlockRelations(
    issueId: string,
  ): Promise<{ blockedByIssueIds: string[]; blocksIssueIds: string[] }> {
    return readBlockRelations((q, v) => this.graphql(q, v), issueId);
  }
}

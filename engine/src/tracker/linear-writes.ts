import type { CreateIssueArgs, CreateIssueResult, IssueRelationType } from "./types.js";

/**
 * GraphQL executor injected by `LinearTracker`. Decouples write helpers from
 * the tracker's private fetch wiring so this file can stay test-friendly and
 * within the architecture's per-file size budget.
 */
export type LinearGraphQLExecutor = <T>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

/**
 * Helper that owns label/state name → id resolution, plus the `issueCreate`
 * and `issueRelationCreate` mutations. Per-team caches keep round trips low
 * across the Smith hot path (dozens of tickets per session).
 */
export class LinearWriteClient {
  // Per-team caches: workflow states and labels rarely change, so resolve
  // once and reuse for the lifetime of the tracker instance.
  private readonly labelIdCache = new Map<string, Map<string, string>>();
  private readonly stateIdCache = new Map<string, Map<string, string>>();

  constructor(private readonly graphql: LinearGraphQLExecutor) {}

  async createIssue(args: CreateIssueArgs): Promise<CreateIssueResult> {
    const labelIds = args.labels?.length
      ? await this.resolveLabelIds(args.teamId, args.labels)
      : undefined;
    const stateId = args.stateName
      ? await this.resolveStateId(args.teamId, args.stateName)
      : undefined;

    const input: Record<string, unknown> = {
      teamId: args.teamId,
      title: args.title,
      description: args.description,
    };
    if (labelIds) input.labelIds = labelIds;
    if (stateId) input.stateId = stateId;
    if (args.projectId) input.projectId = args.projectId;
    if (typeof args.priority === "number") input.priority = args.priority;

    const data = await this.graphql<{
      issueCreate: {
        success: boolean;
        issue: { id: string; identifier: string; url: string } | null;
      };
    }>(
      `mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url }
        }
      }`,
      { input },
    );

    if (!data.issueCreate.success || !data.issueCreate.issue) {
      throw new Error(`Linear issueCreate returned success=false (title="${args.title}")`);
    }
    return data.issueCreate.issue;
  }

  async linkIssues(fromIssueId: string, toIssueId: string, type: IssueRelationType): Promise<void> {
    // Linear's API exposes "blocks" / "related" (and "duplicate", which we don't
    // expose). "blockedBy" is the inverse of "blocks": if A blockedBy B, that's
    // "B blocks A". Translate the caller-facing direction so handlers can think
    // in either direction.
    let issueId: string;
    let relatedIssueId: string;
    let apiType: "blocks" | "related";

    if (type === "blockedBy") {
      issueId = toIssueId;
      relatedIssueId = fromIssueId;
      apiType = "blocks";
    } else {
      issueId = fromIssueId;
      relatedIssueId = toIssueId;
      apiType = type;
    }

    const data = await this.graphql<{ issueRelationCreate: { success: boolean } }>(
      `mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) {
          success
        }
      }`,
      { input: { issueId, relatedIssueId, type: apiType } },
    );

    if (!data.issueRelationCreate.success) {
      throw new Error(
        `Linear issueRelationCreate returned success=false (from=${fromIssueId}, to=${toIssueId}, type=${type})`,
      );
    }
  }

  async updateIssueStateById(
    issueId: string,
    stateId: string,
  ): Promise<{ id: string; state: { name: string } }> {
    const data = await this.graphql<{
      issueUpdate: {
        success: boolean;
        issue: { id: string; state: { name: string } } | null;
      };
    }>(
      `mutation MoveIssueToStateById($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
          issue { id state { name } }
        }
      }`,
      { id: issueId, stateId },
    );

    if (!data.issueUpdate.success || !data.issueUpdate.issue) {
      throw new Error(`Linear issueUpdate returned success=false (issueId="${issueId}")`);
    }
    return data.issueUpdate.issue;
  }

  private async resolveLabelIds(teamId: string, names: string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const cache = this.labelIdCache.get(teamId) ?? new Map<string, string>();
    const missing = names.filter((n) => !cache.has(n));

    if (missing.length > 0) {
      const data = await this.graphql<{
        team: { labels: { nodes: Array<{ id: string; name: string }> } };
      }>(
        `query LabelsByName($teamId: String!, $names: [String!]!) {
          team(id: $teamId) {
            labels(filter: { name: { in: $names } }) { nodes { id name } }
          }
        }`,
        { teamId, names: missing },
      );

      for (const node of data.team.labels.nodes) {
        cache.set(node.name, node.id);
      }
      this.labelIdCache.set(teamId, cache);
    }

    const ids: string[] = [];
    for (const name of names) {
      const id = cache.get(name);
      if (!id) {
        throw new Error(`Linear label "${name}" not found in team ${teamId}`);
      }
      ids.push(id);
    }
    return ids;
  }

  async resolveStateId(teamId: string, name: string): Promise<string> {
    const cache = this.stateIdCache.get(teamId) ?? new Map<string, string>();
    const cached = cache.get(name);
    if (cached) return cached;

    const data = await this.graphql<{
      team: { states: { nodes: Array<{ id: string; name: string }> } };
    }>(
      `query WorkflowStateByName($teamId: String!, $name: String!) {
        team(id: $teamId) {
          states(filter: { name: { eq: $name } }) { nodes { id name } }
        }
      }`,
      { teamId, name },
    );

    for (const node of data.team.states.nodes) {
      cache.set(node.name, node.id);
    }
    this.stateIdCache.set(teamId, cache);

    const id = cache.get(name);
    if (!id) {
      throw new Error(`Linear workflow state "${name}" not found in team ${teamId}`);
    }
    return id;
  }
}

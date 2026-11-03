import { describe, expect, it, vi } from "vitest";
import type { RawLinearIssue } from "../../../src/tracker/linear-normalize.js";
import {
  fetchIssueByIdentifier,
  fetchOpenProjectIssues,
  fetchTerminalIssues,
  getBlockRelations,
} from "../../../src/tracker/linear-reads.js";
import type { LinearGraphQLExecutor } from "../../../src/tracker/linear-writes.js";
import type { TrackerConfig } from "../../../src/tracker/types.js";

function makeConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    kind: "linear",
    project_slug: "my-project",
    active_states: ["Todo", "In Progress"],
    terminal_states: ["Done", "Cancelled"],
    api_key: "lin_api_test_key",
    endpoint: "https://api.linear.app/graphql",
    ...overrides,
  };
}

function makeRawIssue(overrides: Partial<RawLinearIssue> = {}): RawLinearIssue {
  return {
    id: "issue-1",
    identifier: "PRJ-1",
    title: "Test issue",
    description: "A test issue description",
    priority: 2,
    branchName: null,
    url: null,
    state: { name: "Todo" },
    assignee: { id: "user-1", displayName: "Alice" },
    labels: { nodes: [{ name: "bug" }, { name: "urgent" }] },
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-02T00:00:00Z",
    inverseRelations: { nodes: [] },
    ...overrides,
  };
}

function makeExecutor(responses: Array<{ data: unknown } | Error>): LinearGraphQLExecutor {
  let call = 0;
  return vi.fn(async (_query: string, _variables?: Record<string, unknown>) => {
    const response = responses[call++];
    if (response instanceof Error) throw response;
    return response.data as unknown;
  });
}

describe("getBlockRelations", () => {
  it("extracts blocks relations from both directions", async () => {
    const executor = makeExecutor([
      {
        data: {
          issue: {
            relations: {
              nodes: [
                { type: "blocks", relatedIssue: { id: "blocked-2" } },
                { type: "relates", relatedIssue: { id: "related-1" } },
                { type: "blocks", relatedIssue: null },
              ],
            },
            inverseRelations: {
              nodes: [
                { type: "blocks", issue: { id: "blocker-1" } },
                { type: "relates", issue: { id: "related-2" } },
                { type: "blocks", issue: null },
              ],
            },
          },
        },
      },
    ]);

    const result = await getBlockRelations(executor, "issue-1");

    expect(result.blocksIssueIds).toEqual(["blocked-2"]);
    expect(result.blockedByIssueIds).toEqual(["blocker-1"]);
  });

  it("returns empty sets when the issue is not found", async () => {
    const executor = makeExecutor([{ data: { issue: null } }]);

    const result = await getBlockRelations(executor, "missing");

    expect(result).toEqual({ blockedByIssueIds: [], blocksIssueIds: [] });
  });

  it("returns empty sets on executor error", async () => {
    const executor = makeExecutor([new Error("Linear API unavailable")]);

    const result = await getBlockRelations(executor, "issue-1");

    expect(result).toEqual({ blockedByIssueIds: [], blocksIssueIds: [] });
  });
});

describe("fetchIssueByIdentifier", () => {
  it("returns the first matching issue ref", async () => {
    const executor = makeExecutor([
      {
        data: {
          issues: {
            nodes: [
              {
                id: "issue-1",
                identifier: "PRJ-1",
                title: "Test issue",
                state: { name: "Todo" },
                project: { id: "project-1" },
                team: { id: "team-1", states: { nodes: [{ id: "s-1", name: "Todo" }] } },
              },
            ],
          },
        },
      },
    ]);

    const result = await fetchIssueByIdentifier(executor, "PRJ-1");

    expect(result).toMatchObject({
      id: "issue-1",
      identifier: "PRJ-1",
      title: "Test issue",
      state: { name: "Todo" },
    });
    expect(executor.mock.calls[0]?.[1]).toEqual({ identifier: "PRJ-1" });
  });

  it("returns null when no issue matches", async () => {
    const executor = makeExecutor([{ data: { issues: { nodes: [] } } }]);

    const result = await fetchIssueByIdentifier(executor, "PRJ-999");

    expect(result).toBeNull();
  });

  it("returns null on executor error", async () => {
    const executor = makeExecutor([new Error("Linear API unavailable")]);

    const result = await fetchIssueByIdentifier(executor, "PRJ-1");

    expect(result).toBeNull();
  });
});

describe("fetchOpenProjectIssues", () => {
  it("returns normalized open issues from a single page", async () => {
    const raw = makeRawIssue();
    const executor = makeExecutor([
      {
        data: {
          issues: {
            nodes: [raw],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await fetchOpenProjectIssues(executor, "project-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "issue-1",
      identifier: "PRJ-1",
      title: "Test issue",
      state: "Todo",
      assignee: "user-1",
      labels: ["bug", "urgent"],
    });
    expect(executor.mock.calls[0]?.[1]).toMatchObject({ projectId: "project-1", first: 50 });
  });

  it("paginates across multiple pages", async () => {
    const executor = makeExecutor([
      {
        data: {
          issues: {
            nodes: [makeRawIssue({ id: "issue-1", identifier: "PRJ-1" })],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        },
      },
      {
        data: {
          issues: {
            nodes: [makeRawIssue({ id: "issue-2", identifier: "PRJ-2" })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await fetchOpenProjectIssues(executor, "project-1");

    expect(result.map((i) => i.id)).toEqual(["issue-1", "issue-2"]);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor.mock.calls[1]?.[1]).toMatchObject({ after: "cursor-1" });
  });

  it("returns an empty array on executor error", async () => {
    const executor = makeExecutor([new Error("Linear API unavailable")]);

    const result = await fetchOpenProjectIssues(executor, "project-1");

    expect(result).toEqual([]);
  });
});

describe("fetchTerminalIssues", () => {
  it("throws when project slug is missing", async () => {
    const executor = makeExecutor([]);
    await expect(fetchTerminalIssues(executor, makeConfig({ project_slug: "" }))).rejects.toThrow(
      "Linear project slug is required",
    );
    expect(executor).not.toHaveBeenCalled();
  });

  it("returns normalized terminal issues", async () => {
    const raw = makeRawIssue({ id: "done-1", state: { name: "Done" } });
    const executor = makeExecutor([
      {
        data: {
          issues: {
            nodes: [raw],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await fetchTerminalIssues(executor, makeConfig());

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "done-1", state: "Done" });
    expect(executor.mock.calls[0]?.[1]).toMatchObject({
      slug: "my-project",
      states: ["Done", "Cancelled"],
      first: 50,
    });
  });

  it("paginates terminal issues across pages", async () => {
    const executor = makeExecutor([
      {
        data: {
          issues: {
            nodes: [makeRawIssue({ id: "done-1", state: { name: "Done" } })],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        },
      },
      {
        data: {
          issues: {
            nodes: [makeRawIssue({ id: "done-2", state: { name: "Cancelled" } })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await fetchTerminalIssues(executor, makeConfig());

    expect(result.map((i) => i.id)).toEqual(["done-1", "done-2"]);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor.mock.calls[1]?.[1]).toMatchObject({ after: "cursor-1" });
  });

  it("pushes a labels filter into the GraphQL query and variables", async () => {
    const executor = makeExecutor([
      {
        data: {
          issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    ]);

    await fetchTerminalIssues(executor, makeConfig({ labels: ["smith_feature", "smith_bug"] }));

    const query = executor.mock.calls[0]?.[0] as string;
    const variables = executor.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(query).toContain("labels: { name: { in: $labels } }");
    expect(query).toContain("$labels: [String!]");
    expect(variables.labels).toEqual(["smith_feature", "smith_bug"]);
  });

  it("returns an empty array on executor error", async () => {
    const executor = makeExecutor([new Error("Linear API unavailable")]);

    const result = await fetchTerminalIssues(executor, makeConfig());

    expect(result).toEqual([]);
  });
});

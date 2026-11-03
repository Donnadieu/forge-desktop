import { describe, expect, it, vi } from "vitest";
import { fetchProgressCounts } from "../../../src/tracker/linear-progress.js";
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

type ProgressData = {
  issues: {
    nodes: Array<{ state: { name: string } | null }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

function makeExecutor(responses: Array<{ data: ProgressData } | Error>): LinearGraphQLExecutor {
  let call = 0;
  return vi.fn(async (_query: string, _variables?: Record<string, unknown>) => {
    const response = responses[call++];
    if (response instanceof Error) throw response;
    return response.data as ProgressData;
  });
}

describe("fetchProgressCounts", () => {
  it("throws when project slug is missing", async () => {
    const executor = makeExecutor([]);
    await expect(fetchProgressCounts(executor, makeConfig({ project_slug: "" }))).rejects.toThrow(
      "Linear project slug is required",
    );
    expect(executor).not.toHaveBeenCalled();
  });

  it("counts only build-scoped tickets from a single page", async () => {
    const executor = makeExecutor([
      {
        data: {
          issues: {
            nodes: [
              { state: { name: "Todo" } },
              { state: { name: "Done" } },
              { state: { name: "Cancelled" } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await fetchProgressCounts(executor, makeConfig());

    // "In Review" is not in active_states or terminal_states, so it is excluded.
    expect(result).toEqual({ total: 3, done: 2 });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]?.[1]).toMatchObject({
      slug: "my-project",
      states: expect.arrayContaining(["Todo", "In Progress", "Done", "Cancelled"]),
      first: 100,
    });
  });

  it("counts a null-state ticket toward total but not done", async () => {
    const executor = makeExecutor([
      {
        data: {
          issues: {
            nodes: [{ state: { name: "Done" } }, { state: null }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await fetchProgressCounts(executor, makeConfig());

    expect(result).toEqual({ total: 2, done: 1 });
  });

  it("paginates and sums counts across pages", async () => {
    const executor = makeExecutor([
      {
        data: {
          issues: {
            nodes: [{ state: { name: "Done" } }, { state: { name: "Todo" } }],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        },
      },
      {
        data: {
          issues: {
            nodes: [{ state: { name: "Done" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await fetchProgressCounts(executor, makeConfig());

    expect(result).toEqual({ total: 3, done: 2 });
    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor.mock.calls[1]?.[1]).toMatchObject({ after: "cursor-1" });
  });

  it("filters by the union of active and terminal states", async () => {
    const executor = makeExecutor([
      {
        data: {
          issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    ]);

    await fetchProgressCounts(executor, makeConfig());

    const query = executor.mock.calls[0]?.[0] as string;
    const variables = executor.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(query).toContain("state: { name: { in: $states } }");
    expect(query).toContain("$states: [String!]!");
    expect(variables.states).toEqual(
      expect.arrayContaining(["Todo", "In Progress", "Done", "Cancelled"]),
    );
  });

  it("pushes the label scope into the GraphQL query and variables", async () => {
    const executor = makeExecutor([
      {
        data: {
          issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    ]);

    await fetchProgressCounts(executor, makeConfig({ labels: ["smith_feature", "smith_bug"] }));

    const query = executor.mock.calls[0]?.[0] as string;
    const variables = executor.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(query).toContain("labels: { name: { in: $labels } }");
    expect(query).toContain("$labels: [String!]");
    expect(variables.labels).toEqual(["smith_feature", "smith_bug"]);
  });

  it("propagates executor errors", async () => {
    const executor = makeExecutor([new Error("Linear API unavailable")]);

    await expect(fetchProgressCounts(executor, makeConfig())).rejects.toThrow(
      "Linear API unavailable",
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import { type LinearConnection, paginateConnection } from "../../../src/tracker/linear-paginate.js";
import type { LinearGraphQLExecutor } from "../../../src/tracker/linear-writes.js";

type IssueData = { issues: LinearConnection<{ id: string; title: string }> };

function makeExecutor(responses: Array<{ data: IssueData } | Error>): LinearGraphQLExecutor {
  let call = 0;
  return vi.fn(async (_query: string, _variables?: Record<string, unknown>) => {
    const response = responses[call++];
    if (response instanceof Error) throw response;
    return response.data as IssueData;
  });
}

const query = `
  query Issues($first: Int!, $after: String) {
    issues(first: $first, after: $after) {
      nodes { id title }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

describe("paginateConnection", () => {
  it("returns an empty array for an empty connection", async () => {
    const executor = makeExecutor([
      {
        data: {
          issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    ]);

    const result = await paginateConnection<IssueData, { id: string; title: string }>(
      executor,
      query,
      {},
      (data) => data.issues,
      10,
    );

    expect(result).toEqual([]);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]?.[1]).toEqual({ first: 10 });
  });

  it("returns a single page without a second request", async () => {
    const executor = makeExecutor([
      {
        data: {
          issues: {
            nodes: [{ id: "a", title: "A" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await paginateConnection<IssueData, { id: string; title: string }>(
      executor,
      query,
      { projectId: "p1" },
      (data) => data.issues,
      10,
    );

    expect(result).toEqual([{ id: "a", title: "A" }]);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]?.[1]).toEqual({ projectId: "p1", first: 10 });
  });

  it("paginates through multiple pages and threads the cursor", async () => {
    const executor = makeExecutor([
      {
        data: {
          issues: {
            nodes: [{ id: "a", title: "A" }],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        },
      },
      {
        data: {
          issues: {
            nodes: [{ id: "b", title: "B" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await paginateConnection<IssueData, { id: string; title: string }>(
      executor,
      query,
      {},
      (data) => data.issues,
      10,
    );

    expect(result).toEqual([
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor.mock.calls[0]?.[1]).toEqual({ first: 10 });
    expect(executor.mock.calls[1]?.[1]).toEqual({ first: 10, after: "cursor-1" });
  });

  it("stops when Linear reports another page but returns a null cursor", async () => {
    const executor = makeExecutor([
      {
        data: {
          issues: {
            nodes: [{ id: "a", title: "A" }],
            pageInfo: { hasNextPage: true, endCursor: null },
          },
        },
      },
    ]);

    const result = await paginateConnection<IssueData, { id: string; title: string }>(
      executor,
      query,
      {},
      (data) => data.issues,
      10,
    );

    expect(result).toEqual([{ id: "a", title: "A" }]);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("stops when the cursor does not advance", async () => {
    const executor = makeExecutor([
      {
        data: {
          issues: {
            nodes: [{ id: "a", title: "A" }],
            pageInfo: { hasNextPage: true, endCursor: "stuck" },
          },
        },
      },
      {
        data: {
          issues: {
            nodes: [{ id: "b", title: "B" }],
            pageInfo: { hasNextPage: true, endCursor: "stuck" },
          },
        },
      },
    ]);

    const result = await paginateConnection<IssueData, { id: string; title: string }>(
      executor,
      query,
      {},
      (data) => data.issues,
      10,
    );

    expect(result).toEqual([
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("propagates executor errors", async () => {
    const executor = makeExecutor([new Error("Linear API unavailable")]);

    await expect(
      paginateConnection<IssueData, { id: string; title: string }>(
        executor,
        query,
        {},
        (data) => data.issues,
        10,
      ),
    ).rejects.toThrow("Linear API unavailable");
  });
});

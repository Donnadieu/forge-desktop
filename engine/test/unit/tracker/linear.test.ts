import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinearGraphQLError, LinearHttpError, LinearTracker } from "../../../src/tracker/linear.js";
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

function makeRawIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "PRJ-1",
    title: "Test issue",
    description: "A test issue description",
    priority: 2,
    state: { name: "Todo" },
    assignee: { id: "user-1", displayName: "Alice" },
    labels: { nodes: [{ name: "bug" }, { name: "urgent" }] },
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-02T00:00:00Z",
    inverseRelations: { nodes: [] },
    ...overrides,
  };
}

function mockFetchResponse(data: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    json: async () => data,
  });
}

describe("LinearTracker", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("has kind set to 'linear'", () => {
    const tracker = new LinearTracker();
    expect(tracker.kind).toBe("linear");
  });

  describe("fetchCandidates", () => {
    it("returns normalized issues from a single page", async () => {
      const raw = makeRawIssue();
      globalThis.fetch = mockFetchResponse({
        data: {
          issues: {
            nodes: [raw],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });

      const tracker = new LinearTracker(undefined, "lin_api_test");
      const result = await tracker.fetchCandidates(makeConfig());

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "issue-1",
        identifier: "PRJ-1",
        title: "Test issue",
        description: "A test issue description",
        state: "Todo",
        priority: 2,
        assignee: "user-1",
        labels: ["bug", "urgent"],
        branchName: undefined,
        url: undefined,
        blockedBy: [],
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-02T00:00:00Z",
      });
    });

    it("paginates through multiple pages", async () => {
      const page1Issue = makeRawIssue({ id: "issue-1", identifier: "PRJ-1" });
      const page2Issue = makeRawIssue({ id: "issue-2", identifier: "PRJ-2" });

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            data: {
              issues: {
                nodes: [page1Issue],
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            data: {
              issues: {
                nodes: [page2Issue],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        });

      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker(undefined, "lin_api_test");
      const result = await tracker.fetchCandidates(makeConfig());

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("issue-1");
      expect(result[1].id).toBe("issue-2");

      // Verify the second call includes the cursor
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const secondCallBody = JSON.parse(
        (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
      );
      expect(secondCallBody.variables.after).toBe("cursor-1");
    });

    it("filters by assignee when config.assignee is set", async () => {
      const issue1 = makeRawIssue({
        id: "issue-1",
        assignee: { id: "user-1", displayName: "Alice" },
      });
      const issue2 = makeRawIssue({
        id: "issue-2",
        assignee: { id: "user-2", displayName: "Bob" },
      });

      globalThis.fetch = mockFetchResponse({
        data: {
          issues: {
            nodes: [issue1, issue2],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });

      const tracker = new LinearTracker(undefined, "lin_api_test");
      const config = makeConfig({ assignee: "user-1" });
      const result = await tracker.fetchCandidates(config);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("issue-1");
      expect(result[0].assignee).toBe("user-1");
    });

    it("returns empty array when API key is missing", async () => {
      const tracker = new LinearTracker();
      const result = await tracker.fetchCandidates(makeConfig());
      expect(result).toEqual([]);
    });

    it("throws when project slug is missing", async () => {
      const tracker = new LinearTracker(undefined, "lin_api_test");
      await expect(tracker.fetchCandidates(makeConfig({ project_slug: "" }))).rejects.toThrow(
        "Linear project slug is required",
      );
    });

    it("sends correct authorization header", async () => {
      const fetchMock = mockFetchResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker(undefined, "lin_api_my_key");
      await tracker.fetchCandidates(makeConfig());

      const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<
        string,
        string
      >;
      expect(headers.Authorization).toBe("lin_api_my_key");
    });

    it("uses custom endpoint when provided", async () => {
      const fetchMock = mockFetchResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker("https://custom.linear.dev/graphql", "key");
      await tracker.fetchCandidates(makeConfig());

      const url = (fetchMock.mock.calls[0] as [string, RequestInit])[0];
      expect(url).toBe("https://custom.linear.dev/graphql");
    });

    it("does not include a labels filter clause when config.labels is unset", async () => {
      const fetchMock = mockFetchResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker(undefined, "lin_api_test");
      await tracker.fetchCandidates(makeConfig());

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.query).not.toContain("labels:");
      expect(body.variables.labels).toBeUndefined();
    });

    it("pushes a labels filter into the GraphQL query when config.labels is set", async () => {
      const fetchMock = mockFetchResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker(undefined, "lin_api_test");
      await tracker.fetchCandidates(
        makeConfig({ labels: ["smith_feature", "smith_debug", "smith_bug"] }),
      );

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.query).toContain("labels: { name: { in: $labels } }");
      expect(body.query).toContain("$labels: [String!]");
      expect(body.variables.labels).toEqual(["smith_feature", "smith_debug", "smith_bug"]);
    });

    it("dedupes and trims labels in the filter (and treats whitespace-only entries as empty)", async () => {
      const fetchMock = mockFetchResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker(undefined, "lin_api_test");
      await tracker.fetchCandidates(
        makeConfig({ labels: ["smith_feature", "smith_feature", "  smith_bug ", "  ", ""] }),
      );

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.variables.labels).toEqual(["smith_feature", "smith_bug"]);
    });

    it("treats an empty/whitespace-only labels array as no filter", async () => {
      const fetchMock = mockFetchResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker(undefined, "lin_api_test");
      await tracker.fetchCandidates(makeConfig({ labels: [" ", ""] }));

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.query).not.toContain("labels:");
      expect(body.variables.labels).toBeUndefined();
    });

    it("lowercases the labels filter so the contract matches the memory tracker", async () => {
      const fetchMock = mockFetchResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker(undefined, "lin_api_test");
      await tracker.fetchCandidates(makeConfig({ labels: ["Smith_Feature", "SMITH_DEBUG"] }));

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.variables.labels).toEqual(["smith_feature", "smith_debug"]);
    });
  });

  describe("normalizeIssue (via fetchCandidates)", () => {
    it("filters inverseRelations client-side to extract blockedBy", async () => {
      const raw = makeRawIssue({
        inverseRelations: {
          nodes: [
            {
              type: "blocks",
              issue: {
                id: "blocker-1",
                identifier: "PRJ-10",
                state: { name: "In Progress" },
              },
            },
            {
              type: "relates",
              issue: {
                id: "related-1",
                identifier: "PRJ-20",
                state: { name: "Todo" },
              },
            },
            {
              type: "blocks",
              issue: {
                id: "blocker-2",
                identifier: "PRJ-30",
                state: null,
              },
            },
          ],
        },
      });

      globalThis.fetch = mockFetchResponse({
        data: {
          issues: {
            nodes: [raw],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });

      const tracker = new LinearTracker(undefined, "key");
      const result = await tracker.fetchCandidates(makeConfig());

      // Only "blocks" type relations should become blockedBy, not "relates"
      expect(result[0].blockedBy).toHaveLength(2);
      expect(result[0].blockedBy[0].id).toBe("blocker-1");
      expect(result[0].blockedBy[0].identifier).toBe("PRJ-10");
      expect(result[0].blockedBy[0].state).toBe("In Progress");
      expect(result[0].blockedBy[1].id).toBe("blocker-2");
      expect(result[0].blockedBy[1].state).toBe("");
    });

    it("handles null description, assignee, labels, and inverseRelations", async () => {
      const raw = makeRawIssue({
        description: null,
        assignee: null,
        labels: null,
        inverseRelations: null,
        priority: null,
      });

      globalThis.fetch = mockFetchResponse({
        data: {
          issues: {
            nodes: [raw],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });

      const tracker = new LinearTracker(undefined, "key");
      const result = await tracker.fetchCandidates(makeConfig());

      expect(result[0].description).toBe("");
      expect(result[0].assignee).toBeUndefined();
      expect(result[0].labels).toEqual([]);
      expect(result[0].blockedBy).toEqual([]);
      expect(result[0].priority).toBeNull();
    });

    it("lowercases label names", async () => {
      const raw = makeRawIssue({
        labels: { nodes: [{ name: "BUG" }, { name: "Urgent" }] },
      });

      globalThis.fetch = mockFetchResponse({
        data: {
          issues: {
            nodes: [raw],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });

      const tracker = new LinearTracker(undefined, "key");
      const result = await tracker.fetchCandidates(makeConfig());

      expect(result[0].labels).toEqual(["bug", "urgent"]);
    });
  });

  describe("fetchIssueStatesByIds", () => {
    it("returns a map of id to state name", async () => {
      globalThis.fetch = mockFetchResponse({
        data: {
          issues: {
            nodes: [
              { id: "id-a", state: { name: "Todo" } },
              { id: "id-b", state: { name: "Done" } },
            ],
          },
        },
      });

      const tracker = new LinearTracker(undefined, "key");
      const result = await tracker.fetchIssueStatesByIds(["id-a", "id-b"]);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(2);
      expect(result.get("id-a")).toBe("Todo");
      expect(result.get("id-b")).toBe("Done");
    });

    it("returns empty map for empty ids", async () => {
      const tracker = new LinearTracker(undefined, "key");
      const result = await tracker.fetchIssueStatesByIds([]);

      expect(result.size).toBe(0);
    });

    it("sends correct filter query (not nodes(ids:...))", async () => {
      const fetchMock = mockFetchResponse({
        data: {
          issues: {
            nodes: [{ id: "id-a", state: { name: "Todo" } }],
          },
        },
      });
      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker(undefined, "key");
      await tracker.fetchIssueStatesByIds(["id-a"]);

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      // The query should use issues(filter: { id: { in: ... } }), not nodes(ids: ...)
      expect(body.query).toContain("issues(filter:");
      expect(body.query).toContain("id: { in: $ids }");
      expect(body.query).not.toContain("nodes(ids:");
    });
  });

  describe("fetchTerminalIssues", () => {
    it("returns normalized terminal issues", async () => {
      const raw = makeRawIssue({ id: "done-1", state: { name: "Done" } });
      globalThis.fetch = mockFetchResponse({
        data: {
          issues: { nodes: [raw], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      });

      const tracker = new LinearTracker(undefined, "key");
      const result = await tracker.fetchTerminalIssues(makeConfig());

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("done-1");
      expect(result[0].state).toBe("Done");
    });

    it("paginates terminal issues across pages (does not cap at one page of 50)", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            data: {
              issues: {
                nodes: [makeRawIssue({ id: "done-1", state: { name: "Done" } })],
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            data: {
              issues: {
                nodes: [makeRawIssue({ id: "done-2", state: { name: "Done" } })],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        });
      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker(undefined, "key");
      const result = await tracker.fetchTerminalIssues(makeConfig());

      expect(result.map((i) => i.id)).toEqual(["done-1", "done-2"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Second page must thread the first page's cursor, or pagination silently caps.
      const secondBody = JSON.parse(
        (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
      );
      expect(secondBody.variables.after).toBe("cursor-1");
    });

    it("throws when project slug is missing", async () => {
      const tracker = new LinearTracker(undefined, "key");
      await expect(tracker.fetchTerminalIssues(makeConfig({ project_slug: "" }))).rejects.toThrow(
        "Linear project slug is required",
      );
    });

    it("pushes a labels filter into the GraphQL query when config.labels is set", async () => {
      const fetchMock = mockFetchResponse({
        data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker(undefined, "key");
      await tracker.fetchTerminalIssues(makeConfig({ labels: ["smith_feature", "smith_bug"] }));

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.query).toContain("labels: { name: { in: $labels } }");
      expect(body.query).toContain("$labels: [String!]");
      expect(body.variables.labels).toEqual(["smith_feature", "smith_bug"]);
    });

    it("treats an empty labels array as no filter for terminal queries", async () => {
      const fetchMock = mockFetchResponse({
        data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker(undefined, "key");
      await tracker.fetchTerminalIssues(makeConfig({ labels: [] }));

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.query).not.toContain("labels:");
      expect(body.variables.labels).toBeUndefined();
    });
  });

  describe("fetchProgressCounts", () => {
    it("counts only build-scoped issues as total and the terminal subset as done", async () => {
      globalThis.fetch = mockFetchResponse({
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
      });

      const tracker = new LinearTracker(undefined, "key");
      // active_states = ["Todo", "In Progress"]; terminal_states = ["Done", "Cancelled"]
      // "In Review" is outside the build scope and is excluded from total.
      expect(await tracker.fetchProgressCounts(makeConfig())).toEqual({ total: 3, done: 2 });
    });

    it("filters the query to the union of active and terminal build states", async () => {
      const fetchMock = mockFetchResponse({
        data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker(undefined, "key");
      await tracker.fetchProgressCounts(makeConfig());

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.query).toContain("state: { name: { in: $states } }");
      expect(body.query).toContain("$states: [String!]!");
      expect(body.variables.states).toEqual(
        expect.arrayContaining(["Todo", "In Progress", "Done", "Cancelled"]),
      );
    });

    it("paginates and sums counts across pages", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            data: {
              issues: {
                nodes: [{ state: { name: "Done" } }, { state: { name: "Todo" } }],
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            data: {
              issues: {
                nodes: [{ state: { name: "Done" } }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        });
      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker(undefined, "key");
      expect(await tracker.fetchProgressCounts(makeConfig())).toEqual({ total: 3, done: 2 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The second page must thread the first page's cursor, or pagination would
      // either loop on page 1 or silently drop later pages.
      const secondBody = JSON.parse(
        (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
      );
      expect(secondBody.variables.after).toBe("cursor-1");
    });

    it("counts a null-state ticket toward total but not done", async () => {
      globalThis.fetch = mockFetchResponse({
        data: {
          issues: {
            nodes: [{ state: { name: "Done" } }, { state: null }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });

      const tracker = new LinearTracker(undefined, "key");
      expect(await tracker.fetchProgressCounts(makeConfig())).toEqual({ total: 2, done: 1 });
    });

    it("pushes the label scope into the GraphQL query and variables", async () => {
      const fetchMock = mockFetchResponse({
        data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker(undefined, "key");
      await tracker.fetchProgressCounts(makeConfig({ labels: ["smith_feature"] }));

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.query).toContain("labels: { name: { in: $labels } }");
      expect(body.query).toContain("$labels: [String!]");
      expect(body.variables.labels).toEqual(["smith_feature"]);
    });

    it("throws when project slug is missing (caller keeps its prior reading)", async () => {
      const tracker = new LinearTracker(undefined, "key");
      await expect(tracker.fetchProgressCounts(makeConfig({ project_slug: "" }))).rejects.toThrow(
        "Linear project slug is required",
      );
    });

    it("propagates an HTTP error as a throw (not a silent zero)", async () => {
      globalThis.fetch = mockFetchResponse(null, false, 500);
      const tracker = new LinearTracker(undefined, "key");
      await expect(tracker.fetchProgressCounts(makeConfig())).rejects.toBeInstanceOf(
        LinearHttpError,
      );
    });

    it("propagates a GraphQL error (HTTP 200 with errors[]) as a throw", async () => {
      globalThis.fetch = mockFetchResponse({ errors: [{ message: "boom" }] });
      const tracker = new LinearTracker(undefined, "key");
      await expect(tracker.fetchProgressCounts(makeConfig())).rejects.toBeInstanceOf(
        LinearGraphQLError,
      );
    });
  });

  describe("updateIssueState", () => {
    it("fetches team states and updates issue with correct stateId", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            data: {
              issue: {
                team: {
                  states: {
                    nodes: [
                      { id: "state-1", name: "Todo" },
                      { id: "state-2", name: "In Progress" },
                      { id: "state-3", name: "Done" },
                    ],
                  },
                },
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            data: { issueUpdate: { success: true } },
          }),
        });
      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker(undefined, "lin_api_test");
      await tracker.updateIssueState("issue-1", "In Progress");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const mutationBody = JSON.parse(
        (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
      );
      expect(mutationBody.variables.stateId).toBe("state-2");
    });

    it("throws when state name is not found in team workflow", async () => {
      globalThis.fetch = mockFetchResponse({
        data: {
          issue: {
            team: {
              states: { nodes: [{ id: "state-1", name: "Todo" }] },
            },
          },
        },
      });

      const tracker = new LinearTracker(undefined, "lin_api_test");
      await expect(tracker.updateIssueState("issue-1", "Nonexistent")).rejects.toThrow(
        "None of [Nonexistent] found in team workflow. Available: Todo",
      );
    });
  });

  describe("createComment", () => {
    it("creates a comment and returns comment ID", async () => {
      globalThis.fetch = mockFetchResponse({
        data: {
          commentCreate: {
            success: true,
            comment: { id: "comment-abc" },
          },
        },
      });

      const tracker = new LinearTracker(undefined, "lin_api_test");
      const commentId = await tracker.createComment("issue-1", "Hello");

      expect(commentId).toBe("comment-abc");
    });

    it("sends correct mutation variables", async () => {
      const fetchMock = mockFetchResponse({
        data: {
          commentCreate: { success: true, comment: { id: "c-1" } },
        },
      });
      globalThis.fetch = fetchMock;

      const tracker = new LinearTracker(undefined, "lin_api_test");
      await tracker.createComment("issue-xyz", "My comment body");

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.variables.issueId).toBe("issue-xyz");
      expect(body.variables.body).toBe("My comment body");
    });
  });

  describe("error handling", () => {
    it("returns empty array on HTTP error response", async () => {
      globalThis.fetch = mockFetchResponse({}, false, 500);

      const tracker = new LinearTracker(undefined, "key");
      const result = await tracker.fetchCandidates(makeConfig());
      expect(result).toEqual([]);
    });

    it("returns empty array on GraphQL errors in response", async () => {
      globalThis.fetch = mockFetchResponse({
        errors: [{ message: "Field not found" }],
      });

      const tracker = new LinearTracker(undefined, "key");
      const result = await tracker.fetchCandidates(makeConfig());
      expect(result).toEqual([]);
    });

    it("returns empty array when response has no data", async () => {
      globalThis.fetch = mockFetchResponse({});

      const tracker = new LinearTracker(undefined, "key");
      const result = await tracker.fetchCandidates(makeConfig());
      expect(result).toEqual([]);
    });

    it("returns empty map on fetchIssueStatesByIds HTTP error", async () => {
      globalThis.fetch = mockFetchResponse({}, false, 500);

      const tracker = new LinearTracker(undefined, "key");
      const result = await tracker.fetchIssueStatesByIds(["id-a"]);
      expect(result).toEqual(new Map());
    });

    it("returns empty map on fetchIssueStatesByIds GraphQL error", async () => {
      globalThis.fetch = mockFetchResponse({
        errors: [{ message: "Field not found" }],
      });

      const tracker = new LinearTracker(undefined, "key");
      const result = await tracker.fetchIssueStatesByIds(["id-a"]);
      expect(result).toEqual(new Map());
    });
  });
});

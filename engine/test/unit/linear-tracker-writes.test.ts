import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinearGraphQLError, LinearHttpError, LinearTracker } from "../../src/tracker/linear.js";

interface FetchCall {
  url: string;
  body: { query: string; variables?: Record<string, unknown> };
}

function recordFetch(): {
  calls: FetchCall[];
  mock: (responses: Array<unknown | (() => unknown | Promise<unknown>)>) => void;
} {
  const calls: FetchCall[] = [];
  return {
    calls,
    mock(responses) {
      let i = 0;
      globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
        const body = JSON.parse((init as RequestInit).body as string);
        calls.push({ url: url as string, body });
        const next = responses[Math.min(i, responses.length - 1)];
        i++;
        const value = typeof next === "function" ? await (next as () => unknown)() : next;
        return value as Response;
      }) as typeof globalThis.fetch;
    },
  };
}

function jsonResponse(data: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => data,
  } as Response;
}

describe("LinearTracker writes", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("createIssue", () => {
    it("resolves labels + state and posts the issueCreate mutation", async () => {
      const f = recordFetch();
      f.mock([
        jsonResponse({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: "label-feat-id", name: "smith_feature" },
                  { id: "label-bug-id", name: "smith_bug" },
                ],
              },
            },
          },
        }),
        jsonResponse({
          data: { team: { states: { nodes: [{ id: "state-backlog-id", name: "Backlog" }] } } },
        }),
        jsonResponse({
          data: {
            issueCreate: {
              success: true,
              issue: { id: "issue-1", identifier: "FRG-100", url: "https://linear.app/frg-100" },
            },
          },
        }),
      ]);

      const tracker = new LinearTracker(undefined, "lin_api_test");
      const result = await tracker.createIssue({
        teamId: "team-1",
        title: "New feature",
        description: "Body",
        labels: ["smith_feature", "smith_bug"],
        stateName: "Backlog",
        projectId: "project-1",
        priority: 3,
      });

      expect(result).toEqual({
        id: "issue-1",
        identifier: "FRG-100",
        url: "https://linear.app/frg-100",
      });
      expect(f.calls).toHaveLength(3);
      const mutation = f.calls[2].body;
      expect(mutation.query).toContain("issueCreate");
      const input = (mutation.variables as { input: Record<string, unknown> }).input;
      expect(input.teamId).toBe("team-1");
      expect(input.title).toBe("New feature");
      expect(input.description).toBe("Body");
      expect(input.labelIds).toEqual(["label-feat-id", "label-bug-id"]);
      expect(input.stateId).toBe("state-backlog-id");
      expect(input.projectId).toBe("project-1");
      expect(input.priority).toBe(3);
    });

    it("caches label and state lookups across calls", async () => {
      const f = recordFetch();
      f.mock([
        jsonResponse({
          data: { team: { labels: { nodes: [{ id: "label-1", name: "smith_feature" }] } } },
        }),
        jsonResponse({
          data: { team: { states: { nodes: [{ id: "state-1", name: "Backlog" }] } } },
        }),
        jsonResponse({
          data: {
            issueCreate: {
              success: true,
              issue: { id: "i1", identifier: "FRG-1", url: "u1" },
            },
          },
        }),
        jsonResponse({
          data: {
            issueCreate: {
              success: true,
              issue: { id: "i2", identifier: "FRG-2", url: "u2" },
            },
          },
        }),
      ]);

      const tracker = new LinearTracker(undefined, "k");
      await tracker.createIssue({
        teamId: "team-1",
        title: "A",
        description: "",
        labels: ["smith_feature"],
        stateName: "Backlog",
      });
      await tracker.createIssue({
        teamId: "team-1",
        title: "B",
        description: "",
        labels: ["smith_feature"],
        stateName: "Backlog",
      });

      // 2 lookups (first call) + 2 mutations = 4 fetches; the second call must
      // hit cache and skip the lookup queries.
      expect(f.calls).toHaveLength(4);
      expect(f.calls[2].body.query).toContain("issueCreate");
      expect(f.calls[3].body.query).toContain("issueCreate");
    });

    it("throws a clear error when a label name is unknown", async () => {
      const f = recordFetch();
      f.mock([jsonResponse({ data: { team: { labels: { nodes: [] } } } })]);

      const tracker = new LinearTracker(undefined, "k");
      await expect(
        tracker.createIssue({
          teamId: "team-1",
          title: "T",
          description: "",
          labels: ["does_not_exist"],
        }),
      ).rejects.toThrow(/label "does_not_exist" not found/);
    });

    it("throws a clear error when a state name is unknown", async () => {
      const f = recordFetch();
      f.mock([jsonResponse({ data: { team: { states: { nodes: [] } } } })]);

      const tracker = new LinearTracker(undefined, "k");
      await expect(
        tracker.createIssue({
          teamId: "team-1",
          title: "T",
          description: "",
          stateName: "Bogus",
        }),
      ).rejects.toThrow(/state "Bogus" not found/);
    });

    it("throws when issueCreate returns success=false", async () => {
      const f = recordFetch();
      f.mock([jsonResponse({ data: { issueCreate: { success: false, issue: null } } })]);
      const tracker = new LinearTracker(undefined, "k");
      await expect(
        tracker.createIssue({ teamId: "team-1", title: "T", description: "" }),
      ).rejects.toThrow(/success=false/);
    });
  });

  describe("linkIssues", () => {
    it("for type=blocks posts the relation in the caller-supplied direction", async () => {
      const f = recordFetch();
      f.mock([jsonResponse({ data: { issueRelationCreate: { success: true } } })]);

      const tracker = new LinearTracker(undefined, "k");
      await tracker.linkIssues("from-1", "to-1", "blocks");

      const input = (f.calls[0].body.variables as { input: Record<string, unknown> }).input;
      expect(input).toEqual({ issueId: "from-1", relatedIssueId: "to-1", type: "blocks" });
    });

    it("for type=blockedBy inverts from/to and uses Linear's 'blocks' API type", async () => {
      const f = recordFetch();
      f.mock([jsonResponse({ data: { issueRelationCreate: { success: true } } })]);

      const tracker = new LinearTracker(undefined, "k");
      await tracker.linkIssues("child-bug", "parent-feat", "blockedBy");

      const input = (f.calls[0].body.variables as { input: Record<string, unknown> }).input;
      // child-bug blockedBy parent-feat ⇒ "parent-feat blocks child-bug"
      expect(input).toEqual({
        issueId: "parent-feat",
        relatedIssueId: "child-bug",
        type: "blocks",
      });
    });

    it("for type=related posts a related relation in the supplied direction", async () => {
      const f = recordFetch();
      f.mock([jsonResponse({ data: { issueRelationCreate: { success: true } } })]);

      const tracker = new LinearTracker(undefined, "k");
      await tracker.linkIssues("a", "b", "related");

      const input = (f.calls[0].body.variables as { input: Record<string, unknown> }).input;
      expect(input).toEqual({ issueId: "a", relatedIssueId: "b", type: "related" });
    });

    it("throws when issueRelationCreate returns success=false", async () => {
      const f = recordFetch();
      f.mock([jsonResponse({ data: { issueRelationCreate: { success: false } } })]);
      const tracker = new LinearTracker(undefined, "k");
      await expect(tracker.linkIssues("a", "b", "blocks")).rejects.toThrow(/success=false/);
    });
  });

  describe("getBlockRelations (FRG-952)", () => {
    it("splits direct vs inverse blocks relations and drops other types", async () => {
      const f = recordFetch();
      f.mock([
        jsonResponse({
          data: {
            issue: {
              relations: {
                nodes: [
                  { type: "blocks", relatedIssue: { id: "blocked-1" } },
                  { type: "related", relatedIssue: { id: "rel-1" } },
                ],
              },
              inverseRelations: {
                nodes: [
                  { type: "blocks", issue: { id: "blocker-1" } },
                  { type: "blocks", issue: { id: "blocker-2" } },
                  { type: "duplicate", issue: { id: "dup-1" } },
                ],
              },
            },
          },
        }),
      ]);

      const tracker = new LinearTracker(undefined, "k");
      const res = await tracker.getBlockRelations("issue-1");

      expect(res).toEqual({
        blockedByIssueIds: ["blocker-1", "blocker-2"],
        blocksIssueIds: ["blocked-1"],
      });
    });

    it("returns empty sets when the issue is missing and never throws", async () => {
      const f = recordFetch();
      f.mock([jsonResponse({ data: { issue: null } })]);

      const tracker = new LinearTracker(undefined, "k");
      const res = await tracker.getBlockRelations("missing");

      expect(res).toEqual({ blockedByIssueIds: [], blocksIssueIds: [] });
    });

    it("degrades to empty sets when the underlying request fails", async () => {
      globalThis.fetch = vi.fn(async () => jsonResponse({}, false, 503)) as typeof globalThis.fetch;

      const tracker = new LinearTracker(undefined, "k");
      const res = await tracker.getBlockRelations("any");

      expect(res).toEqual({ blockedByIssueIds: [], blocksIssueIds: [] });
    });
  });

  describe("graphql helper error types", () => {
    it("throws LinearHttpError on non-2xx", async () => {
      globalThis.fetch = vi.fn(async () => jsonResponse({}, false, 503)) as typeof globalThis.fetch;
      const tracker = new LinearTracker(undefined, "k");
      await expect(
        tracker.createIssue({ teamId: "t", title: "x", description: "" }),
      ).rejects.toBeInstanceOf(LinearHttpError);
    });

    it("throws LinearGraphQLError with extensions.code on errors[]", async () => {
      globalThis.fetch = vi.fn(async () =>
        jsonResponse({
          errors: [{ message: "boom", extensions: { code: "INTERNAL_ERROR" } }],
        }),
      ) as typeof globalThis.fetch;
      const tracker = new LinearTracker(undefined, "k");
      try {
        await tracker.createIssue({ teamId: "t", title: "x", description: "" });
        expect.fail("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(LinearGraphQLError);
        expect((err as LinearGraphQLError).code).toBe("INTERNAL_ERROR");
      }
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BasecampAdapterOptions,
  BasecampAuthRequiredError,
  BasecampHttpError,
  BasecampTracker,
  RefreshingBasecampTokenProvider,
} from "../../../src/tracker/basecamp.js";
import type { TrackerConfig } from "../../../src/tracker/types.js";

// Real Basecamp column ids are numeric (used as both the path segment for
// `cards.json` lookups and the `column_id` body field on a move), so the
// fixture uses numeric-string ids rather than readable slugs.
const COLUMNS = {
  Backlog: "601",
  Triage: "602",
  Todo: "603",
  "In Progress": "604",
  "AI Review": "605",
  QA: "606",
  "Human Review": "607",
  Rework: "608",
  Merging: "609",
  Done: "610",
};

// Matches the assignee id used on fixture cards below, so "me" ->
// identityId resolution lines up with the assignment-filter/claim tests.
const FORGE_IDENTITY_ID = "2001";

function makeTracker(overrides: Partial<BasecampAdapterOptions> = {}) {
  return new BasecampTracker(undefined, "bc_test_token", {
    accountId: "999",
    projectId: "42",
    identityId: FORGE_IDENTITY_ID,
    columns: COLUMNS,
    cardTableId: "7001",
    ...overrides,
  });
}

function makeConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    kind: "basecamp",
    project_slug: "42",
    active_states: ["Todo"],
    terminal_states: ["Done", "Cancelled"],
    ...overrides,
  };
}

function makeRawCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    title: "Fix the flaky migration script",
    content: "Some card description",
    assignees: [{ id: 2001, name: "Forge" }],
    app_url: "https://3.basecamp.com/999/buckets/42/card_tables/cards/1001",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    parent: { id: 5, title: "Todo" },
    ...overrides,
  };
}

function jsonResponse(
  data: unknown,
  headers: Record<string, string> = {},
  ok = true,
  status = 200,
) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    headers: {
      get: (name: string) => headers[name] ?? null,
    },
    text: async () => JSON.stringify(data),
  };
}

function mockFetchOnce(
  data: unknown,
  headers: Record<string, string> = {},
  ok = true,
  status = 200,
) {
  return vi.fn().mockResolvedValue(jsonResponse(data, headers, ok, status));
}

describe("BasecampTracker", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("has kind set to 'basecamp'", () => {
    const tracker = makeTracker();
    expect(tracker.kind).toBe("basecamp");
  });

  describe("fetchCandidates", () => {
    it("returns normalized issues for cards in the active-state column", async () => {
      globalThis.fetch = mockFetchOnce([makeRawCard()]);
      const tracker = makeTracker();
      const result = await tracker.fetchCandidates(makeConfig());

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "1001",
        identifier: "BC-1001",
        title: "Fix the flaky migration script",
        description: "Some card description",
        state: "Todo",
        priority: null,
        assignee: "2001",
        labels: [],
        branchName: "basecamp/bc-1001",
        url: "https://3.basecamp.com/999/buckets/42/card_tables/cards/1001",
        blockedBy: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      });
    });

    it("surfaces a PR link already pasted in the card's own body", async () => {
      globalThis.fetch = mockFetchOnce([
        makeRawCard({
          content: 'Built here: https://github.com/acme/widgets/pull/213"></a>',
        }),
      ]);
      const tracker = makeTracker();
      const result = await tracker.fetchCandidates(makeConfig());

      expect(result[0].existingPrUrl).toBe("https://github.com/acme/widgets/pull/213");
    });

    it("looks up a PR link from comments when the card reached a review stage with no PR in its body", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse([makeRawCard({ parent: { id: 5, title: "AI Review" } })]),
        )
        .mockResolvedValueOnce(
          jsonResponse([
            { id: 1, content: "no link here", created_at: "2026-01-01T00:00:00Z" },
            {
              id: 2,
              content: "PR is up and green: https://github.com/acme/widgets/pull/213",
              created_at: "2026-01-02T00:00:00Z",
            },
          ]),
        );
      globalThis.fetch = fetchMock;
      const tracker = makeTracker();
      const result = await tracker.fetchCandidates(makeConfig({ active_states: ["AI Review"] }));

      expect(result[0].existingPrUrl).toBe("https://github.com/acme/widgets/pull/213");
      expect(fetchMock.mock.calls[1][0]).toContain("/recordings/1001/comments.json");
    });

    it("does not fetch comments for a stage where a PR could not exist yet (Triage)", async () => {
      const fetchMock = mockFetchOnce([makeRawCard({ parent: { id: 5, title: "Triage" } })]);
      globalThis.fetch = fetchMock;
      const tracker = makeTracker();
      await tracker.fetchCandidates(makeConfig({ active_states: ["Triage"] }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("leaves existingPrUrl unset when the comments lookup itself fails (fail-open)", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse([makeRawCard({ parent: { id: 5, title: "AI Review" } })]),
        )
        .mockResolvedValueOnce(jsonResponse({}, {}, false, 500));
      globalThis.fetch = fetchMock;
      const tracker = makeTracker();
      const result = await tracker.fetchCandidates(makeConfig({ active_states: ["AI Review"] }));

      expect(result[0].existingPrUrl).toBeUndefined();
    });

    it("requests the configured column id for each active state", async () => {
      const fetchMock = mockFetchOnce([]);
      globalThis.fetch = fetchMock;
      const tracker = makeTracker();
      await tracker.fetchCandidates(makeConfig({ active_states: ["Todo", "In Progress"] }));

      const urls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(urls.some((u) => u.includes("/card_tables/lists/603/cards.json"))).toBe(true);
      expect(urls.some((u) => u.includes("/card_tables/lists/604/cards.json"))).toBe(true);
    });

    it("follows the Link header to a second page", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse([makeRawCard({ id: 1001 })], {
            Link: '<https://3.basecampapi.com/999/buckets/42/card_tables/lists/603/cards.json?page=2>; rel="next"',
          }),
        )
        .mockResolvedValueOnce(jsonResponse([makeRawCard({ id: 1002 })]));
      globalThis.fetch = fetchMock;

      const tracker = makeTracker();
      const result = await tracker.fetchCandidates(makeConfig());

      expect(result.map((i) => i.id)).toEqual(["1001", "1002"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Exact match, not just toContain("page=2") — the account id ("999")
      // must appear exactly once. A regression that re-prepends the account
      // id when reconstructing `nextPath` (see basecamp.ts's `request()`)
      // still contains "page=2" as a substring, so a loose assertion here
      // would not have caught it.
      expect(fetchMock.mock.calls[1][0]).toBe(
        "https://3.basecampapi.com/999/buckets/42/card_tables/lists/603/cards.json?page=2",
      );
    });

    it("filters by assignee when config.assignee resolves to a specific person", async () => {
      globalThis.fetch = mockFetchOnce([
        makeRawCard({ id: 1, assignees: [{ id: 2001, name: "Forge" }] }),
        makeRawCard({ id: 2, assignees: [{ id: 3002, name: "Someone else" }] }),
      ]);
      const tracker = makeTracker();
      const result = await tracker.fetchCandidates(makeConfig({ assignee: "2001" }));

      expect(result).toHaveLength(1);
      expect(result[0].assignee).toBe("2001");
    });

    it("resolves 'me' to the configured identityId", async () => {
      globalThis.fetch = mockFetchOnce([
        makeRawCard({ id: 1, assignees: [{ id: 2001, name: "Forge" }] }),
        makeRawCard({ id: 2, assignees: [{ id: 9999, name: "Other" }] }),
      ]);
      const tracker = makeTracker();
      const result = await tracker.fetchCandidates(makeConfig({ assignee: "me" }));

      expect(result).toHaveLength(1);
      expect(result[0].assignee).toBe("2001");
    });

    it("skips a stage with no configured column id and warns rather than throwing", async () => {
      globalThis.fetch = mockFetchOnce([]);
      const tracker = makeTracker({ columns: { Todo: undefined } as unknown as typeof COLUMNS });
      const result = await tracker.fetchCandidates(makeConfig());
      expect(result).toEqual([]);
    });

    it("returns empty array on HTTP error instead of throwing", async () => {
      globalThis.fetch = mockFetchOnce({}, {}, false, 500);
      const tracker = makeTracker();
      const result = await tracker.fetchCandidates(makeConfig());
      expect(result).toEqual([]);
    });

    it("throws when project id is missing", async () => {
      const tracker = makeTracker({ projectId: "" });
      await expect(tracker.fetchCandidates(makeConfig())).rejects.toThrow(
        "Basecamp project (bucket) id is required",
      );
    });
  });

  describe("fetchTerminalIssues", () => {
    it("folds Cancelled/Closed/Canceled/Duplicate into the single Done column", async () => {
      const fetchMock = mockFetchOnce([makeRawCard({ parent: { id: 9, title: "Done" } })]);
      globalThis.fetch = fetchMock;

      const tracker = makeTracker();
      const result = await tracker.fetchTerminalIssues(
        makeConfig({ terminal_states: ["Done", "Cancelled", "Canceled", "Duplicate"] }),
      );

      // All four terminal names fold to the same "Done" column, so only one
      // column fetch should happen.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain("/card_tables/lists/610/cards.json");
      expect(result).toHaveLength(1);
      expect(result[0].state).toBe("Done");
    });
  });

  describe("fetchProgressCounts", () => {
    it("counts total across active+terminal columns and done within the terminal column", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse([makeRawCard({ id: 1, parent: { id: 1, title: "Todo" } })]),
        )
        .mockResolvedValueOnce(
          jsonResponse([makeRawCard({ id: 2, parent: { id: 9, title: "Done" } })]),
        );
      globalThis.fetch = fetchMock;

      const tracker = makeTracker();
      const result = await tracker.fetchProgressCounts(makeConfig());
      expect(result).toEqual({ total: 2, done: 1 });
    });

    it("throws on HTTP error (caller keeps its prior reading)", async () => {
      globalThis.fetch = mockFetchOnce({}, {}, false, 500);
      const tracker = makeTracker();
      await expect(tracker.fetchProgressCounts(makeConfig())).rejects.toBeInstanceOf(
        BasecampHttpError,
      );
    });
  });

  describe("fetchIssueStatesByIds", () => {
    it("returns a map of card id to column title", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(makeRawCard({ id: 1001, parent: { id: 5, title: "QA" } })),
        )
        .mockResolvedValueOnce(
          jsonResponse(makeRawCard({ id: 1002, parent: { id: 9, title: "Done" } })),
        );
      globalThis.fetch = fetchMock;

      const tracker = makeTracker();
      const result = await tracker.fetchIssueStatesByIds(["1001", "1002"]);

      expect(result.get("1001")).toBe("QA");
      expect(result.get("1002")).toBe("Done");
    });

    it("returns empty map for empty ids", async () => {
      const tracker = makeTracker();
      const result = await tracker.fetchIssueStatesByIds([]);
      expect(result.size).toBe(0);
    });

    it("drops an id whose card lookup fails rather than failing the whole batch", async () => {
      globalThis.fetch = mockFetchOnce({}, {}, false, 404);
      const tracker = makeTracker();
      const result = await tracker.fetchIssueStatesByIds(["1001"]);
      expect(result.size).toBe(0);
    });
  });

  describe("claimIssue", () => {
    it("claims an unassigned card and confirms on re-read", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: 1001, assignees: [], parent: { title: "Todo" } })) // read before
        .mockResolvedValueOnce(jsonResponse({})) // write
        .mockResolvedValueOnce(
          jsonResponse({ id: 1001, assignees: [{ id: 2001 }], parent: { title: "Todo" } }),
        ); // reread
      globalThis.fetch = fetchMock;

      const tracker = makeTracker();
      const result = await tracker.claimIssue({ issueId: "1001", assignee: "me" });

      expect(result).toEqual({ claimed: true, heldBy: "2001" });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const writeBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(writeBody.assignee_ids).toEqual([2001]);
    });

    it("refuses to claim a card already assigned to someone else", async () => {
      globalThis.fetch = mockFetchOnce({ id: 1001, assignees: [{ id: 9999 }] });
      const tracker = makeTracker();
      const result = await tracker.claimIssue({ issueId: "1001", assignee: "me" });

      expect(result).toEqual({ claimed: false, heldBy: "9999", reason: "already-claimed" });
    });

    it("reads and writes the card's own assignee_ids field, not a separate to-do", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: 1001, assignees: [] }))
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({ id: 1001, assignees: [{ id: 2001 }] }));
      globalThis.fetch = fetchMock;

      const tracker = makeTracker();
      await tracker.claimIssue({ issueId: "1001", assignee: "me" });

      for (const call of fetchMock.mock.calls) {
        expect(call[0] as string).toContain("/card_tables/cards/1001.json");
      }
      const writeBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(writeBody).toHaveProperty("assignee_ids");
    });

    it("does not write at all when already held by someone else", async () => {
      const fetchMock = mockFetchOnce({ id: 1001, assignees: [{ id: 9999 }] });
      globalThis.fetch = fetchMock;

      const tracker = makeTracker();
      await tracker.claimIssue({ issueId: "1001", assignee: "me" });

      expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial read
    });

    it("detects a lost race on the confirming re-read", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: 1001, assignees: [] })) // before: unassigned
        .mockResolvedValueOnce(jsonResponse({})) // our write
        .mockResolvedValueOnce(jsonResponse({ id: 1001, assignees: [{ id: 2001 }, { id: 4004 }] })); // reread: someone else also wrote
      globalThis.fetch = fetchMock;

      const tracker = makeTracker();
      const result = await tracker.claimIssue({ issueId: "1001", assignee: "me" });

      expect(result).toEqual({ claimed: false, heldBy: "4004", reason: "lost-race" });
    });

    it("refuses with 'not-active' when the card has moved out of activeStates", async () => {
      const fetchMock = mockFetchOnce({
        id: 1001,
        assignees: [],
        parent: { title: "Done" },
      });
      globalThis.fetch = fetchMock;

      const tracker = makeTracker();
      const result = await tracker.claimIssue(
        { issueId: "1001", assignee: "me" },
        { activeStates: ["Todo"] },
      );

      expect(result).toEqual({ claimed: false, reason: "not-active" });
      // The column check uses the same initial read — no extra card fetch.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("updateIssueState", () => {
    // moveCard uses the dedicated POST /card_tables/:id/moves.json endpoint,
    // not a PUT on the card resource — see basecamp-writes.ts's header
    // comment for why a bare card PUT does not reliably move a card between
    // columns (it 404s or silently no-ops depending on the source column's
    // underlying Basecamp archetype, verified against the live API).
    it("moves the card to the matching column via the moves endpoint", async () => {
      const fetchMock = mockFetchOnce({});
      globalThis.fetch = fetchMock;

      const tracker = makeTracker();
      await tracker.updateIssueState("1001", "QA");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain("/card_tables/7001/moves.json");
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body).toEqual({ source_id: 1001, target_id: Number(COLUMNS.QA), position: 0 });
    });

    it("moving to Done only moves the card — there is no separate to-do to complete", async () => {
      const fetchMock = mockFetchOnce({});
      globalThis.fetch = fetchMock;

      const tracker = makeTracker();
      await tracker.updateIssueState("1001", "Done");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain("/card_tables/7001/moves.json");
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.target_id).toBe(Number(COLUMNS.Done));
    });

    it("folds a Cancelled state name into the Done column with a single write", async () => {
      const fetchMock = mockFetchOnce({});
      globalThis.fetch = fetchMock;

      const tracker = makeTracker();
      await tracker.updateIssueState("1001", "Cancelled");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const cardBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(cardBody.target_id).toBe(Number(COLUMNS.Done));
    });

    it("throws for an unrecognized state name", async () => {
      const tracker = makeTracker();
      await expect(tracker.updateIssueState("1001", "Nonexistent")).rejects.toThrow(
        /Unknown Basecamp pipeline stage/,
      );
    });

    it("throws when the target stage has no configured column id", async () => {
      const tracker = makeTracker({ columns: {} });
      await expect(tracker.updateIssueState("1001", "QA")).rejects.toThrow(
        /No Basecamp column id configured/,
      );
    });

    it("throws when no card_table_id is configured", async () => {
      const tracker = makeTracker({ cardTableId: undefined });
      await expect(tracker.updateIssueState("1001", "QA")).rejects.toThrow(
        /No Basecamp card_table_id configured/,
      );
    });
  });

  describe("createComment", () => {
    it("posts a comment on the card's own recording and returns its id", async () => {
      const fetchMock = mockFetchOnce({ id: 777 });
      globalThis.fetch = fetchMock;

      const tracker = makeTracker();
      const commentId = await tracker.createComment("1001", "PR merged: https://example.com/pr/1");

      expect(commentId).toBe("777");
      expect(fetchMock.mock.calls[0][0]).toContain("/recordings/1001/comments.json");
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.content).toBe("PR merged: https://example.com/pr/1");
    });
  });

  describe("fetchIssueComments", () => {
    it("returns normalized comments for the card's own recording", async () => {
      globalThis.fetch = mockFetchOnce([
        { id: 1, content: "First", created_at: "2026-01-01T00:00:00Z" },
        { id: 2, content: "Second", created_at: "2026-01-02T00:00:00Z" },
      ]);

      const tracker = makeTracker();
      const result = await tracker.fetchIssueComments("1001");

      expect(result).toEqual([
        { id: "1", body: "First", createdAt: "2026-01-01T00:00:00Z" },
        { id: "2", body: "Second", createdAt: "2026-01-02T00:00:00Z" },
      ]);
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
        "/recordings/1001/comments.json",
      );
    });
  });

  describe("unassignIssue", () => {
    it("clears the card's assignees", async () => {
      const fetchMock = mockFetchOnce({});
      globalThis.fetch = fetchMock;

      const tracker = makeTracker();
      await tracker.unassignIssue("1001");

      expect(fetchMock.mock.calls[0][0]).toContain("/card_tables/cards/1001.json");
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.assignee_ids).toEqual([]);
    });
  });

  describe("transport", () => {
    it("sends a Bearer authorization header with the configured token", async () => {
      const fetchMock = mockFetchOnce([]);
      globalThis.fetch = fetchMock;

      const tracker = makeTracker();
      await tracker.fetchCandidates(makeConfig());

      const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer bc_test_token");
    });

    it("builds the request URL from endpoint + accountId + path", async () => {
      const fetchMock = mockFetchOnce([]);
      globalThis.fetch = fetchMock;

      const tracker = makeTracker();
      await tracker.fetchCandidates(makeConfig());

      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://3.basecampapi.com/999/buckets/42/card_tables/lists/603/cards.json",
      );
    });

    it("uses a custom endpoint when provided", async () => {
      const fetchMock = mockFetchOnce([]);
      globalThis.fetch = fetchMock;

      const tracker = new BasecampTracker("https://custom.basecamp.test", "token", {
        accountId: "1",
        projectId: "2",
        columns: COLUMNS,
      });
      await tracker.fetchCandidates(makeConfig());

      expect(fetchMock.mock.calls[0][0] as string).toContain("https://custom.basecamp.test/1/");
    });

    it("401 mid-run -> refresh + retry: a token provider gets one forced refresh, then the request succeeds", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({}, {}, false, 401))
        .mockResolvedValueOnce(jsonResponse([makeRawCard()]));
      globalThis.fetch = fetchMock;

      const getAccessToken = vi
        .fn()
        .mockResolvedValueOnce("bc_at_expired")
        .mockResolvedValueOnce("bc_at_fresh");
      const tracker = makeTracker({
        apiKey: undefined,
        tokenProvider: { getAccessToken },
      });

      const result = await tracker.fetchCandidates(makeConfig());

      expect(result).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(getAccessToken).toHaveBeenNthCalledWith(1, { forceRefresh: false });
      expect(getAccessToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
      expect((fetchMock.mock.calls[1][1].headers as Record<string, string>).Authorization).toBe(
        "Bearer bc_at_fresh",
      );
    });

    it("refresh fails -> clear status: a dead refresh token surfaces as a 'Basecamp sign-in needed' error, not a generic 401", async () => {
      globalThis.fetch = mockFetchOnce({}, {}, false, 401);
      const getAccessToken = vi
        .fn()
        .mockRejectedValue(
          new BasecampAuthRequiredError("Basecamp sign-in needed: refresh_token revoked"),
        );
      const tracker = makeTracker({ apiKey: undefined, tokenProvider: { getAccessToken } });

      await expect(tracker.fetchProgressCounts(makeConfig())).rejects.toThrow(
        /Basecamp sign-in needed/,
      );
    });

    it("does not retry a second time on a persistent 401", async () => {
      const fetchMock = mockFetchOnce({}, {}, false, 401);
      globalThis.fetch = fetchMock;
      const getAccessToken = vi.fn().mockResolvedValue("bc_at_still_bad");
      const tracker = makeTracker({ apiKey: undefined, tokenProvider: { getAccessToken } });

      await expect(tracker.fetchProgressCounts(makeConfig())).rejects.toBeInstanceOf(
        BasecampHttpError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2); // one try + one forced-refresh retry, no more
    });

    it("exposes authStatus from a RefreshingBasecampTokenProvider-backed tracker", async () => {
      const tokenProvider = new RefreshingBasecampTokenProvider({
        refresh: async () => ({ accessToken: "bc_at_x", expiresAtMs: Date.now() + 3_600_000 }),
      });
      const tracker = makeTracker({ apiKey: undefined, tokenProvider });

      globalThis.fetch = mockFetchOnce([]);
      await tracker.fetchCandidates(makeConfig());

      expect(tracker.authStatus?.ok).toBe(true);
      expect(tracker.authStatus?.expiresAt).toBeDefined();
    });

    it("a static apiKey tracker has no auth status to report (nothing to refresh)", () => {
      const tracker = makeTracker();
      expect(tracker.authStatus).toBeUndefined();
    });
  });
});

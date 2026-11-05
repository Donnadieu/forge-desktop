import { afterEach, describe, expect, it, vi } from "vitest";
import { BasecampTracker } from "../../../src/tracker/basecamp.js";

const COLUMNS = { Backlog: "601", Todo: "603", "Human Review": "607", Done: "610" };

function card(
  id: number,
  column: { id: number; title: string },
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    title: `Card ${id}`,
    content: null,
    assignees: [{ id: 50, name: "Sam Rivera" }],
    app_url: `https://3.basecamp.com/999/buckets/42/card_tables/cards/${id}`,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
    comments_count: 1,
    parent: column,
    ...extra,
  };
}

function respond(body: unknown, link?: string) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: link ? { Link: link } : {},
  });
}

function tracker() {
  return new BasecampTracker(undefined, "bc_test_token", {
    accountId: "999",
    projectId: "42",
    identityId: "50",
    columns: COLUMNS,
    cardTableId: "7001",
  });
}

describe("BasecampTracker.fetchBoard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads every board column, with labels on Backlog cards and pull requests on review cards", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.endsWith("/lists/601/cards.json"))
          return respond([card(1, { id: 601, title: "backlog" })]);
        if (url.endsWith("/lists/603/cards.json")) return respond([]);
        if (url.endsWith("/lists/607/cards.json"))
          return respond([card(2, { id: 607, title: "Waiting on Sam" })]);
        if (url.endsWith("/recordings/1/comments.json"))
          return respond([
            { content: "<h2>Forge Triage</h2><p><strong>Label:</strong> ready-for-execution</p>" },
          ]);
        if (url.endsWith("/recordings/2/comments.json"))
          return respond([{ content: '<a href="https://github.com/o/r/pull/7">PR</a>' }]);
        return new Response("nope", { status: 404 });
      }),
    );
    const cards = await tracker().fetchBoard({} as never, ["Backlog", "Todo", "Human Review"]);
    expect(cards).toEqual([
      expect.objectContaining({
        id: "1",
        identifier: "BC-1",
        state: "Backlog",
        labels: ["ready-for-execution"],
        prUrl: null,
        assignee: "Sam Rivera",
      }),
      // A renamed column still lands in the stage it is mapped to.
      expect.objectContaining({
        id: "2",
        state: "Human Review",
        labels: [],
        prUrl: "https://github.com/o/r/pull/7",
      }),
    ]);
    expect(urls[0]).toBe(
      "https://3.basecampapi.com/999/buckets/42/card_tables/lists/601/cards.json",
    );
  });

  it("reads a card's comments again only when the card changed", async () => {
    let comments = 0;
    let updated = "2026-11-02T00:00:00Z";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/lists/601/cards.json"))
          return respond([card(1, { id: 601, title: "Backlog" }, { updated_at: updated })]);
        if (url.endsWith("/comments.json")) {
          comments++;
          return respond([]);
        }
        return new Response("nope", { status: 404 });
      }),
    );
    const t = tracker();
    await t.fetchBoard({} as never, ["Backlog"]);
    await t.fetchBoard({} as never, ["Backlog"]);
    expect(comments).toBe(1);
    updated = "2026-11-03T00:00:00Z";
    await t.fetchBoard({} as never, ["Backlog"]);
    expect(comments).toBe(2);
  });

  it("skips the comments read for a card with none, and columns that aren't mapped", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return respond([card(1, { id: 601, title: "Backlog" }, { comments_count: 0 })]);
      }),
    );
    await tracker().fetchBoard({} as never, ["Backlog", "QA"]);
    expect(urls).toEqual([
      "https://3.basecampapi.com/999/buckets/42/card_tables/lists/601/cards.json",
    ]);
  });

  it("follows Basecamp's next-page link without doubling the account id", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.endsWith("cards.json"))
          return respond(
            [card(1, { id: 603, title: "Todo" }, { comments_count: 0 })],
            '<https://3.basecampapi.com/999/buckets/42/card_tables/lists/603/cards.json?page=2>; rel="next"',
          );
        return respond([card(3, { id: 603, title: "Todo" }, { comments_count: 0 })]);
      }),
    );
    const cards = await tracker().fetchBoard({} as never, ["Todo"]);
    expect(cards.map((c) => c.id)).toEqual(["1", "3"]);
    expect(urls[1]).toBe(
      "https://3.basecampapi.com/999/buckets/42/card_tables/lists/603/cards.json?page=2",
    );
  });

  it("throws when Basecamp can't be reached, so the board can say so", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503, statusText: "Unavailable" })),
    );
    await expect(tracker().fetchBoard({} as never, ["Todo"])).rejects.toThrow(/503/);
  });
});

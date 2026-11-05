import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BasecampTracker } from "../../../src/tracker/basecamp.js";
import { extractLabels } from "../../../src/tracker/basecamp-normalize.js";
import type { TrackerConfig } from "../../../src/tracker/types.js";

// Basecamp cards have no label field. The workflow's "add the
// ready-for-execution label" step is written as a `Label:` line in the
// card's `## Forge Triage` comment; these tests pin how Forge reads it back.

// Real comment HTML Forge's triage agent wrote on the ConstructEase board.
const TRIAGE_COMMENT =
  '<h2 dir="auto">Forge Triage</h2>\n<p dir="auto"><br></p>\n' +
  '<p dir="auto"><strong>Label:</strong> <code>ready-for-execution</code> ' +
  "(Basecamp cards have no labels, so this line is the marker.)</p>\n" +
  '<h3 dir="auto">Summary</h3>';

const TRIAGE_COMMENT_INLINE =
  '<p dir="auto"><strong>Label: ready-for-execution</strong> (Basecamp cards have no labels.)\n' +
  "<strong>Depends on:</strong> nothing</p>";

describe("extractLabels", () => {
  it("reads the label from a real triage comment", () => {
    expect(extractLabels(TRIAGE_COMMENT)).toEqual(["ready-for-execution"]);
    expect(extractLabels(TRIAGE_COMMENT_INLINE)).toEqual(["ready-for-execution"]);
  });

  it("reads plain-text and comma-separated Labels: lines, lowercased", () => {
    expect(extractLabels("Labels: QA-Complete, ready-for-execution\nmore")).toEqual([
      "qa-complete",
      "ready-for-execution",
    ]);
  });

  it("reads a label after a <br> line break", () => {
    expect(extractLabels("Summary<br>Label: ready-for-execution")).toEqual(["ready-for-execution"]);
  });

  it("ignores prose that only mentions a label mid-line", () => {
    expect(
      extractLabels("<p>Do not add the label: ready-for-execution until D14 lands.</p>"),
    ).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(extractLabels(null)).toEqual([]);
    expect(extractLabels("")).toEqual([]);
  });
});

function jsonResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
  };
}

function rawCard(id: number, column: string, commentsCount?: number) {
  return {
    id,
    title: `Card ${id}`,
    content: "",
    assignees: [],
    app_url: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    comments_count: commentsCount,
    parent: { id: 1, title: column },
  };
}

function makeTracker() {
  return new BasecampTracker(undefined, "bc_test_token", {
    accountId: "999",
    projectId: "42",
    identityId: "2001",
    columns: { Backlog: "601", Triage: "602", Todo: "603" },
    cardTableId: "7001",
  });
}

const config = (active_states: string[]): TrackerConfig => ({
  kind: "basecamp",
  project_slug: "42",
  active_states,
  terminal_states: ["Done"],
});

describe("BasecampTracker.fetchCandidates — labels from comments", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fills a Backlog card's labels from its comments", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([rawCard(1001, "Backlog", 2)]))
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 1, content: "<p>Looks good</p>", created_at: "2026-01-01T00:00:00Z" },
          { id: 2, content: TRIAGE_COMMENT, created_at: "2026-01-02T00:00:00Z" },
        ]),
      );
    globalThis.fetch = fetchMock;

    const [issue] = await makeTracker().fetchCandidates(config(["Backlog"]));

    expect(issue.labels).toEqual(["ready-for-execution"]);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://3.basecampapi.com/999/buckets/42/recordings/1001/comments.json",
    );
  });

  it("skips the comments fetch for a Backlog card with no comments", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([rawCard(1001, "Backlog", 0)]));
    globalThis.fetch = fetchMock;

    const [issue] = await makeTracker().fetchCandidates(config(["Backlog"]));

    expect(issue.labels).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not read comments for cards outside Backlog", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([rawCard(1001, "Triage", 3)]));
    globalThis.fetch = fetchMock;

    const [issue] = await makeTracker().fetchCandidates(config(["Triage"]));

    expect(issue.labels).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves labels empty when the comments lookup fails (fail-open)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([rawCard(1001, "Backlog", 1)]))
      .mockResolvedValueOnce(jsonResponse({}, false, 500));
    globalThis.fetch = fetchMock;

    const issues = await makeTracker().fetchCandidates(config(["Backlog"]));

    expect(issues).toHaveLength(1);
    expect(issues[0].labels).toEqual([]);
  });
});

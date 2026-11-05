/**
 * The GitHub Issues tracker against answers recorded live from GitHub (a private
 * throwaway repo and project, Nov 5 2026): test/fixtures/github/*.json hold the
 * variables Forge sent and GitHub's answer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callGitHub } from "../../../src/mcp/github-graphql-server.js";
import { StaticBasecampTokenProvider } from "../../../src/tracker/basecamp-token-provider.js";
import { GitHubTracker } from "../../../src/tracker/github.js";
import type { TrackerConfig } from "../../../src/tracker/types.js";

const DIR = join(import.meta.dirname, "..", "..", "fixtures", "github");
const rec = (name: string) =>
  JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as {
    variables: Record<string, unknown>;
    response: { data: unknown };
  };

const PROJECT = "PVT_kwHOAVs6k84BqVu3";
const FIELD = "PVTSSF_lAHOAVs6k84BqVu3zhotTTw";
const COLUMNS = {
  Backlog: "90228fc5",
  Triage: "87daeb1a",
  Todo: "f75ad846",
  "In Progress": "47fc9ee4",
  "AI Review": "303e3eff",
  QA: "50ee9d16",
  "Human Review": "f99757e2",
  Rework: "e4da4ccb",
  Merging: "26105c1d",
  Done: "98236657",
};
const ISSUE2 = "I_kwDOVkEq-M8AAAABcw-jeg";
const CONFIG: TrackerConfig = {
  kind: "github",
  project_slug: PROJECT,
  active_states: ["Todo", "In Progress", "Rework"],
  terminal_states: ["Done", "Closed"],
};

function tracker(token = new StaticBasecampTokenProvider("gh_test_token")) {
  return new GitHubTracker({
    projectId: PROJECT,
    statusFieldId: FIELD,
    columns: COLUMNS,
    tokenProvider: token,
  });
}

/** Serves recorded answers in order; each request must be the operation the recording came from. */
function replay(...names: string[]) {
  const sent: Array<{ op: string; variables: Record<string, unknown>; auth: string | null }> = [];
  const queue = [...names];
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const op = body.query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "anon";
    sent.push({
      op,
      variables: body.variables,
      auth: new Headers(init.headers).get("Authorization"),
    });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request ${op}`);
    return new Response(JSON.stringify(rec(next).response), { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return sent;
}

describe("GitHubTracker on recorded GitHub answers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the board: columns from Status, labels, the closing pull request, open blockers", async () => {
    const sent = replay("project-items");
    const cards = await tracker().fetchBoard(CONFIG, Object.keys(COLUMNS));
    expect(sent[0]).toMatchObject({
      op: "ProjectItems",
      variables: { project: PROJECT, after: null },
    });
    expect(sent[0].auth).toBe("Bearer gh_test_token");
    const by = Object.fromEntries(cards.map((c) => [c.identifier, c]));
    expect(Object.keys(by).sort()).toEqual([
      "forge-desktop-test#1",
      "forge-desktop-test#2",
      "forge-desktop-test#3",
      "forge-desktop-test#4",
      "forge-desktop-test#5",
    ]);
    expect(by["forge-desktop-test#1"].state).toBe("In Progress");
    expect(by["forge-desktop-test#3"]).toMatchObject({
      state: "Backlog",
      labels: ["ready-for-execution"],
    });
    expect(by["forge-desktop-test#4"]).toMatchObject({
      state: "Human Review",
      prUrl: "https://github.com/Donnadieu/forge-desktop-test/pull/6",
    });
    expect(by["forge-desktop-test#5"]).toMatchObject({
      state: "Todo",
      blockedBy: ["forge-desktop-test#2"],
    });
    expect(by["forge-desktop-test#2"].branchName).toBe("github/forge-desktop-test-2");
  });

  it("gives agents only the active columns' cards, with their blockers", async () => {
    replay("project-items");
    const cands = await tracker().fetchCandidates(CONFIG);
    expect(cands.map((i) => i.identifier).sort()).toEqual([
      "forge-desktop-test#1",
      "forge-desktop-test#5",
    ]);
    expect(cands.find((i) => i.identifier.endsWith("#5"))?.blockedBy).toEqual([
      { identifier: "forge-desktop-test#2" },
    ]);
  });

  it("counts the board and reads terminal cards", async () => {
    replay("project-items");
    expect(await tracker().fetchProgressCounts(CONFIG)).toEqual({ total: 5, done: 0 });
  });

  it("reads each issue's column by id", async () => {
    replay("issue-states");
    const states = await tracker().fetchIssueStatesByIds(
      (rec("issue-states").variables.ids as string[]) ?? [],
    );
    expect(states.get("I_kwDOVkEq-M8AAAABcw9X1Q")).toBe("In Progress");
    expect([...states.values()]).toContain("Human Review");
  });

  it("puts an issue that isn't on the project yet on it, then sets its Status", async () => {
    const sent = replay("issue-off-board", "add-to-project", "set-status");
    await tracker().updateIssueState(ISSUE2, "Backlog");
    expect(sent.map((s) => s.op)).toEqual(["Issues", "AddToProject", "SetStatus"]);
    expect(sent[1].variables).toEqual({ project: PROJECT, content: ISSUE2 });
    expect(sent[2].variables).toMatchObject({
      project: PROJECT,
      field: FIELD,
      option: COLUMNS.Backlog,
    });
  });

  it("refuses a column the project has no Status for", async () => {
    replay();
    await expect(tracker().updateIssueState(ISSUE2, "Shipped")).rejects.toThrow(
      /no Status for "Shipped"/,
    );
  });

  it("claims compare-and-set: read, assign the signed-in person, read again", async () => {
    const sent = replay("viewer", "claim-before", "assign", "claim-after");
    const result = await tracker().claimIssue(
      { issueId: ISSUE2, assignee: "me" },
      { activeStates: ["Triage"] },
    );
    expect(result).toEqual({ claimed: true, heldBy: "Donnadieu" });
    expect(sent.map((s) => s.op)).toEqual(["Viewer", "Issues", "Assign", "Issues"]);
    expect(sent[2].variables).toEqual(rec("assign").variables);
  });

  it("never takes a card someone else holds", async () => {
    const held = rec("claim-before");
    const issue = (held.response.data as { nodes: Array<{ assignees: { nodes: unknown[] } }> })
      .nodes[0];
    issue.assignees.nodes = [{ id: "U_other", login: "someone-else" }];
    const answers = [rec("viewer").response, held.response];
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        sent.push(
          String(JSON.parse(String(init.body)).query).match(/(?:query|mutation)\s+(\w+)/)?.[1] ??
            "",
        );
        return new Response(JSON.stringify(answers.shift()), { status: 200 });
      }),
    );
    const result = await tracker().claimIssue({ issueId: ISSUE2, assignee: "me" });
    expect(result).toEqual({ claimed: false, heldBy: "someone-else", reason: "already-claimed" });
    expect(sent).toEqual(["Viewer", "Issues"]);
  });

  it("refuses a card that left the active columns", async () => {
    replay("viewer", "claim-before");
    const result = await tracker().claimIssue(
      { issueId: ISSUE2, assignee: "me" },
      { activeStates: ["Todo"] },
    );
    expect(result).toEqual({ claimed: false, reason: "not-active" });
  });

  it("comments, and reads comments back for the workpad", async () => {
    replay("comment", "comments");
    const t = tracker();
    const id = await t.createComment(ISSUE2, "## Forge Triage\n\nPlan: nothing, this is a test.");
    expect(id).toMatch(/^IC_/);
    const comments = await t.fetchIssueComments(ISSUE2);
    expect(comments.some((c) => c.body.startsWith("## Forge Workpad"))).toBe(true);
  });

  it("asks for the token again once after a 401", async () => {
    const getAccessToken = vi.fn(async (o?: { forceRefresh?: boolean }) =>
      o?.forceRefresh ? "new" : "old",
    );
    const answers = [
      new Response("", { status: 401 }),
      new Response(JSON.stringify(rec("viewer").response)),
    ];
    const auth: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        auth.push(new Headers(init.headers).get("Authorization") ?? "");
        return answers.shift() as Response;
      }),
    );
    const me = await tracker({ getAccessToken } as unknown as StaticBasecampTokenProvider).me();
    expect(me.login).toBe("Donnadieu");
    expect(auth).toEqual(["Bearer old", "Bearer new"]);
  });

  it("says a GraphQL error in plain words", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              errors: [{ message: "Your token has not been granted the required scopes" }],
            }),
          ),
      ),
    );
    await expect(tracker().me()).rejects.toThrow(
      "GitHub said: Your token has not been granted the required scopes",
    );
  });
});

describe("the agents' github_graphql tool", () => {
  const opts = { endpoint: "https://api.github.com/graphql", token: async () => "gh_test_token" };

  it("returns GitHub's data", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(rec("viewer").response)));
    const r = await callGitHub(
      { query: "query { viewer { login } }" },
      opts,
      f as unknown as typeof fetch,
    );
    expect(r).toMatchObject({ success: true, data: { viewer: { login: "Donnadieu" } } });
  });

  it("fails on GraphQL errors and HTTP errors", async () => {
    const errs = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "nope" }] })));
    expect((await callGitHub({ query: "q" }, opts, errs as unknown as typeof fetch)).error).toBe(
      "GraphQL errors: nope",
    );
    const down = vi.fn(async () => new Response("", { status: 502 }));
    expect(await callGitHub({ query: "q" }, opts, down as unknown as typeof fetch)).toMatchObject({
      success: false,
      status: 502,
    });
  });

  it("refuses an empty query without calling GitHub", async () => {
    const f = vi.fn();
    expect((await callGitHub({ query: " " }, opts, f as unknown as typeof fetch)).success).toBe(
      false,
    );
    expect(f).not.toHaveBeenCalled();
  });
});

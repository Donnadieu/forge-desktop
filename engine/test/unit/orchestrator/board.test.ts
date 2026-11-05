import { describe, expect, it } from "vitest";
import { mapRateLimit } from "../../../src/agent/claude.js";
import type { RunningSessionSnapshot } from "../../../src/observability/types.js";
import {
  applyHelperEvent,
  type HelperActivity,
  plainActivity,
} from "../../../src/orchestrator/activity.js";
import { BoardReader } from "../../../src/orchestrator/board-reader.js";
import { toBoardCard } from "../../../src/tracker/linear-board.js";
import type { BoardCard, TrackerAdapter, TrackerConfig } from "../../../src/tracker/types.js";

const tool = (name: string, input: unknown) => ({ type: "tool_use" as const, tool: name, input });

describe("one plain line about what the agent is doing", () => {
  it("says what a tool does in plain words, never the tool's name", () => {
    expect(plainActivity(tool("Edit", { file_path: "/w/src/login.tsx" }))).toBe(
      "Editing login.tsx",
    );
    expect(plainActivity(tool("Read", { file_path: "/w/README.md" }))).toBe("Reading README.md");
    expect(plainActivity(tool("Grep", { pattern: "x" }))).toBe("Searching the code");
    expect(plainActivity(tool("Bash", { command: "pnpm vitest run" }))).toBe("Running the tests");
    expect(plainActivity(tool("Bash", { command: "gh pr create --fill" }))).toBe(
      "Opening the pull request",
    );
    expect(plainActivity(tool("Bash", { command: "git push -u origin HEAD" }))).toBe(
      "Pushing the branch",
    );
    expect(plainActivity(tool("Agent", { description: "Write the tests" }))).toBe(
      "Sending a helper: Write the tests",
    );
    expect(plainActivity(tool("mcp__forge-linear__linear_graphql", {}))).toBe("Updating the card");
  });

  it("uses the first sentence of what the agent says, cut to one line", () => {
    expect(
      plainActivity({ type: "text", content: "Writing tests for the login page. Then the fix." }),
    ).toBe("Writing tests for the login page.");
    const long = plainActivity({ type: "text", content: "a".repeat(200) }) ?? "";
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long.endsWith("…")).toBe(true);
  });

  it("says when the lead is waiting for helpers", () => {
    expect(plainActivity({ type: "waiting_for_helpers", running: 2 })).toBe(
      "Waiting for 2 helpers to finish",
    );
  });

  it("keeps quiet about events that say nothing new", () => {
    expect(plainActivity({ type: "text", content: "  " })).toBeNull();
    expect(plainActivity(tool("SomethingNew", {}))).toBeNull();
  });

  it("follows each helper from start to finish", () => {
    const helpers: HelperActivity[] = [];
    applyHelperEvent(helpers, {
      type: "helper",
      id: "t1",
      status: "started",
      description: "Write the tests",
    });
    applyHelperEvent(helpers, {
      type: "helper",
      id: "t2",
      status: "started",
      description: "Check the docs",
    });
    applyHelperEvent(helpers, { type: "helper", id: "t1", status: "finished" });
    expect(helpers).toEqual([
      { id: "t1", description: "Write the tests", running: false },
      { id: "t2", description: "Check the docs", running: true },
    ]);
  });
});

const card = (id: string, state: string, priority = 2): BoardCard => ({
  id,
  identifier: `FD-${id}`,
  title: `Card ${id}`,
  state,
  url: null,
  assignee: null,
  branchName: null,
  prUrl: null,
  priority,
  updatedAt: "2026-11-03T00:00:00Z",
});

const config: TrackerConfig = {
  kind: "linear",
  project_slug: "p",
  active_states: [],
  terminal_states: [],
};
const columns = ["Todo", "In Progress", "Human Review", "Done"];

function tracker(read: () => Promise<BoardCard[]>): TrackerAdapter {
  return { kind: "linear", fetchBoard: read } as unknown as TrackerAdapter;
}

function running(issueId: string, state: string): RunningSessionSnapshot {
  return {
    issueId,
    identifier: `FD-${issueId}`,
    title: "",
    description: "",
    state,
    sessionId: null,
    turnCount: 3,
    lastEvent: "tool_use",
    lastMessage: "",
    activity: "Running the tests",
    helpers: [{ id: "t1", description: "Write the tests", running: true }],
    recent: [{ at: "2026-11-03T00:00:00Z", line: "Running the tests" }],
    startedAt: "2026-11-03T00:00:00Z",
    lastEventAt: "2026-11-03T00:00:00Z",
    tokens: { input: 0, output: 0, total: 0 },
    workspacePath: null,
    attempt: 1,
    host: null,
  };
}

describe("the board", () => {
  it("puts each card in its column, with the agent's line and helpers on held cards", async () => {
    const reader = new BoardReader(
      tracker(async () => [
        card("1", "Todo"),
        card("2", "In Progress"),
        card("3", "Done"),
        card("4", "Canceled"),
      ]),
      config,
      columns,
    );
    await reader.refresh();
    const view = reader.view([running("2", "In Progress")]);
    expect(view.problem).toBeNull();
    expect(view.columns.map((c) => [c.name, c.cards.map((x) => x.id)])).toEqual([
      ["Todo", ["1"]],
      ["In Progress", ["2"]],
      ["Human Review", []],
      ["Done", ["3"]],
    ]);
    const held = view.columns[1].cards[0];
    expect(held.activity).toBe("Running the tests");
    expect(held.helpers).toHaveLength(1);
    expect(view.columns[0].cards[0].activity).toBeNull();
  });

  it("keeps the last board and says why when the tracker can't be read", async () => {
    let fail = false;
    const reader = new BoardReader(
      tracker(async () => {
        if (fail) throw new Error("Linear API error: 503");
        return [card("1", "Todo")];
      }),
      config,
      columns,
    );
    await reader.refresh();
    fail = true;
    await reader.refresh();
    const view = reader.view([]);
    expect(view.columns[0].cards).toHaveLength(1);
    expect(view.problem).toMatch(/couldn't read the board from Linear: Linear API error: 503/);
  });

  it("takes the pull request from the card's GitHub link", () => {
    const c = toBoardCard({
      id: "1",
      identifier: "FD-1",
      title: "t",
      updatedAt: "2026-11-03T00:00:00Z",
      state: { name: "QA" },
      attachments: {
        nodes: [
          { url: "https://example.com/doc", sourceType: "unknown" },
          { url: "https://github.com/acme/app/pull/12", sourceType: "github" },
        ],
      },
    });
    expect(c.prUrl).toBe("https://github.com/acme/app/pull/12");
  });
});

describe("the person moves cards from the board", () => {
  const moving = (cards: BoardCard[], moved: Array<[string, string]>, fail = false) =>
    ({
      kind: "linear",
      fetchBoard: async () => cards,
      updateIssueState: async (id: string, to: string) => {
        if (fail) throw new Error("Linear API error: 500");
        moved.push([id, to]);
        const c = cards.find((x) => x.id === id);
        if (c) c.state = to;
      },
    }) as unknown as TrackerAdapter;

  it("starts a Backlog card and decides on a pull request, then reads the board again", async () => {
    const cards = [card("1", "Backlog"), card("2", "Human Review"), card("3", "Human Review")];
    const moved: Array<[string, string]> = [];
    const reader = new BoardReader(moving(cards, moved), config, [
      "Backlog",
      "Todo",
      "Human Review",
      "Merging",
      "Rework",
    ]);
    await reader.refresh();
    expect(await reader.move("1", "Todo")).toEqual({ ok: true });
    expect(await reader.move("2", "Merging")).toEqual({ ok: true });
    expect(await reader.move("3", "Rework")).toEqual({ ok: true });
    expect(moved).toEqual([
      ["1", "Todo"],
      ["2", "Merging"],
      ["3", "Rework"],
    ]);
    const view = reader.view([]);
    expect(view.columns.find((c) => c.name === "Merging")?.cards.map((c) => c.id)).toEqual(["2"]);
  });

  it("refuses every other move and says why", async () => {
    const cards = [card("1", "Todo"), card("2", "Human Review")];
    const moved: Array<[string, string]> = [];
    const reader = new BoardReader(moving(cards, moved), config, columns);
    await reader.refresh();
    expect((await reader.move("1", "Done")).ok).toBe(false);
    expect((await reader.move("2", "Done")).problem).toMatch(/can't be moved to Done/);
    expect((await reader.move("9", "Todo")).problem).toMatch(/can't find that card/);
    expect(moved).toEqual([]);
  });

  it("says when Linear didn't move the card", async () => {
    const reader = new BoardReader(moving([card("1", "Backlog")], [], true), config, [
      "Backlog",
      "Todo",
    ]);
    await reader.refresh();
    expect((await reader.move("1", "Todo")).problem).toMatch(
      /Linear didn't move FD-1: Linear API error: 500/,
    );
  });
});

describe("a board card's labels and blockers", () => {
  it("keeps label names and only the blockers that aren't finished", () => {
    const c = toBoardCard({
      id: "1",
      identifier: "FD-16",
      title: "t",
      updatedAt: "2026-11-03T00:00:00Z",
      state: { name: "Todo" },
      labels: { nodes: [{ name: "ready-for-execution" }] },
      inverseRelations: {
        nodes: [
          { type: "blocks", issue: { identifier: "FD-15", state: { type: "started" } } },
          { type: "blocks", issue: { identifier: "FD-9", state: { type: "completed" } } },
          { type: "related", issue: { identifier: "FD-17", state: { type: "backlog" } } },
        ],
      },
    });
    expect(c.labels).toEqual(["ready-for-execution"]);
    expect(c.blockedBy).toEqual(["FD-15"]);
  });
});

describe("a Claude subscription's usage windows", () => {
  it("reads Claude Code's rate_limit_event into a window, a percent and a reset time", () => {
    const e = mapRateLimit({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.83,
        resetsAt: 1793740000,
      },
    });
    expect(e).toEqual({
      type: "rate_limit",
      window: "five_hour",
      percent: 83,
      resetsAt: new Date(1793740000 * 1000).toISOString(),
      status: "allowed_warning",
    });
  });

  it("ignores an event without a window", () => {
    expect(
      mapRateLimit({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }),
    ).toBeNull();
  });
});

describe("the workpad on a Basecamp card", () => {
  it("is found in Basecamp's HTML and shown as Markdown", async () => {
    const t: TrackerAdapter = {
      ...tracker(async () => []),
      kind: "basecamp",
      fetchIssueComments: async () => [
        { id: "1", body: "<div>Looks good to me</div>", createdAt: "" },
        {
          id: "2",
          body: "<h1>Forge Workpad</h1><ul><li>[x] plan</li><li>[ ] build</li></ul>",
          createdAt: "",
        },
      ],
    };
    const reader = new BoardReader(t, config, columns);
    await expect(reader.workpad("9")).resolves.toEqual({
      workpad: "# Forge Workpad\n\n- [x] plan\n- [ ] build",
      comments: 2,
    });
  });

  it("names Basecamp when the board can't be read", async () => {
    const t: TrackerAdapter = {
      ...tracker(async () => {
        throw new Error("Basecamp sign-in needed: refresh failed");
      }),
      kind: "basecamp",
    };
    const reader = new BoardReader(t, config, columns);
    await reader.refresh();
    expect(reader.view([]).problem).toBe(
      "Forge couldn't read the board from Basecamp: Basecamp sign-in needed: refresh failed",
    );
  });
});

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

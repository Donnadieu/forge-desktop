import { describe, expect, it, vi } from "vitest";
import { BoardReader } from "../../../src/orchestrator/board-reader.js";
import { BoardColumns, guardMoves } from "../../../src/tracker/board-columns.js";
import { LinearTracker } from "../../../src/tracker/linear.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { NormalizedIssue, TrackerConfig } from "../../../src/tracker/types.js";

// A shared team board nobody wants changed: only these columns exist.
const SHARED = ["Backlog", "Triage", "Todo", "In Progress", "Done"];
const PIPELINE = [
  "Backlog",
  "Triage",
  "Todo",
  "In Progress",
  "AI Review",
  "QA",
  "Human Review",
  "Rework",
  "Merging",
  "Done",
];
const config: TrackerConfig = {
  kind: "memory",
  project_slug: "",
  team_id: "team-atc",
  active_states: ["Todo", "In Progress"],
  terminal_states: ["Done"],
};

function issue(id: string, state: string): NormalizedIssue {
  return {
    id,
    identifier: `ATC-${id}`,
    title: `Card ${id}`,
    description: null,
    priority: 2,
    state,
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-11-11T00:00:00Z",
    updatedAt: "2026-11-11T00:00:00Z",
  } as NormalizedIssue;
}

function sharedBoard(cards: NormalizedIssue[]) {
  const tracker = new MemoryTracker(cards, { columns: SHARED });
  const move = vi.spyOn(tracker, "updateIssueState");
  return { tracker, move };
}

describe("Forge never moves a card into a column the board doesn't have", () => {
  it("knows which columns the board has", async () => {
    const { tracker } = sharedBoard([]);
    const cols = new BoardColumns(tracker, config);
    expect(await cols.present()).toEqual(SHARED);
    expect(await cols.missing("AI Review")).toBe(true);
    expect(await cols.missing("in progress")).toBe(false);
  });

  it("refuses a move into a missing column without calling the tracker", async () => {
    const { tracker, move } = sharedBoard([issue("1", "In Progress")]);
    const guarded = guardMoves(tracker, new BoardColumns(tracker, config));
    await expect(guarded.updateIssueState?.("1", "AI Review")).rejects.toThrow(
      "This board has no AI Review column",
    );
    expect(move).not.toHaveBeenCalled();
    await guarded.updateIssueState?.("1", "Done");
    expect(move).toHaveBeenCalledWith("1", "Done");
  });

  it("the board's own moves check the column before the tracker", async () => {
    const { tracker, move } = sharedBoard([issue("1", "Human Review"), issue("2", "Backlog")]);
    const cols = new BoardColumns(tracker, config);
    const reader = new BoardReader(guardMoves(tracker, cols), config, PIPELINE, cols);
    await reader.refresh();
    const merged = await reader.move("1", "Merging");
    expect(merged).toEqual({ ok: false, problem: "This board has no Merging column." });
    expect(move).not.toHaveBeenCalled();
    expect((await reader.move("2", "Todo")).ok).toBe(true);
    expect(move).toHaveBeenCalledWith("2", "Todo");
  });

  it("tells the app which columns the board has, so stages come back when a column does", async () => {
    const { tracker } = sharedBoard([]);
    const cols = new BoardColumns(tracker, config);
    const reader = new BoardReader(tracker, config, PIPELINE, cols);
    await reader.refresh();
    expect(reader.view([]).present).toEqual(SHARED);
  });

  it("reads the columns again after a while, so a new column is seen", async () => {
    let now = 0;
    const names = [...SHARED];
    const tracker = { kind: "memory", fetchColumns: async () => [...names] } as never;
    const cols = new BoardColumns(tracker, config, { ttlMs: 1000, now: () => now });
    expect(await cols.missing("QA")).toBe(true);
    names.push("QA");
    expect(await cols.missing("QA")).toBe(true);
    now = 2000;
    expect(await cols.missing("QA")).toBe(false);
  });

  it("a tracker that can't list its columns isn't guarded", async () => {
    const tracker = new MemoryTracker([issue("1", "In Progress")]);
    const cols = new BoardColumns(tracker, config);
    expect(await cols.present()).toBeNull();
    expect(await cols.missing("AI Review")).toBe(false);
    await guardMoves(tracker, cols).updateIssueState?.("1", "AI Review");
    expect((await tracker.fetchIssueStatesByIds(["1"])).get("1")).toBe("AI Review");
  });

  it("Linear lists the team's states", async () => {
    const linear = new LinearTracker("https://linear.test/graphql", "key");
    const send = vi.fn(async () => ({
      team: { states: { nodes: SHARED.map((name, i) => ({ id: `s${i}`, name })) } },
    }));
    (linear as unknown as { graphql: typeof send }).graphql = send;
    expect(await linear.fetchColumns(config)).toEqual(SHARED);
    expect(send.mock.calls[0]?.[1]).toEqual({ team: "team-atc" });
  });
});

describe("a tracker that only knows its columns from setup", () => {
  it("an empty list guards nothing (an old setup), rather than refusing every move", async () => {
    const tracker = { kind: "basecamp", fetchColumns: async () => [] } as never;
    const cols = new BoardColumns(tracker, config);
    expect(await cols.present()).toBeNull();
    expect(await cols.missing("Done")).toBe(false);
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  NEXT_STEPS,
  promptWithStageRun,
  stageRunNote,
  takeNextStep,
} from "../../../src/orchestrator/next-step.js";
import { isParked, type ParkedCard } from "../../../src/orchestrator/parking.js";
import { createInitialState } from "../../../src/orchestrator/types.js";
import { openLocalStore } from "../../../src/store/local-store.js";
import { BoardColumns, guardMoves } from "../../../src/tracker/board-columns.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { NormalizedIssue, TrackerConfig } from "../../../src/tracker/types.js";

const SHARED = ["Backlog", "Triage", "Todo", "In Progress", "Done"];
const config: TrackerConfig = {
  kind: "memory",
  project_slug: "",
  team_id: "team-atc",
  active_states: ["Todo", "In Progress"],
  terminal_states: ["Done"],
};

function card(id: string, state: string): NormalizedIssue {
  return {
    id,
    identifier: `ATC-${id}`,
    title: `Card ${id}`,
    description: null,
    state,
    priority: 2,
    labels: [],
    blockedBy: [],
    createdAt: "2026-11-11T00:00:00Z",
    updatedAt: "2026-11-11T00:00:00Z",
  } as NormalizedIssue;
}

const parkedCard = (id: string): ParkedCard => ({
  issueId: id,
  identifier: `ATC-${id}`,
  state: "In Progress",
  next: "AI Review",
  line: "Draft pull request open.",
  parkedAt: "2026-11-11T12:00:00Z",
});

function setup(columns: string[]) {
  const tracker = new MemoryTracker([card("1", "In Progress"), card("2", "Human Review")], {
    columns,
  });
  const move = vi.spyOn(tracker, "updateIssueState");
  const cols = new BoardColumns(tracker, config);
  const state = createInitialState();
  state.parked.set("1", parkedCard("1"));
  const parking = { list: () => [], put: vi.fn(), remove: vi.fn() };
  const stageRuns = { list: () => [], put: vi.fn(), remove: vi.fn() };
  const deps = {
    state,
    tracker: guardMoves(tracker, cols),
    columns: cols,
    activeStates: config.active_states,
    parking,
    stageRuns,
  };
  return { deps, move, state, parking, stageRuns };
}

describe("Next step: the person picks the card's next stage", () => {
  it("offers only stage moves", () => {
    expect(NEXT_STEPS).toEqual(["AI Review", "QA", "Human Review", "Rework", "Merging"]);
  });

  it("a stage with a column moves the card there, and it isn't parked any more", async () => {
    const { deps, move, state, parking } = setup([...SHARED, "QA"]);
    const r = await takeNextStep(deps, card("1", "In Progress"), "QA");
    expect(r).toEqual({ ok: true, ran: "moved" });
    expect(move).toHaveBeenCalledWith("1", "QA");
    expect(state.parked.has("1")).toBe(false);
    expect(parking.remove).toHaveBeenCalledWith("1");
  });

  it("a stage with no column runs here now: the card leaves parking for one run of that step", async () => {
    const { deps, move, state, stageRuns } = setup(SHARED);
    const r = await takeNextStep(deps, card("1", "In Progress"), "AI Review");
    expect(r).toEqual({ ok: true, ran: "here" });
    expect(move).not.toHaveBeenCalled();
    expect(isParked(state, card("1", "In Progress"))).toBe(false);
    expect(state.stageRuns.get("1")).toBe("AI Review");
    expect(stageRuns.put).toHaveBeenCalledWith("1", "AI Review");
  });

  it("the run's prompt says which step to run, once", () => {
    const state = createInitialState();
    state.stageRuns.set("1", "AI Review");
    const remove = vi.fn();
    const first = promptWithStageRun(state, "1", "BASE", remove);
    expect(first).toBe(`BASE${stageRunNote("AI Review")}`);
    expect(first).toContain("Run the `AI Review` step on this ticket now");
    expect(first).toContain("park it again");
    expect(promptWithStageRun(state, "1", "BASE", remove)).toBe("BASE");
    expect(remove).toHaveBeenCalledWith("1");
  });

  it("Human review with no column keeps the card waiting on you", async () => {
    const { deps, state, stageRuns } = setup(SHARED);
    const r = await takeNextStep(deps, card("1", "In Progress"), "Human Review");
    expect(r).toEqual({ ok: true, ran: "waiting" });
    expect(isParked(state, card("1", "In Progress"))).toBe(true);
    expect(stageRuns.put).not.toHaveBeenCalled();
  });

  it("refuses anything that isn't a stage move", async () => {
    const { deps } = setup(SHARED);
    const r = await takeNextStep(deps, card("1", "In Progress"), "simplify");
    expect(r.ok).toBe(false);
  });

  it("a step with no column runs only on a card Forge works", async () => {
    const { deps } = setup([...SHARED, "Human Review"]);
    const r = await takeNextStep(deps, card("2", "Human Review"), "QA");
    expect(r).toEqual({
      ok: false,
      problem: "Forge runs QA here only on cards in Todo or In Progress.",
    });
  });

  it("a step waiting to run survives a restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "forge-step-")), "forge.sqlite");
    const a = openLocalStore(path);
    a.putStageRun("1", "QA");
    a.close();
    const b = openLocalStore(path);
    expect(b.listStageRuns()).toEqual([{ issueId: "1", stage: "QA" }]);
    b.removeStageRun("1");
    expect(b.listStageRuns()).toEqual([]);
    b.close();
  });
});

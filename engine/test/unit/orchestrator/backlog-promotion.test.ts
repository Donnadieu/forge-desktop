import { describe, expect, it, vi } from "vitest";
import { WorkflowConfigSchema } from "../../../src/config/schema.js";
import {
  BacklogPromoter,
  type BacklogPromotionConfig,
  planBacklogPromotions,
  resolveBacklogPromotion,
} from "../../../src/orchestrator/backlog-promotion.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { NormalizedIssue, TrackerConfig } from "../../../src/tracker/types.js";
import { createTestIssue } from "../../support/fixtures.js";

const FORGE = "user-forge";
const OTHER = "user-other";

function card(id: string, overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return createTestIssue({
    id,
    identifier: `AIT-${id}`,
    state: "Backlog",
    labels: [],
    ...overrides,
  });
}

function makeConfig(overrides: Partial<BacklogPromotionConfig> = {}): BacklogPromotionConfig {
  return {
    backlogToTriage: true,
    readyToTodo: true,
    readyLabel: "ready-for-execution",
    maxInTriage: 2,
    intervalMs: 300_000,
    identity: FORGE,
    ...overrides,
  };
}

const trackerConfig: TrackerConfig = {
  kind: "memory",
  project_slug: "test",
  active_states: ["Triage", "Todo", "In Progress"],
  terminal_states: ["Done"],
};

const moved = (moves: ReturnType<typeof planBacklogPromotions>) =>
  moves.map((m) => `${m.issue.id}->${m.to}`);

describe("planBacklogPromotions", () => {
  it("moves a ready card to Todo and an untriaged unassigned card to Triage", () => {
    const issues = [card("1", { labels: ["ready-for-execution"], assignee: FORGE }), card("2")];
    expect(moved(planBacklogPromotions(issues, makeConfig()))).toEqual(["1->Todo", "2->Triage"]);
  });

  it("matches the ready label case-insensitively", () => {
    const issues = [card("1", { labels: ["Ready-For-Execution"] })];
    expect(moved(planBacklogPromotions(issues, makeConfig()))).toEqual(["1->Todo"]);
  });

  it("leaves a ready card held by someone else in Backlog", () => {
    const issues = [card("1", { labels: ["ready-for-execution"], assignee: OTHER })];
    expect(planBacklogPromotions(issues, makeConfig())).toEqual([]);
  });

  it("ignores the assignee for ready cards when Forge's identity is unknown", () => {
    const issues = [card("1", { labels: ["ready-for-execution"], assignee: OTHER })];
    const moves = planBacklogPromotions(issues, makeConfig({ identity: undefined }));
    expect(moved(moves)).toEqual(["1->Todo"]);
  });

  it("never sends an assigned card to Triage (already triaged, or held by a person)", () => {
    const issues = [card("1", { assignee: FORGE }), card("2", { assignee: OTHER })];
    expect(planBacklogPromotions(issues, makeConfig())).toEqual([]);
  });

  it("never sends a ready card to Triage even when ready_to_todo is off", () => {
    const issues = [card("1", { labels: ["ready-for-execution"] })];
    expect(planBacklogPromotions(issues, makeConfig({ readyToTodo: false }))).toEqual([]);
  });

  it("fills Triage only up to max_in_triage, keeping the Backlog's order", () => {
    const issues = [card("t1", { state: "Triage" }), card("1"), card("2"), card("3")];
    expect(moved(planBacklogPromotions(issues, makeConfig()))).toEqual(["1->Triage"]);
    expect(planBacklogPromotions(issues, makeConfig({ maxInTriage: 1 }))).toEqual([]);
  });

  it("does nothing for a rule that is off", () => {
    const issues = [card("1", { labels: ["ready-for-execution"] }), card("2")];
    const none = makeConfig({ backlogToTriage: false, readyToTodo: false });
    expect(planBacklogPromotions(issues, none)).toEqual([]);
  });

  it("only looks at Backlog cards", () => {
    const issues = [card("1", { state: "Todo", labels: ["ready-for-execution"] })];
    expect(planBacklogPromotions(issues, makeConfig())).toEqual([]);
  });
});

describe("resolveBacklogPromotion", () => {
  const defaults = WorkflowConfigSchema.parse({
    tracker: { kind: "linear", project_slug: "proj" },
  }).tracker.promote;

  it("is off by default", () => {
    expect(defaults).toEqual({
      backlog_to_triage: false,
      ready_to_todo: false,
      ready_label: "ready-for-execution",
      max_in_triage: 2,
      interval_ms: 300_000,
    });
    expect(resolveBacklogPromotion(defaults, { customWorkflows: true })).toBeUndefined();
  });

  it("is off when the block is missing", () => {
    expect(resolveBacklogPromotion(undefined, { customWorkflows: true })).toBeUndefined();
  });

  it("maps the workflow file's block and carries Forge's identity", () => {
    const resolved = resolveBacklogPromotion(
      { ...defaults, backlog_to_triage: true, ready_to_todo: true, max_in_triage: 3 },
      { customWorkflows: true, identity: FORGE },
    );
    expect(resolved).toEqual(makeConfig({ maxInTriage: 3 }));
  });

  it("drops Backlog -> Triage with a warning when ticket claiming is off", () => {
    const logger = { warn: vi.fn() };
    const resolved = resolveBacklogPromotion(
      { ...defaults, backlog_to_triage: true, ready_to_todo: true },
      { customWorkflows: false, logger: logger as never },
    );
    expect(resolved?.backlogToTriage).toBe(false);
    expect(resolved?.readyToTodo).toBe(true);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("is off when the only rule asked for needs claiming and claiming is off", () => {
    const resolved = resolveBacklogPromotion(
      { ...defaults, backlog_to_triage: true },
      { customWorkflows: false },
    );
    expect(resolved).toBeUndefined();
  });
});

describe("BacklogPromoter", () => {
  it("moves cards in the tracker and reports what moved", async () => {
    const tracker = new MemoryTracker([
      card("1", { labels: ["ready-for-execution"], assignee: FORGE }),
      card("2"),
      card("3", { assignee: OTHER }),
    ]);
    const promoter = new BacklogPromoter(makeConfig());

    const moves = await promoter.maybePromote({ tracker, trackerConfig });

    expect(moved(moves)).toEqual(["1->Todo", "2->Triage"]);
    expect(tracker.getIssue("1")?.state).toBe("Todo");
    expect(tracker.getIssue("2")?.state).toBe("Triage");
    expect(tracker.getIssue("3")?.state).toBe("Backlog");
  });

  it("reads Backlog and Triage with the workflow's other scoping kept", async () => {
    const tracker = new MemoryTracker();
    const fetchSpy = vi.spyOn(tracker, "fetchCandidates");
    await new BacklogPromoter(makeConfig()).maybePromote({
      tracker,
      trackerConfig: { ...trackerConfig, labels: ["smith_feature"], assignee: "me" },
    });

    expect(fetchSpy).toHaveBeenCalledWith({
      ...trackerConfig,
      labels: ["smith_feature"],
      active_states: ["Backlog", "Triage"],
      assignee: undefined,
    });
  });

  it("sweeps at most once per interval", async () => {
    let now = 1_000_000;
    const tracker = new MemoryTracker([card("1")]);
    const fetchSpy = vi.spyOn(tracker, "fetchCandidates");
    const promoter = new BacklogPromoter(makeConfig({ intervalMs: 60_000 }), () => now);

    await promoter.maybePromote({ tracker, trackerConfig });
    now += 59_999;
    await promoter.maybePromote({ tracker, trackerConfig });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    now += 1;
    await promoter.maybePromote({ tracker, trackerConfig });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps going when one move fails", async () => {
    const tracker = new MemoryTracker([card("1"), card("2")]);
    const original = tracker.updateIssueState.bind(tracker);
    vi.spyOn(tracker, "updateIssueState").mockImplementation(async (id, state) => {
      if (id === "1") throw new Error("Linear issueUpdate returned success=false");
      return original(id, state);
    });
    const logger = { info: vi.fn(), warn: vi.fn() };

    const moves = await new BacklogPromoter(makeConfig()).maybePromote({
      tracker,
      trackerConfig,
      logger: logger as never,
    });

    expect(moved(moves)).toEqual(["2->Triage"]);
    expect(tracker.getIssue("1")?.state).toBe("Backlog");
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("skips the sweep without throwing when the Backlog read fails", async () => {
    const tracker = new MemoryTracker([card("1")]);
    vi.spyOn(tracker, "fetchCandidates").mockRejectedValue(new Error("401"));
    const logger = { info: vi.fn(), warn: vi.fn() };

    const moves = await new BacklogPromoter(makeConfig()).maybePromote({
      tracker,
      trackerConfig,
      logger: logger as never,
    });

    expect(moves).toEqual([]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("does nothing on a tracker without writes", async () => {
    const tracker = new MemoryTracker([card("1")]);
    const readOnly = { ...tracker, fetchCandidates: vi.fn(), updateIssueState: undefined };

    const moves = await new BacklogPromoter(makeConfig()).maybePromote({
      tracker: readOnly as never,
      trackerConfig,
    });

    expect(moves).toEqual([]);
    expect(readOnly.fetchCandidates).not.toHaveBeenCalled();
  });
});

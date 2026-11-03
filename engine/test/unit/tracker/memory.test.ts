import { describe, expect, it } from "vitest";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { NormalizedIssue, TrackerConfig } from "../../../src/tracker/types.js";

function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    id: "id-1",
    identifier: "MT-1",
    title: "Test issue",
    description: "A test issue",
    state: "Todo",
    priority: 2,
    labels: [],
    blockedBy: [],
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    kind: "memory",
    project_slug: "test-project",
    active_states: ["Todo", "In Progress"],
    terminal_states: ["Done", "Cancelled"],
    ...overrides,
  };
}

describe("MemoryTracker", () => {
  it("has kind set to 'memory'", () => {
    const tracker = new MemoryTracker();
    expect(tracker.kind).toBe("memory");
  });

  describe("fetchProgressCounts", () => {
    it("counts every in-scope issue as total and the terminal subset as done", async () => {
      const tracker = new MemoryTracker([
        makeIssue({ id: "a", state: "Todo" }),
        makeIssue({ id: "b", state: "In Progress" }),
        makeIssue({ id: "c", state: "Done" }),
        makeIssue({ id: "d", state: "Cancelled" }),
      ]);
      expect(await tracker.fetchProgressCounts(makeConfig())).toEqual({ total: 4, done: 2 });
    });

    it("includes non-active/non-terminal tickets in total but not done", async () => {
      const tracker = new MemoryTracker([
        makeIssue({ id: "a", state: "Todo" }),
        makeIssue({ id: "b", state: "In Review" }), // neither active nor terminal
        makeIssue({ id: "c", state: "Done" }),
      ]);
      expect(await tracker.fetchProgressCounts(makeConfig())).toEqual({ total: 3, done: 1 });
    });

    it("honors the label scope filter", async () => {
      const tracker = new MemoryTracker([
        makeIssue({ id: "a", state: "Todo", labels: ["smith_feature"] }),
        makeIssue({ id: "b", state: "Done", labels: ["smith_feature"] }),
        makeIssue({ id: "c", state: "Done", labels: ["other"] }),
      ]);
      expect(await tracker.fetchProgressCounts(makeConfig({ labels: ["smith_feature"] }))).toEqual({
        total: 2,
        done: 1,
      });
    });

    it("returns zeroes for an empty project", async () => {
      const tracker = new MemoryTracker();
      expect(await tracker.fetchProgressCounts(makeConfig())).toEqual({ total: 0, done: 0 });
    });
  });

  describe("constructor", () => {
    it("starts empty when no issues provided", async () => {
      const tracker = new MemoryTracker();
      const result = await tracker.fetchCandidates(makeConfig());
      expect(result).toEqual([]);
    });

    it("accepts initial issues", async () => {
      const issue = makeIssue({ id: "a", state: "Todo" });
      const tracker = new MemoryTracker([issue]);
      const result = await tracker.fetchCandidates(makeConfig());
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("a");
    });

    it("does not share references with the input array", () => {
      const issues = [makeIssue({ id: "a" })];
      const tracker = new MemoryTracker(issues);
      issues.push(makeIssue({ id: "b" }));
      // The tracker should not see the newly pushed issue
      expect(tracker.getIssue("b")).toBeUndefined();
    });
  });

  describe("addIssue", () => {
    it("adds an issue that can be retrieved", () => {
      const tracker = new MemoryTracker();
      const issue = makeIssue({ id: "x" });
      tracker.addIssue(issue);
      expect(tracker.getIssue("x")).toEqual(issue);
    });
  });

  describe("fetchCandidates", () => {
    it("returns issues whose state is in active_states", async () => {
      const tracker = new MemoryTracker([
        makeIssue({ id: "1", state: "Todo" }),
        makeIssue({ id: "2", state: "In Progress" }),
        makeIssue({ id: "3", state: "Done" }),
        makeIssue({ id: "4", state: "Cancelled" }),
      ]);

      const config = makeConfig({
        active_states: ["Todo", "In Progress"],
      });
      const result = await tracker.fetchCandidates(config);

      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id).sort()).toEqual(["1", "2"]);
    });

    it("returns empty array when no issues match active states", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "1", state: "Done" })]);
      const config = makeConfig({ active_states: ["Todo"] });
      const result = await tracker.fetchCandidates(config);
      expect(result).toEqual([]);
    });

    it("returns only issues carrying at least one of the configured labels", async () => {
      const tracker = new MemoryTracker([
        makeIssue({ id: "1", state: "Todo", labels: ["smith_feature"] }),
        makeIssue({ id: "2", state: "Todo", labels: ["smith_bug", "p1"] }),
        makeIssue({ id: "3", state: "Todo", labels: ["unrelated"] }),
        makeIssue({ id: "4", state: "Todo", labels: [] }),
      ]);
      const config = makeConfig({
        active_states: ["Todo"],
        labels: ["smith_feature", "smith_debug", "smith_bug"],
      });
      const result = await tracker.fetchCandidates(config);
      expect(result.map((i) => i.id).sort()).toEqual(["1", "2"]);
    });

    it("treats an empty labels array as no filter", async () => {
      const tracker = new MemoryTracker([
        makeIssue({ id: "1", state: "Todo", labels: ["smith_feature"] }),
        makeIssue({ id: "2", state: "Todo", labels: [] }),
      ]);
      const result = await tracker.fetchCandidates(makeConfig({ labels: [] }));
      expect(result.map((i) => i.id).sort()).toEqual(["1", "2"]);
    });

    it("matches labels case-insensitively", async () => {
      const tracker = new MemoryTracker([
        makeIssue({ id: "1", state: "Todo", labels: ["Smith_Feature"] }),
        makeIssue({ id: "2", state: "Todo", labels: ["SMITH_BUG"] }),
        makeIssue({ id: "3", state: "Todo", labels: ["other"] }),
      ]);
      const result = await tracker.fetchCandidates(
        makeConfig({ labels: ["smith_feature", "smith_bug"] }),
      );
      expect(result.map((i) => i.id).sort()).toEqual(["1", "2"]);
    });
  });

  describe("fetchIssueStatesByIds", () => {
    it("returns a map of id to state for existing issues", async () => {
      const tracker = new MemoryTracker([
        makeIssue({ id: "a", state: "Todo" }),
        makeIssue({ id: "b", state: "In Progress" }),
        makeIssue({ id: "c", state: "Done" }),
      ]);

      const result = await tracker.fetchIssueStatesByIds(["a", "c"]);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(2);
      expect(result.get("a")).toBe("Todo");
      expect(result.get("c")).toBe("Done");
    });

    it("omits ids that do not exist", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "a", state: "Todo" })]);

      const result = await tracker.fetchIssueStatesByIds(["a", "missing"]);
      expect(result.size).toBe(1);
      expect(result.has("missing")).toBe(false);
    });

    it("returns empty map for empty ids array", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "a", state: "Todo" })]);
      const result = await tracker.fetchIssueStatesByIds([]);
      expect(result.size).toBe(0);
    });
  });

  describe("fetchTerminalIssues", () => {
    it("returns issues whose state is in terminal_states", async () => {
      const tracker = new MemoryTracker([
        makeIssue({ id: "1", state: "Todo" }),
        makeIssue({ id: "2", state: "Done" }),
        makeIssue({ id: "3", state: "Cancelled" }),
      ]);

      const config = makeConfig({
        terminal_states: ["Done", "Cancelled"],
      });
      const result = await tracker.fetchTerminalIssues(config);

      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id).sort()).toEqual(["2", "3"]);
    });

    it("returns empty array when no issues match terminal states", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "1", state: "Todo" })]);
      const config = makeConfig({ terminal_states: ["Done"] });
      const result = await tracker.fetchTerminalIssues(config);
      expect(result).toEqual([]);
    });

    it("applies the labels filter to terminal issues (Smith parity with fetchCandidates)", async () => {
      const tracker = new MemoryTracker([
        makeIssue({ id: "1", state: "Done", labels: ["smith_feature"] }),
        makeIssue({ id: "2", state: "Done", labels: ["unrelated"] }),
        makeIssue({ id: "3", state: "Cancelled", labels: ["smith_bug"] }),
        makeIssue({ id: "4", state: "Cancelled", labels: [] }),
      ]);
      const config = makeConfig({
        terminal_states: ["Done", "Cancelled"],
        labels: ["smith_feature", "smith_bug"],
      });
      const result = await tracker.fetchTerminalIssues(config);
      expect(result.map((i) => i.id).sort()).toEqual(["1", "3"]);
    });

    it("treats an empty labels array as no filter for terminal queries", async () => {
      const tracker = new MemoryTracker([
        makeIssue({ id: "1", state: "Done", labels: ["smith_feature"] }),
        makeIssue({ id: "2", state: "Done", labels: [] }),
      ]);
      const result = await tracker.fetchTerminalIssues(
        makeConfig({ terminal_states: ["Done"], labels: [] }),
      );
      expect(result.map((i) => i.id).sort()).toEqual(["1", "2"]);
    });
  });

  describe("updateIssueState", () => {
    it("changes the state of an existing issue", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "1", state: "Todo" })]);

      tracker.updateIssueState("1", "Done");

      const issue = tracker.getIssue("1");
      expect(issue?.state).toBe("Done");
    });

    it("does nothing for a non-existent issue", () => {
      const tracker = new MemoryTracker();
      // Should not throw
      tracker.updateIssueState("missing", "Done");
    });

    it("reflects state change in fetchCandidates", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "1", state: "Todo" })]);
      const config = makeConfig({ active_states: ["Todo"] });

      expect(await tracker.fetchCandidates(config)).toHaveLength(1);

      tracker.updateIssueState("1", "Done");

      expect(await tracker.fetchCandidates(config)).toHaveLength(0);
    });

    it("reflects state change in fetchIssueStatesByIds", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "1", state: "Todo" })]);

      tracker.updateIssueState("1", "In Progress");

      const result = await tracker.fetchIssueStatesByIds(["1"]);
      expect(result.get("1")).toBe("In Progress");
    });
  });

  describe("createComment", () => {
    it("creates a comment and returns its ID", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "1" })]);
      const commentId = await tracker.createComment("1", "Hello world");
      expect(commentId).toBeDefined();
      expect(typeof commentId).toBe("string");
    });

    it("stores comments retrievable via getComments", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "1" })]);
      await tracker.createComment("1", "First comment");
      await tracker.createComment("1", "Second comment");

      const comments = tracker.getComments("1");
      expect(comments).toHaveLength(2);
      expect(comments[0].body).toBe("First comment");
      expect(comments[1].body).toBe("Second comment");
    });

    it("returns unique IDs per comment", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "1" })]);
      const id1 = await tracker.createComment("1", "A");
      const id2 = await tracker.createComment("1", "B");
      expect(id1).not.toBe(id2);
    });
  });

  describe("getIssue", () => {
    it("returns the issue if it exists", () => {
      const issue = makeIssue({ id: "x" });
      const tracker = new MemoryTracker([issue]);
      expect(tracker.getIssue("x")).toEqual(issue);
    });

    it("returns undefined for non-existent issue", () => {
      const tracker = new MemoryTracker();
      expect(tracker.getIssue("nope")).toBeUndefined();
    });
  });
});

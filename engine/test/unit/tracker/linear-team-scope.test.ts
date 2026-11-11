// A Linear board with no project picked: Forge works on the whole team's cards (`team_id`, `project_slug: ""`).
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWorkflowContent } from "../../../src/config/loader.js";
import { WorkflowConfigSchema } from "../../../src/config/schema.js";
import { LinearTracker } from "../../../src/tracker/linear.js";
import type { TrackerConfig } from "../../../src/tracker/types.js";

// What the app writes when setup picked a team and no project.
const WORKFLOW = `---
tracker:
  kind: linear
  project_slug: ""
  team_id: "team-adc"
---
body
`;

function teamConfig(): TrackerConfig {
  const parsed = WorkflowConfigSchema.parse(parseWorkflowContent(WORKFLOW).config);
  return {
    kind: parsed.tracker.kind,
    project_slug: parsed.tracker.project_slug,
    team_id: parsed.tracker.team_id,
    active_states: ["Todo", "In Progress"],
    terminal_states: ["Done", "Canceled"],
  };
}

function issue(id: string, state = "Todo") {
  return {
    id,
    identifier: id.toUpperCase(),
    title: `Card ${id}`,
    description: "",
    priority: 2,
    state: { name: state },
    assignee: null,
    labels: { nodes: [] },
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-02T00:00:00Z",
    inverseRelations: { nodes: [] },
  };
}

/** A stand-in Linear that only answers queries scoped to team-adc, and records each request. */
function fakeLinear(cards: ReturnType<typeof issue>[]) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body);
    calls.push({ query, variables });
    const team =
      /team:\s*\{\s*id:\s*\{\s*eq:\s*\$team\s*\}/.test(query) && variables.team === "team-adc";
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        data: {
          issues: { nodes: team ? cards : [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      }),
    };
  });
  return { calls, fetchMock };
}

describe("a Linear team with no project", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("keeps the team from the workflow file", () => {
    expect(teamConfig().team_id).toBe("team-adc");
  });

  it("returns the team's cards to work on", async () => {
    const { calls, fetchMock } = fakeLinear([issue("adc-1"), issue("adc-2", "In Progress")]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const cards = await new LinearTracker(undefined, "lin_api_test").fetchCandidates(teamConfig());
    expect(cards.map((c) => c.identifier)).toEqual(["ADC-1", "ADC-2"]);
    expect(calls[0]?.query).not.toContain("project:");
  });

  it("shows the team's cards on the board, counts them, and sees finished ones", async () => {
    const { fetchMock } = fakeLinear([issue("adc-3", "Done")]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const tracker = new LinearTracker(undefined, "lin_api_test");
    const config = teamConfig();
    expect((await tracker.fetchBoard(config, ["Done"])).map((c) => c.identifier)).toEqual([
      "ADC-3",
    ]);
    expect(await tracker.fetchProgressCounts(config)).toEqual({ total: 1, done: 1 });
    expect((await tracker.fetchTerminalIssues(config)).map((c) => c.identifier)).toEqual(["ADC-3"]);
  });

  it("still asks for a project or a team when neither is set", async () => {
    const tracker = new LinearTracker(undefined, "lin_api_test");
    await expect(
      tracker.fetchBoard({ ...teamConfig(), team_id: undefined }, ["Todo"]),
    ).rejects.toThrow("Linear project slug is required");
  });
});

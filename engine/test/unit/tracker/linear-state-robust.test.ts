import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinearTracker } from "../../../src/tracker/linear.js";

// Regression for the original incident: Smith could not close bug tickets
// because `updateIssueState` did an exact-string match for "Cancelled" (two L)
// while the team workflow only had "Canceled" (one L, Linear's default). The
// fix made `updateIssueState` accept a candidate list and match
// case-insensitively, first-present-wins.
describe("LinearTracker.updateIssueState — spelling/case robustness", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockStates(nodes: Array<{ id: string; name: string }>) {
    return vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: { issue: { team: { states: { nodes } } } } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: { issueUpdate: { success: true } } }),
      });
  }

  it("picks the first candidate present when the workflow uses the one-L spelling", async () => {
    const fetchMock = mockStates([
      { id: "s-todo", name: "Todo" },
      { id: "s-canceled", name: "Canceled" }, // one L — Linear's default
    ]);
    globalThis.fetch = fetchMock;

    const tracker = new LinearTracker(undefined, "lin_api_test");
    // Candidate order mirrors SmithLinearService.transitionToCancelled.
    await tracker.updateIssueState("issue-1", ["Cancelled", "Canceled", "Cancelled"]);

    const mutationBody = JSON.parse(
      (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
    );
    expect(mutationBody.variables.stateId).toBe("s-canceled");
  });

  it("matches a single state name case-insensitively", async () => {
    const fetchMock = mockStates([{ id: "s-done", name: "Done" }]);
    globalThis.fetch = fetchMock;

    const tracker = new LinearTracker(undefined, "lin_api_test");
    await tracker.updateIssueState("issue-1", "done");

    const mutationBody = JSON.parse(
      (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
    );
    expect(mutationBody.variables.stateId).toBe("s-done");
  });

  it("throws listing all tried candidates when none exist", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        data: { issue: { team: { states: { nodes: [{ id: "s-todo", name: "Todo" }] } } } },
      }),
    });

    const tracker = new LinearTracker(undefined, "lin_api_test");
    await expect(tracker.updateIssueState("issue-1", ["Cancelled", "Canceled"])).rejects.toThrow(
      "None of [Cancelled, Canceled]",
    );
  });
});

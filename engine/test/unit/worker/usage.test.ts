import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../src/agent/types.js";
import type { TokenTotals } from "../../../src/telemetry/types.js";
import { addUsageTokens } from "../../../src/worker/usage.js";

function makeTotals(overrides: Partial<TokenTotals> = {}): TokenTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...overrides,
  };
}

describe("addUsageTokens", () => {
  it("is a no-op for non-usage events", () => {
    const totals = makeTotals();
    const events: AgentEvent[] = [
      { type: "text", content: "hello" },
      { type: "tool_use", tool: "read_file", input: { path: "/tmp" } },
      { type: "tool_result", output: "ok" },
      { type: "error", message: "boom" },
      { type: "done", success: true },
    ];

    for (const event of events) {
      addUsageTokens(totals, event);
    }

    expect(totals).toEqual(makeTotals());
  });

  it("adds input and output tokens from a usage event", () => {
    const totals = makeTotals();
    const event: AgentEvent = {
      type: "usage",
      inputTokens: 100,
      outputTokens: 50,
    };

    addUsageTokens(totals, event);

    expect(totals).toEqual(makeTotals({ input: 100, output: 50 }));
  });

  it("adds cache read and write tokens when present", () => {
    const totals = makeTotals();
    const event: AgentEvent = {
      type: "usage",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 200,
      cacheWriteTokens: 50,
    };

    addUsageTokens(totals, event);

    expect(totals).toEqual(makeTotals({ input: 10, output: 5, cacheRead: 200, cacheWrite: 50 }));
  });

  it("defaults missing cache tokens to zero", () => {
    const totals = makeTotals();
    const event: AgentEvent = {
      type: "usage",
      inputTokens: 25,
      outputTokens: 12,
      cacheReadTokens: 8,
    };

    addUsageTokens(totals, event);

    expect(totals).toEqual(makeTotals({ input: 25, output: 12, cacheRead: 8 }));
  });

  it("accumulates totals across multiple usage events", () => {
    const totals = makeTotals();
    const events: AgentEvent[] = [
      { type: "usage", inputTokens: 100, outputTokens: 50 },
      {
        type: "usage",
        inputTokens: 30,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      },
      { type: "text", content: "interleaved" },
      { type: "usage", inputTokens: 7, outputTokens: 3, cacheReadTokens: 2 },
    ];

    for (const event of events) {
      addUsageTokens(totals, event);
    }

    expect(totals).toEqual(
      makeTotals({
        input: 137,
        output: 73,
        cacheRead: 12,
        cacheWrite: 5,
      }),
    );
  });

  it("mutates an existing total rather than replacing it", () => {
    const totals = makeTotals({ input: 5, output: 3, cacheRead: 1, cacheWrite: 1 });
    const event: AgentEvent = {
      type: "usage",
      inputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
    };

    addUsageTokens(totals, event);

    expect(totals).toEqual(makeTotals({ input: 15, output: 10, cacheRead: 3, cacheWrite: 4 }));
  });
});

import { describe, expect, it } from "vitest";
import { accountUsage, newUsageState, resetTurnUsage } from "../../../src/agent/claude-usage.js";
import type { AgentEvent } from "../../../src/agent/types.js";

type U = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

const usage = (u: U) => ({
  input_tokens: u.input ?? 0,
  output_tokens: u.output ?? 0,
  cache_read_input_tokens: u.cacheRead ?? 0,
  cache_creation_input_tokens: u.cacheWrite ?? 0,
});

const assistant = (u: U) => ({ type: "assistant", message: { usage: usage(u) } });

const result = (u: U) => ({ type: "result", is_error: false, usage: usage(u) });

function totals(events: (AgentEvent | null)[]) {
  const usage = events.filter(
    (e): e is Extract<AgentEvent, { type: "usage" }> => e?.type === "usage",
  );
  return {
    input: usage.reduce((s, e) => s + e.inputTokens, 0),
    output: usage.reduce((s, e) => s + e.outputTokens, 0),
    cacheRead: usage.reduce((s, e) => s + (e.cacheReadTokens ?? 0), 0),
    cacheWrite: usage.reduce((s, e) => s + (e.cacheWriteTokens ?? 0), 0),
  };
}

describe("accountUsage", () => {
  it("dedups repeated lines of one call and sums distinct calls, reconciling to result", () => {
    const s = newUsageState();
    const emitted = [
      accountUsage(s, assistant({ input: 10, output: 4, cacheRead: 13782, cacheWrite: 12546 })),
      accountUsage(s, assistant({ input: 10, output: 4, cacheRead: 13782, cacheWrite: 12546 })), // dup
      accountUsage(s, assistant({ input: 8, output: 2, cacheRead: 26328, cacheWrite: 173 })),
      accountUsage(s, assistant({ input: 8, output: 2, cacheRead: 26328, cacheWrite: 173 })), // dup
      accountUsage(s, result({ input: 18, output: 162, cacheRead: 40110, cacheWrite: 12719 })),
    ];
    // Two live per-call events + one reconcile; the two dups return null.
    expect(emitted.filter((e) => e?.type === "usage")).toHaveLength(3);
    expect(emitted[1]).toBeNull();
    expect(emitted[3]).toBeNull();
    // Every axis sums exactly to result.usage — the number that gets persisted.
    expect(totals(emitted)).toEqual({
      input: 18,
      output: 162,
      cacheRead: 40110,
      cacheWrite: 12719,
    });
  });

  it("resets per turn so per-turn usage sums across turns instead of high-watering", () => {
    const s = newUsageState();

    // Turn 1
    resetTurnUsage(s);
    const t1 = [
      accountUsage(s, assistant({ input: 10, output: 4, cacheRead: 17753, cacheWrite: 8558 })),
      accountUsage(s, result({ input: 10, output: 117, cacheRead: 17753, cacheWrite: 8558 })),
    ];
    expect(totals(t1)).toEqual({ input: 10, output: 117, cacheRead: 17753, cacheWrite: 8558 });

    // Turn 2 — smaller cacheWrite and same input than turn 1: a high-water deduper
    // would drop it. Per-turn reset makes it sum correctly.
    resetTurnUsage(s);
    const t2 = [
      accountUsage(s, assistant({ input: 10, output: 4, cacheRead: 26311, cacheWrite: 168 })),
      accountUsage(s, result({ input: 10, output: 582, cacheRead: 26311, cacheWrite: 168 })),
    ];
    expect(totals(t2)).toEqual({ input: 10, output: 582, cacheRead: 26311, cacheWrite: 168 });

    // Session total = sum of both turns.
    const all = totals([...t1, ...t2]);
    expect(all).toEqual({ input: 20, output: 699, cacheRead: 44064, cacheWrite: 8726 });
  });

  it("trues the turn total DOWN to result.usage when the live stream over-reported", () => {
    // result.usage is authoritative. If the streamed per-call figures ever
    // exceed it on an axis — a distinct call wrongly deduped, or the CLI
    // reporting input/cache cumulatively rather than per-call — the reconcile
    // must emit a NEGATIVE correction so the persisted per-turn total lands
    // exactly on result.usage and never above it.
    const s = newUsageState();
    const emitted = [
      accountUsage(s, assistant({ input: 100, output: 4, cacheRead: 500, cacheWrite: 0 })),
      accountUsage(s, assistant({ input: 100, output: 4, cacheRead: 900, cacheWrite: 0 })),
      // Authoritative total is smaller than the streamed sum (200 in / 1400 read).
      accountUsage(s, result({ input: 120, output: 130, cacheRead: 900, cacheWrite: 0 })),
    ];
    // Summed across live + reconcile, every axis equals result.usage exactly.
    expect(totals(emitted)).toEqual({ input: 120, output: 130, cacheRead: 900, cacheWrite: 0 });
    const reconcile = emitted[2] as Extract<AgentEvent, { type: "usage" }>;
    expect(reconcile.inputTokens).toBe(-80); // 120 - 200
    expect(reconcile.cacheReadTokens).toBe(-500); // 900 - 1400
    expect(reconcile.outputTokens).toBe(122); // 130 - 8, trued up
  });

  it("clears lastCallSnapshot per turn so turn 2's first call is not deduped against turn 1's last", () => {
    const s = newUsageState();
    resetTurnUsage(s);
    accountUsage(s, assistant({ input: 10, output: 4, cacheRead: 100, cacheWrite: 5 }));
    accountUsage(s, result({ input: 10, output: 50, cacheRead: 100, cacheWrite: 5 }));

    // Turn 2's first assistant line is byte-identical to turn 1's last. Only a
    // reset of lastCallSnapshot stops it being silently dropped as a "repeat".
    resetTurnUsage(s);
    const first = accountUsage(
      s,
      assistant({ input: 10, output: 4, cacheRead: 100, cacheWrite: 5 }),
    );
    expect(first).not.toBeNull();
    expect((first as Extract<AgentEvent, { type: "usage" }>).inputTokens).toBe(10);
  });

  it("emits nothing extra when result matches what already streamed", () => {
    const s = newUsageState();
    accountUsage(s, assistant({ input: 10, output: 50, cacheRead: 100, cacheWrite: 0 }));
    // result equals the single streamed call exactly → zero reconcile delta.
    const reconcile = accountUsage(
      s,
      result({ input: 10, output: 50, cacheRead: 100, cacheWrite: 0 }),
    );
    expect(reconcile).toBeNull();
  });

  it("ignores non-usage lines", () => {
    const s = newUsageState();
    expect(accountUsage(s, { type: "system", subtype: "init" })).toBeNull();
    expect(accountUsage(s, { type: "assistant", message: {} })).toBeNull();
    expect(accountUsage(s, { type: "result", is_error: false })).toBeNull();
  });
});

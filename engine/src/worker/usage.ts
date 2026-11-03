import type { AgentEvent } from "../agent/types.js";
import type { TokenTotals } from "../telemetry/types.js";

/**
 * Accumulate a usage event's token counts into a running total. No-op for
 * non-usage events, so callers can pass every event unconditionally. Cache
 * read/write default to 0 for adapters that don't surface prompt caching.
 */
export function addUsageTokens(totals: TokenTotals, event: AgentEvent): void {
  if (event.type !== "usage") return;
  totals.input += event.inputTokens;
  totals.output += event.outputTokens;
  totals.cacheRead += event.cacheReadTokens ?? 0;
  totals.cacheWrite += event.cacheWriteTokens ?? 0;
}

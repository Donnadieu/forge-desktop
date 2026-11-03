/**
 * Layer-0 shared types for per-ticket telemetry. The orchestrator builds these
 * payloads and reports them to the Factory, whose `_upsert_ticket` persists
 * them. Lives here rather than under `orchestrator/` so other layers don't have
 * to import "up" into the coordination layer.
 */

import type { NormalizedIssue } from "../tracker/types.js";

/**
 * Cumulative token totals for one worker session/ticket. `cacheRead` /
 * `cacheWrite` are the prompt-cache read/creation tokens, kept separate from
 * `input` (fresh, non-cached) so each is priced at its own rate downstream.
 */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** In-memory record of one turn's timing/tokens/events. Times are perf.now(). */
export interface TurnTimingEntry {
  turnNumber: number;
  /** performance.now() monotonic at turn start */
  startedAt: number;
  /** performance.now() monotonic at turn end; null while turn in flight */
  finishedAt: number | null;
  /** Snapshot of entry.tokens at turn start; used to compute per-turn delta. */
  tokensInputAtStart: number;
  tokensOutputAtStart: number;
  tokensCacheReadAtStart: number;
  tokensCacheWriteAtStart: number;
  eventCount: number;
  lastEventType: string | null;
}

/** How one card's run ended (or that it is still running). */
export type TicketStatus = "running" | "completed" | "failed" | "cancelled" | "stalled";

/**
 * Telemetry payload handed to `onTicketComplete`. Wall-clock fields are
 * absolute (Date.now()-derived) so consumers can persist them directly.
 */
export interface TicketTelemetry {
  issueId: string;
  identifier: string;
  ticketTitle: string;
  /** Absolute wall-clock start (ms since epoch). */
  startedAtMs: number;
  /** Absolute wall-clock end (ms since epoch). */
  finishedAtMs: number;
  durationMs: number;
  turns: number;
  tokens: TokenTotals;
  /** Per-turn timings with absolute wall-clock timestamps. */
  turnTimings: Array<{
    turnNumber: number;
    startedAtMs: number;
    finishedAtMs: number;
    durationMs: number;
    tokensInput: number;
    tokensOutput: number;
    tokensCacheRead: number;
    tokensCacheWrite: number;
    eventCount: number;
    lastEventType: string | null;
  }>;
  success: boolean;
  status: TicketStatus;
  errorMessage: string | null;
  workspacePath: string | null;
  attempt: number;
  issue: NormalizedIssue;
}

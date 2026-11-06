/**
 * Worker-side callback wiring for the orchestrator. Captures per-event /
 * per-turn telemetry into `RunningEntry.turnTimings` and forwards every
 * event to the user-facing `OrchestratorCallbacks`. Extracted from
 * `orchestrator.ts` to keep the class under the architecture line ceiling
 * — see ARCHITECTURE.md.
 */

import type { AgentEvent } from "../agent/types.js";
import { detectUsageLimit } from "../agent/usage-limit.js";
import type { WorkerCallbacks } from "../worker/runner.js";
import { addUsageTokens } from "../worker/usage.js";
import { applyHelperEvent, plainActivity } from "./activity.js";
import type { OrchestratorCallbacks, OrchestratorState, RunningEntry } from "./types.js";
import { clearLimit } from "./usage-limits.js";

/** A tool call, or text that isn't the limit message itself (Claude Code prints that as its reply). */
function gotGoing(event: AgentEvent): boolean {
  if (event.type === "tool_use") return true;
  return event.type === "text" && event.content.trim() !== "" && !detectUsageLimit(event.content);
}

export function makeWorkerCallbacks(
  state: OrchestratorState,
  callbacks: OrchestratorCallbacks,
  signal: AbortSignal,
  shouldStop?: () => boolean,
): WorkerCallbacks {
  // Only the entry dispatched with this worker's signal is ours: a killed
  // worker's late events must not refresh a successor's activity or telemetry.
  const ownEntry = (issueId: string): RunningEntry | undefined => {
    const entry = state.running.get(issueId);
    return entry?.abortController.signal === signal ? entry : undefined;
  };
  return {
    signal,
    shouldStop,
    onEvent: (issueId, event) => {
      // Always accumulate global totals regardless of entry lookup
      addUsageTokens(state.totalTokens, event);
      if (event.type === "rate_limit") {
        state.rateLimits[event.window] = {
          percent: event.percent,
          resetsAt: event.resetsAt,
          status: event.status,
          seenAt: new Date().toISOString(),
        };
      }
      const runEntry = ownEntry(issueId);
      if (runEntry) applyEventToEntry(runEntry, event);
      // The account answered with work, not a limit: its usage limit is over (usage-limits.ts).
      if (runEntry && state.usageLimits.size > 0 && gotGoing(event))
        clearLimit(state, runEntry.limitKey);
      callbacks.onEvent?.(issueId, event);
    },
    onTurnStart: (issueId, turn) => {
      const runEntry = ownEntry(issueId);
      if (!runEntry) return;
      runEntry.turnCount = turn;
      // Defensive: if a prior turn never got an onTurnEnd (early break in
      // the worker loop on error/timeout), close it out with the current
      // timestamp so timing data isn't silently dropped.
      const prior = runEntry.turnTimings[runEntry.turnTimings.length - 1];
      if (prior && prior.finishedAt === null) {
        prior.finishedAt = performance.now();
      }
      runEntry.turnTimings.push({
        turnNumber: turn,
        startedAt: performance.now(),
        finishedAt: null,
        tokensInputAtStart: runEntry.tokens.input,
        tokensOutputAtStart: runEntry.tokens.output,
        tokensCacheReadAtStart: runEntry.tokens.cacheRead,
        tokensCacheWriteAtStart: runEntry.tokens.cacheWrite,
        eventCount: 0,
        lastEventType: null,
      });
    },
    onTurnEnd: (issueId, turn) => {
      const runEntry = ownEntry(issueId);
      if (!runEntry) return;
      const last = runEntry.turnTimings[runEntry.turnTimings.length - 1];
      if (last && last.turnNumber === turn && last.finishedAt === null) {
        last.finishedAt = performance.now();
      }
    },
  };
}

function applyEventToEntry(runEntry: RunningEntry, event: AgentEvent): void {
  runEntry.lastActivityAt = performance.now();
  runEntry.lastEvent = event.type;
  if (event.type === "usage") {
    addUsageTokens(runEntry.tokens, event);
  } else if (event.type === "text") {
    runEntry.lastMessage = event.content.slice(0, 200);
  } else if (event.type === "tool_use") {
    runEntry.lastMessage = event.tool;
  }
  const line = plainActivity(event);
  if (line && line !== runEntry.activity) {
    runEntry.activity = line;
    runEntry.recent.push({ at: new Date().toISOString(), line });
    if (runEntry.recent.length > 40) runEntry.recent.shift();
  }
  applyHelperEvent(runEntry.helpers, event);
  // Attribute the event to the most recent open turn timing entry, if any.
  const last = runEntry.turnTimings[runEntry.turnTimings.length - 1];
  if (last && last.finishedAt === null) {
    last.eventCount++;
    last.lastEventType = event.type;
  }
}

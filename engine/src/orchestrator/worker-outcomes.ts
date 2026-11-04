/**
 * Post-worker handlers — what to do when a dispatched worker completes
 * successfully (with or without continuation) or errors out. Extracted from
 * the `Orchestrator` class so the class file stays under the architecture
 * line-count ceiling.
 */

import type { TicketTelemetry, TokenTotals } from "../telemetry/types.js";
import type { WorkerResult } from "../worker/runner.js";
import { scheduleRetry } from "./retry-queue.js";
import { holdUntilSettled, ownedEntry } from "./session-guard.js";
import type {
  OrchestratorCallbacks,
  OrchestratorConfig,
  OrchestratorState,
  RunningEntry,
} from "./types.js";

export interface WorkerOutcomeDeps {
  state: OrchestratorState;
  config: OrchestratorConfig;
  callbacks: OrchestratorCallbacks;
  refetchAndDispatch: (issueId: string, attempt: number, checkState: boolean) => void;
}

/**
 * Build a `TicketTelemetry` payload from the in-memory RunningEntry plus the
 * final outcome. Converts performance.now() timestamps in `turnTimings` to
 * absolute wall-clock (ms since epoch) using the entry's snapshotted wall-clock
 * start so consumers can persist them as `timestamptz` values directly.
 */
export function buildTicketTelemetry(
  entry: RunningEntry,
  status: TicketTelemetry["status"],
  success: boolean,
  errorMessage: string | null,
  durationMs: number,
  turns: number,
  tokens: TokenTotals,
  workspacePath: string | null,
): TicketTelemetry {
  const wallClockStartedAtMs = entry.wallClockStartedAtMs;
  const entryTurnTimings = entry.turnTimings;
  const perfToWall = (perf: number): number => wallClockStartedAtMs + (perf - entry.startedAt);
  const startedAtMs = wallClockStartedAtMs;
  const finishedAtMs = startedAtMs + durationMs;

  const turnTimings: TicketTelemetry["turnTimings"] = [];
  for (let i = 0; i < entryTurnTimings.length; i++) {
    const t = entryTurnTimings[i];
    const next = entryTurnTimings[i + 1];
    // If finishedAt is missing (worker exited mid-turn), fall back to the next
    // turn's start, then ticket end. Same projection rule.
    const finishedPerf = t.finishedAt ?? (next ? next.startedAt : entry.startedAt + durationMs);
    const tStart = perfToWall(t.startedAt);
    const tEnd = perfToWall(finishedPerf);
    turnTimings.push({
      turnNumber: t.turnNumber,
      startedAtMs: tStart,
      finishedAtMs: tEnd,
      durationMs: Math.max(0, tEnd - tStart),
      tokensInput: Math.max(0, tokens.input - t.tokensInputAtStart),
      tokensOutput: Math.max(0, tokens.output - t.tokensOutputAtStart),
      tokensCacheRead: Math.max(0, tokens.cacheRead - t.tokensCacheReadAtStart),
      tokensCacheWrite: Math.max(0, tokens.cacheWrite - t.tokensCacheWriteAtStart),
      eventCount: t.eventCount,
      lastEventType: t.lastEventType,
    });
  }
  // Per-turn token deltas computed above use the running totals at completion,
  // which overcounts every turn except the last. Recompute as adjacent diffs.
  for (let i = 0; i < turnTimings.length - 1; i++) {
    const cur = entryTurnTimings[i];
    const nxt = entryTurnTimings[i + 1];
    turnTimings[i].tokensInput = Math.max(0, nxt.tokensInputAtStart - cur.tokensInputAtStart);
    turnTimings[i].tokensOutput = Math.max(0, nxt.tokensOutputAtStart - cur.tokensOutputAtStart);
    turnTimings[i].tokensCacheRead = Math.max(
      0,
      nxt.tokensCacheReadAtStart - cur.tokensCacheReadAtStart,
    );
    turnTimings[i].tokensCacheWrite = Math.max(
      0,
      nxt.tokensCacheWriteAtStart - cur.tokensCacheWriteAtStart,
    );
  }

  return {
    issueId: entry.issueId,
    identifier: entry.identifier,
    ticketTitle: entry.issue.title,
    startedAtMs,
    finishedAtMs,
    durationMs,
    turns,
    tokens,
    turnTimings,
    success,
    status,
    errorMessage,
    workspacePath,
    attempt: entry.attempt,
    issue: entry.issue,
  };
}

export function emitTicketTelemetry(deps: WorkerOutcomeDeps, telemetry: TicketTelemetry): void {
  const cb = deps.callbacks.onTicketComplete;
  if (!cb) return;
  // Defensive: implementations are expected to swallow their own errors, but
  // a thrown promise would surface as an unhandled rejection on this code path.
  try {
    cb(telemetry.issueId, telemetry);
  } catch {
    // Telemetry must never block the orchestrator.
  }
}

/**
 * Settle a running entry's terminal outcome: book its duration, build + store
 * the telemetry/result, and emit. Shared by the kill path (`recordKilledTicket`)
 * and the tracker-done path (`recordTrackerCompletedTicket`) — the only
 * differences are the status, success flag, and error label. A successful settle
 * is, by definition, a completed ticket, so the `completed` set is driven off
 * `success` rather than a separate flag. `error` doubles as the telemetry error
 * message and the `result.error` field (omitted from `result` when null,
 * matching the success contract).
 */
function recordSettledTicket(
  deps: WorkerOutcomeDeps,
  entry: RunningEntry,
  opts: {
    status: TicketTelemetry["status"];
    success: boolean;
    error: string | null;
  },
): { durationMs: number } {
  const durationMs = performance.now() - entry.startedAt;
  deps.state.secondsRunning += durationMs / 1000;
  const telemetry = buildTicketTelemetry(
    entry,
    opts.status,
    opts.success,
    opts.error,
    durationMs,
    entry.turnCount,
    entry.tokens,
    entry.workspacePath,
  );
  deps.state.ticketOutcomes.set(entry.issueId, {
    result: {
      issueId: entry.issueId,
      success: opts.success,
      turns: entry.turnCount,
      tokens: entry.tokens,
      ...(opts.error !== null ? { error: opts.error } : {}),
    },
    identifier: entry.identifier,
    durationMs,
    telemetry,
  });
  if (opts.success) deps.state.completed.add(entry.issueId);
  emitTicketTelemetry(deps, telemetry);
  return { durationMs };
}

/**
 * Build + emit + record telemetry for a worker that's being killed via the
 * orchestrator's kill path (stalled by reconciler, or cancelled because the
 * tracker terminated the ticket mid-flight). Mirrors the
 * `handleWorkerComplete` contract so killed tickets still appear in the
 * build report and `build_tickets` table.
 */
export function recordKilledTicket(
  deps: WorkerOutcomeDeps,
  entry: RunningEntry,
  status: "cancelled" | "stalled",
): { durationMs: number } {
  return recordSettledTicket(deps, entry, {
    status,
    success: false,
    error: status === "stalled" ? "Stalled" : "Cancelled",
  });
}

/**
 * Record a ticket whose tracker issue reached a SUCCESS/done state while its
 * worker was still mid-flight (the orchestrator's poll observed Linear
 * "Done"/"Closed" before the worker's own completion settled). Mirrors
 * `recordKilledTicket` but marks the outcome `completed`/`success` with the
 * entry's real tokens/turns — the work landed, so it must NOT be recorded as
 * `cancelled` (the long-standing bug where every successful ticket persisted as
 * `cancelled` because agents move their own tickets to Done on success).
 */
export function recordTrackerCompletedTicket(
  deps: WorkerOutcomeDeps,
  entry: RunningEntry,
): { durationMs: number } {
  return recordSettledTicket(deps, entry, {
    status: "completed",
    success: true,
    error: null,
  });
}

/**
 * Take a running entry out of flight: record its terminal outcome (via
 * `record`) BEFORE aborting/deleting so the entry's turnTimings/tokens are
 * intact, then abort the worker and move it from `running` to `settling`. The
 * issue stays reserved until the aborted worker has exited, so no retry or poll
 * starts a second session in its workspace (FRG-4086). The aborted worker
 * promise later resolves into handleWorkerComplete, which no-ops on the
 * now-absent entry. Workspaces are intentionally preserved — never deleted.
 */
export function settleRunningEntry(
  deps: WorkerOutcomeDeps,
  issueId: string,
  record: (deps: WorkerOutcomeDeps, entry: RunningEntry) => void,
): void {
  const entry = deps.state.running.get(issueId);
  if (!entry) return;
  record(deps, entry);
  entry.abortController.abort();
  deps.state.running.delete(issueId);
  holdUntilSettled(deps.state, issueId, entry.identifier, entry.workerPromise, deps.config.logger);
}

/**
 * The tracker observed the issue's Linear state reach a done_state while its
 * worker was still mid-flight. Settle the entry as completed/success, then fire
 * the per-ticket `onComplete` hand-off — in Smith mode this is the ONLY trigger
 * for `markAwaitingReview` (executing→awaiting_review, 48h bug window, Linear →
 * In Review, `feature_complete` frame). Re-uses the success `WorkerResult`
 * `recordTrackerCompletedTicket` just stored and mirrors `handleWorkerComplete`'s
 * delete-then-fire order. `willRetry=false`: a tracker-done ticket is terminal
 * success. Single-fire is preserved — `settleRunningEntry` deletes the entry, so
 * the aborted worker's later `handleWorkerComplete` no-ops at the `!entry` guard.
 * (`markAwaitingReview` CAS-expects `executing`; an out-of-band cancel makes it
 * throw, which the Smith complete handler catches and swallows.)
 */
export function completeSettledFromTracker(deps: WorkerOutcomeDeps, issueId: string): void {
  const entry = deps.state.running.get(issueId);
  if (!entry) return;
  const { issue } = entry;
  settleRunningEntry(deps, issueId, recordTrackerCompletedTicket);
  const stored = deps.state.ticketOutcomes.get(issueId);
  if (stored) deps.callbacks.onComplete?.(issueId, stored.result, issue, false);
}

export function handleWorkerComplete(
  deps: WorkerOutcomeDeps,
  issueId: string,
  result: WorkerResult,
  attempt: number,
  owner?: RunningEntry,
): void {
  const { entry } = ownedEntry(deps.state, deps.config.logger, issueId, owner);
  if (!entry) return; // Already handled by killWorker/killAndRetry
  const durationMs = performance.now() - entry.startedAt;
  deps.state.secondsRunning += durationMs / 1000;

  // Build telemetry BEFORE deleting the entry — buildTicketTelemetry reads
  // wallClockStartedAtMs/turnTimings from it.
  const telemetry = buildTicketTelemetry(
    entry,
    result.success ? "completed" : "failed",
    result.success,
    result.error ?? null,
    durationMs,
    result.turns,
    result.tokens,
    result.workspacePath ?? entry.workspacePath,
  );

  // Store outcome for build report enrichment + intelligence-loop harvest.
  deps.state.ticketOutcomes.set(issueId, {
    result,
    identifier: entry.identifier,
    durationMs,
    telemetry,
  });

  const hitMaxTurns = result.success && result.turns >= deps.config.maxTurns;

  emitTicketTelemetry(deps, telemetry);

  deps.state.running.delete(issueId);
  deps.state.completed.add(issueId);

  const { identifier } = entry;
  const retryCallback = (id: string): void => deps.refetchAndDispatch(id, attempt + 1, true);
  const isContinuation = hitMaxTurns || (result.preserveWorkspace && result.success);
  // A failed run is retried with backoff when its workspace was kept (single-turn agents) or
  // when the agent said why it failed (a lapsed sign-in, a usage limit): the retry queue carries
  // that reason to the window, which shows it with its fix instead of the card failing silently
  // and being picked up again on the next poll. A stop or kill ("Aborted") is never retried here.
  const saidWhy = result.error !== undefined && result.error !== "Aborted";
  const isRetryableFailure =
    !result.success &&
    (result.preserveWorkspace === true || saidWhy) &&
    attempt < deps.config.maxRetryAttempts;
  // A retryable failure will be re-dispatched below — tell onComplete so a
  // terminal consumer (Smith `failed`) doesn't finalize a build that may yet
  // succeed on the next attempt.
  deps.callbacks.onComplete?.(issueId, result, entry.issue, isRetryableFailure);

  if (!isContinuation && !isRetryableFailure) return;
  scheduleRetry(
    deps.state,
    issueId,
    identifier,
    attempt + 1,
    isContinuation ? "continuation" : "failure",
    isContinuation ? null : (result.error ?? null),
    deps.config.maxRetryDelayMs,
    retryCallback,
    deps.config.retryBaseDelayMs,
  );
}

export function handleWorkerError(
  deps: WorkerOutcomeDeps,
  issueId: string,
  identifier: string,
  error: unknown,
  attempt: number,
  owner?: RunningEntry,
): void {
  const { entry, foreign } = ownedEntry(deps.state, deps.config.logger, issueId, owner);
  if (foreign) return;
  const err = error instanceof Error ? error : new Error(String(error));

  // If killWorker has already recorded a rich outcome for this id (kill →
  // abort → rejected worker promise → here), don't overwrite it with the
  // bare error synthesis below. The kill path captured the real turns /
  // tokens / turnTimings; landing here second would clobber them.
  if (!entry && deps.state.ticketOutcomes.has(issueId)) {
    deps.callbacks.onError?.(issueId, err);
    return;
  }

  let durationMs = 0;
  if (entry) {
    durationMs = performance.now() - entry.startedAt;
    deps.state.secondsRunning += durationMs / 1000;
  }

  // Build telemetry while the entry is still around (mirrors success path).
  const telemetry = entry
    ? buildTicketTelemetry(
        entry,
        "failed",
        false,
        err.message,
        durationMs,
        entry.turnCount,
        entry.tokens,
        entry.workspacePath,
      )
    : undefined;

  // Synthesize a failure result so terminal worker errors still surface in
  // the build report / harvested learnings. When an entry exists, copy its
  // real turn/token counts so dashboards reading `result.*` (the legacy
  // path) see what the ticket actually did before erroring out.
  deps.state.ticketOutcomes.set(issueId, {
    result: {
      issueId,
      success: false,
      turns: entry?.turnCount ?? 0,
      tokens: entry ? { ...entry.tokens } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      error: err.message,
    },
    identifier,
    durationMs,
    telemetry,
  });

  if (telemetry) emitTicketTelemetry(deps, telemetry);

  deps.state.running.delete(issueId);
  deps.callbacks.onError?.(issueId, err);

  if (attempt < deps.config.maxRetryAttempts) {
    scheduleRetry(
      deps.state,
      issueId,
      identifier,
      attempt + 1,
      "failure",
      err.message,
      deps.config.maxRetryDelayMs,
      (retryIssueId) => deps.refetchAndDispatch(retryIssueId, attempt + 1, true),
      deps.config.retryBaseDelayMs,
    );
  }
}

import type { OrchestratorState } from "./types.js";

const CONTINUATION_DELAY_MS = 1_000; // 1 second for normal continuation
const DEFAULT_FAILURE_BASE_DELAY_MS = 10_000; // 10 seconds base for failures

/**
 * Calculate retry delay based on attempt number and delay type.
 */
export function calculateRetryDelay(
  attempt: number,
  delayType: "continuation" | "failure",
  maxDelayMs: number,
  baseDelayMs?: number,
): number {
  if (delayType === "continuation") {
    return CONTINUATION_DELAY_MS;
  }

  // Exponential backoff: base * 2^(attempt-1), capped at max
  const base = baseDelayMs ?? DEFAULT_FAILURE_BASE_DELAY_MS;
  const delay = base * 2 ** (attempt - 1);
  return Math.min(delay, maxDelayMs);
}

/**
 * Schedule a retry for an issue.
 */
export function scheduleRetry(
  state: OrchestratorState,
  issueId: string,
  identifier: string,
  attempt: number,
  delayType: "continuation" | "failure",
  error: string | null,
  maxDelayMs: number,
  onRetry: (issueId: string) => void,
  baseDelayMs?: number,
): void {
  // Cancel existing retry if any
  cancelRetry(state, issueId);

  const delay = calculateRetryDelay(attempt, delayType, maxDelayMs, baseDelayMs);

  // Reservation handoff: the entry is NOT deleted when the timer fires. It
  // stays in `retryAttempts` — holding the agent's slot in `inFlightCount` —
  // until the dispatch path (`refetchAndDispatch`) registers the issue in
  // `running` and releases it via `cancelRetry` in its `finally`. Deleting here
  // would briefly free the slot during `refetchAndDispatch`'s awaited tracker
  // calls, letting a poll tick double-dispatch a waiting feature.
  const timerId = setTimeout(() => {
    onRetry(issueId);
  }, delay);

  state.retryAttempts.set(issueId, {
    issueId,
    identifier,
    attempt,
    dueAtMs: performance.now() + delay,
    delayType,
    error,
    timerId,
  });
}

/**
 * Cancel a pending retry.
 */
export function cancelRetry(state: OrchestratorState, issueId: string): void {
  const existing = state.retryAttempts.get(issueId);
  if (existing) {
    clearTimeout(existing.timerId);
    state.retryAttempts.delete(issueId);
  }
}

/**
 * Cancel all pending retries.
 */
export function cancelAllRetries(state: OrchestratorState): void {
  for (const [id] of state.retryAttempts) {
    cancelRetry(state, id);
  }
}

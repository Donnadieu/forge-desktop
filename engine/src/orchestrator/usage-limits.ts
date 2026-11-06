/**
 * Usage limits (Forge Desktop): when an agent's account hits a usage, spend or rate limit, the card waits for the
 * reset instead of retrying. The wait uses no retry attempt and holds no agent slot, no other card of that account
 * is started meanwhile, and at the reset the cards go again by themselves. The limit ends when a run of that
 * account gets going again (or a run succeeds). The app shows it as a banner and the cards as "Waiting for limit".
 *
 * New in Forge Desktop.
 */

import { detectUsageLimit, type UsageLimit } from "../agent/usage-limit.js";
import { cancelRetry } from "./retry-queue.js";
import type { LimitState, OrchestratorState } from "./types.js";

/** Cards try again this long after the reset the provider gave, so the window has really rolled over. */
export const AFTER_RESET_MS = 30_000;
/** No reset time given: a rate limit is tried again after this... */
export const RATE_CHECK_MS = 5 * 60_000;
/** ...and a spend, credit or usage limit after this. */
export const LIMIT_CHECK_MS = 30 * 60_000;
/** A limit nobody waits on any more is forgotten this long after its time. */
const FORGET_AFTER_MS = 15 * 60_000;
/** One timer waits at most this long, then checks again (setTimeout's ceiling is ~24.8 days). */
const MAX_TIMER_MS = 6 * 60 * 60_000;

/** When cards of a limited account try again. */
export function waitUntil(limit: UsageLimit, now = Date.now()): number {
  const reset = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN;
  if (!Number.isNaN(reset) && reset > now) return reset + AFTER_RESET_MS;
  return now + (limit.kind === "rate" ? RATE_CHECK_MS : LIMIT_CHECK_MS);
}

/** Records that `key`'s account is limited (keeping when it was first seen). */
export function noteLimit(
  state: OrchestratorState,
  key: number,
  limit: UsageLimit,
  message: string,
  now = Date.now(),
): LimitState {
  const before = state.usageLimits.get(key);
  const entry: LimitState = {
    key,
    kind: limit.kind,
    reason: limit.reason,
    message,
    link: limit.link,
    resetsAt: limit.resetsAt,
    untilMs: waitUntil(limit, now),
    sinceMs: before?.sinceMs ?? now,
  };
  state.usageLimits.set(key, entry);
  return entry;
}

/** Whether `key`'s account is limited now: its cards wait, and none of them is started. */
export function limitActive(state: OrchestratorState, key: number, now = Date.now()): boolean {
  const l = state.usageLimits.get(key);
  return l !== undefined && now < l.untilMs;
}

/** A run of `key`'s account got going (or succeeded): the limit is over. */
export function clearLimit(state: OrchestratorState, key: number | undefined): void {
  if (state.usageLimits.size > 0) state.usageLimits.delete(key ?? -1);
}

/**
 * Whether a failed run hit a limit; if so the limit is recorded and the card waits for it (same attempt, no slot).
 * Returns false for any other failure, which the caller retries as before.
 */
export function waitIfLimited(
  state: OrchestratorState,
  run: { issueId: string; identifier: string; attempt: number; limitKey?: number },
  error: string | null | undefined,
  resume: (issueId: string) => void,
  now = Date.now(),
): boolean {
  const limit = detectUsageLimit(error, new Date(now));
  if (!limit || !error) return false;
  const key = run.limitKey ?? -1;
  noteLimit(state, key, limit, error, now);
  scheduleLimitWait(state, run.issueId, run.identifier, run.attempt, key, error, resume);
  return true;
}

/**
 * Parks a card until its account's limit is over. When the timer fires and the limit was pushed later meanwhile
 * (another card saw a later reset), it waits again; otherwise the entry becomes an ordinary reservation (it takes
 * its agent slot back) and `resume` dispatches it.
 */
export function scheduleLimitWait(
  state: OrchestratorState,
  issueId: string,
  identifier: string,
  attempt: number,
  key: number,
  error: string,
  resume: (issueId: string) => void,
): void {
  cancelRetry(state, issueId);
  const until = state.usageLimits.get(key)?.untilMs ?? Date.now();
  const delay = Math.min(Math.max(until - Date.now(), 0), MAX_TIMER_MS);
  const timerId = setTimeout(() => {
    const entry = state.retryAttempts.get(issueId);
    if (entry?.timerId !== timerId) return;
    if (limitActive(state, key)) {
      scheduleLimitWait(state, issueId, identifier, attempt, key, error, resume);
      return;
    }
    entry.limitKey = undefined;
    resume(issueId);
  }, delay);
  state.retryAttempts.set(issueId, {
    issueId,
    identifier,
    attempt,
    dueAtMs: performance.now() + Math.max(until - Date.now(), 0),
    delayType: "failure",
    error,
    timerId,
    limitKey: key,
  });
}

/** Forgets limits whose time passed long ago with no card waiting on them (the cards moved, or Stop was pressed). */
export function forgetStaleLimits(state: OrchestratorState, now = Date.now()): void {
  for (const [key, l] of state.usageLimits) {
    if (now < l.untilMs + FORGET_AFTER_MS) continue;
    const waiting = [...state.retryAttempts.values()].some((r) => r.limitKey === key);
    const running = [...state.running.values()].some((r) => (r.limitKey ?? -1) === key);
    if (!waiting && !running) state.usageLimits.delete(key);
  }
}

/** The limits the app shows, oldest first. */
export function limitList(state: OrchestratorState): LimitState[] {
  return [...state.usageLimits.values()].sort((a, b) => a.sinceMs - b.sinceMs);
}

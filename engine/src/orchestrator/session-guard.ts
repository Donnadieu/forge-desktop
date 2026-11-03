/**
 * One live agent session per issue (FRG-4086). Helpers that keep a killed
 * worker's issue reserved until its process has exited, refuse (and log) a
 * dispatch for an issue that already has a live session, and stop a killed
 * worker's late outcome from touching its successor's running entry.
 */

import type { Logger } from "pino";
import type { OrchestratorState, RunningEntry, SettlingEntry } from "./types.js";

/** How long a killed worker may take to exit before we warn (never force-release). */
export const SETTLING_WARN_MS = 10 * 60 * 1000;

export type LiveSessionReason = "running" | "claimed" | "settling";

/** Why `issueId` cannot be dispatched right now, or `null` when it is free. */
export function liveSessionReason(
  state: OrchestratorState,
  issueId: string,
): LiveSessionReason | null {
  if (state.running.has(issueId)) return "running";
  if (state.claimed.has(issueId)) return "claimed";
  if (state.settling.has(issueId)) return "settling";
  return null;
}

/**
 * Whether no work is live or pending: nothing running, retrying, or killed but
 * still exiting. Drives the idle→active runtime-clock transition.
 */
export function hasNoLiveWork(state: OrchestratorState): boolean {
  return state.running.size === 0 && state.retryAttempts.size === 0 && state.settling.size === 0;
}

export function logDispatchSuppressed(
  logger: Logger | undefined,
  fields: {
    issueId: string;
    identifier: string | undefined;
    attempt: number;
    reason: LiveSessionReason;
  },
): void {
  logger?.info(fields, "dispatch suppressed; issue already has a live session");
}

/**
 * Reserve `issueId` in `state.settling` until the killed worker's promise
 * settles. Only the reservation this call created is released, so a later kill
 * of a successor keeps its own. Warns once if the worker is slow to exit.
 */
export function holdUntilSettled(
  state: OrchestratorState,
  issueId: string,
  identifier: string,
  workerPromise: Promise<void>,
  logger: Logger | undefined,
): void {
  const warn = setTimeout(() => {
    logger?.warn(
      { issueId, identifier, waitedMs: SETTLING_WARN_MS },
      "killed worker has not exited; issue stays reserved",
    );
  }, SETTLING_WARN_MS);
  warn.unref?.();
  const entry: SettlingEntry = {
    identifier,
    exited: workerPromise
      .catch(() => {})
      .finally(() => {
        clearTimeout(warn);
        if (state.settling.get(issueId) === entry) state.settling.delete(issueId);
      }),
  };
  state.settling.set(issueId, entry);
}

/**
 * The running entry a worker's outcome may act on. Without an `owner` (legacy
 * callers) this is the entry for `issueId`. With one, an entry that belongs to
 * a different dispatch is `foreign`: the caller is a killed worker settling
 * late and must leave its successor alone.
 */
export function ownedEntry(
  state: OrchestratorState,
  logger: Logger | undefined,
  issueId: string,
  owner: RunningEntry | undefined,
): { entry: RunningEntry | undefined; foreign: boolean } {
  const entry = state.running.get(issueId);
  if (!entry || !owner || entry === owner) return { entry, foreign: false };
  logger?.debug(
    { issueId, identifier: entry.identifier, staleAttempt: owner.attempt, attempt: entry.attempt },
    "ignoring outcome of a killed worker; issue has a newer session",
  );
  return { entry: undefined, foreign: true };
}

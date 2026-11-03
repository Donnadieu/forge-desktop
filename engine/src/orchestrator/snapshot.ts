import type {
  RetrySnapshot,
  RunningSessionSnapshot,
  StateSnapshot,
  WorkspaceLockedSnapshot,
} from "../observability/types.js";
import { hasNoLiveWork } from "./session-guard.js";
import {
  isBuildActive,
  type OrchestratorState,
  type RetryEntry,
  type RunningEntry,
  type WorkspaceLockedEntry,
} from "./types.js";

function buildRunningSnapshot(entry: RunningEntry, now: number): RunningSessionSnapshot {
  const elapsedMs = now - entry.startedAt;
  const lastActivityMs = now - entry.lastActivityAt;
  return {
    issueId: entry.issueId,
    identifier: entry.identifier,
    title: entry.issue.title,
    description: entry.issue.description,
    state: entry.issue.state,
    sessionId: entry.sessionId,
    turnCount: entry.turnCount,
    lastEvent: entry.lastEvent,
    lastMessage: entry.lastMessage,
    activity: entry.activity,
    helpers: entry.helpers.map((h) => ({ ...h })),
    recent: [...entry.recent],
    startedAt: new Date(Date.now() - elapsedMs).toISOString(),
    lastEventAt: new Date(Date.now() - lastActivityMs).toISOString(),
    tokens: {
      input: entry.tokens.input,
      output: entry.tokens.output,
      total: entry.tokens.input + entry.tokens.output,
    },
    workspacePath: entry.workspacePath,
    attempt: entry.attempt,
    host: entry.host,
  };
}

function buildRetrySnapshot(entry: RetryEntry, now: number): RetrySnapshot {
  const dueInMs = entry.dueAtMs - now;
  return {
    issueId: entry.issueId,
    identifier: entry.identifier,
    attempt: entry.attempt,
    dueAt: new Date(Date.now() + Math.max(dueInMs, 0)).toISOString(),
    error: entry.error,
  };
}

function buildWorkspaceLockedSnapshot(
  issueId: string,
  entry: WorkspaceLockedEntry,
): WorkspaceLockedSnapshot {
  return {
    issueId,
    identifier: entry.identifier,
    holderPid: entry.holderPid,
    holderAgentPid: entry.holderAgentPid ?? null,
    holderStartedAt: entry.holderStartedAt,
    markedPids: entry.markedPids,
    orphaned: entry.orphaned,
    since: new Date(entry.sinceMs).toISOString(),
    reaping: entry.reaping,
  };
}

export function buildStateSnapshot(
  state: OrchestratorState,
  now: number = performance.now(),
): StateSnapshot {
  const running: RunningSessionSnapshot[] = [];
  for (const entry of state.running.values()) {
    running.push(buildRunningSnapshot(entry, now));
  }

  const retrying: RetrySnapshot[] = [];
  for (const entry of state.retryAttempts.values()) {
    retrying.push(buildRetrySnapshot(entry, now));
  }

  let activeSeconds = 0;
  for (const entry of state.running.values()) {
    activeSeconds += (now - entry.startedAt) / 1000;
  }

  // Runtime is scoped to the current active session. `sessionStartedAt` is the
  // session origin, reset at dispatch on the idle→active transition, so a new
  // Smith feature does not inherit a previous Forge build's runtime. It counts
  // up from that origin while any work is in-flight or pending retry. When the
  // anvil is fully idle Runtime reads 0.
  //
  // For tracker-reported multi-ticket builds the poll cycle keeps a separate
  // `buildStartedAt` origin that is set on the first dispatch and held steady
  // until the build finishes. This keeps the Anvil Runtime clock continuous
  // across individual workers finishing within a single Forge build (e.g. the
  // initial build) instead of restarting for every ticket.
  const buildActive = isBuildActive(state.progress);
  const idle = hasNoLiveWork(state) && !buildActive;
  let wallClockSeconds = 0;
  if (!idle) {
    // Multi-ticket builds count from the steady `buildStartedAt` origin so the
    // clock stays continuous across workers; everything else counts from the
    // current session origin.
    const origin =
      buildActive && state.buildStartedAt != null ? state.buildStartedAt : state.sessionStartedAt;
    wallClockSeconds = Math.max(0, (now - origin) / 1000);
  }

  const progress =
    state.progress && state.progress.total > 0
      ? {
          total: state.progress.total,
          done: state.progress.done,
          percent: Math.min(
            100,
            Math.max(0, Math.round((state.progress.done / state.progress.total) * 100)),
          ),
        }
      : null;

  return {
    generatedAt: new Date().toISOString(),
    counts: { running: state.running.size, retrying: state.retryAttempts.size },
    running,
    retrying,
    workspaceLocked: [...state.workspaceLocked].map(([issueId, entry]) =>
      buildWorkspaceLockedSnapshot(issueId, entry),
    ),
    codexTotals: {
      inputTokens: state.totalTokens.input,
      outputTokens: state.totalTokens.output,
      totalTokens: state.totalTokens.input + state.totalTokens.output,
      secondsRunning: state.secondsRunning + activeSeconds,
      wallClockSeconds,
    },
    progress,
    terminalBuildOutcome: state.terminalBuildOutcome,
    rateLimits: Object.keys(state.rateLimits).length ? { ...state.rateLimits } : null,
  };
}

export function buildIssueSnapshot(
  state: OrchestratorState,
  identifier: string,
  now: number = performance.now(),
): RunningSessionSnapshot | null {
  for (const entry of state.running.values()) {
    if (entry.identifier === identifier) {
      return buildRunningSnapshot(entry, now);
    }
  }
  return null;
}

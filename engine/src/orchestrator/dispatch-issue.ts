/**
 * `dispatchIssue`: validate an issue is still active, register a RunningEntry,
 * and start its worker. Extracted from `Orchestrator` so the class file stays
 * under the architecture line-count ceiling.
 */

import type { AgentAdapter } from "../agent/types.js";
import type { NormalizedIssue, TrackerAdapter } from "../tracker/types.js";
import { runWorker, type WorkerConfig, type WorkerResult } from "../worker/runner.js";
import { canDispatch, type InodePressureState } from "../workspace/inode-pressure.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { claimForDispatch } from "./claim-gate.js";
import { hasNoLiveWork, liveSessionReason, logDispatchSuppressed } from "./session-guard.js";
import { makeWorkerCallbacks } from "./turn-telemetry.js";
import {
  isBuildActive,
  type OrchestratorCallbacks,
  type OrchestratorConfig,
  type OrchestratorState,
  type RunningEntry,
} from "./types.js";
import { suppressedByWorkspaceLock } from "./workspace-lock-gate.js";

export interface DispatchIssueDeps {
  state: OrchestratorState;
  tracker: TrackerAdapter;
  agent: AgentAdapter;
  workspace: WorkspaceManager;
  config: OrchestratorConfig;
  callbacks: OrchestratorCallbacks;
  // Read as functions, not snapshots: stop()/drain may land during the tracker
  // await, and registering a RunningEntry afterwards would orphan a worker past
  // the drain barrier.
  isStopped: () => boolean;
  isDraining: () => boolean;
  inodePressure: InodePressureState;
  handleWorkerComplete: (
    issueId: string,
    result: WorkerResult,
    attempt: number,
    owner: RunningEntry,
  ) => void;
  handleWorkerError: (
    issueId: string,
    identifier: string,
    error: unknown,
    attempt: number,
    owner: RunningEntry,
  ) => void;
}

/**
 * One live session per issue (FRG-4086): refuse — and log — a dispatch for an
 * issue that is still running, claimed, or waiting for a killed worker to exit.
 */
function suppressedByLiveSession(
  deps: DispatchIssueDeps,
  issue: NormalizedIssue,
  attempt: number,
): boolean {
  const reason = liveSessionReason(deps.state, issue.id);
  if (!reason) return false;
  logDispatchSuppressed(deps.config.logger, {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt,
    reason,
  });
  return true;
}

export async function dispatchIssue(
  deps: DispatchIssueDeps,
  issue: NormalizedIssue,
  attempt = 1,
): Promise<void> {
  if (deps.isStopped() || deps.isDraining()) return;
  if (suppressedByLiveSession(deps, issue, attempt)) return;
  // No worker may run on this box (FRG-2928) — refuse before the claim, so the
  // ticket keeps its tracker state and builds once the hold lifts on reboot.
  const hold = deps.config.dispatchHold;
  if (hold) {
    if (!deps.state.dispatchHoldLogged.has(issue.id)) {
      deps.state.dispatchHoldLogged.add(issue.id);
      deps.config.logger?.warn(
        { issueId: issue.id, identifier: issue.identifier, reason: hold.reason },
        "Dispatch held — build worker has no key it may spend",
      );
    }
    return;
  }
  const workspaceRoot = deps.workspace.config?.root;
  if (workspaceRoot) {
    const dispatchAllowed = await canDispatch(
      { workspaceRoot, logger: deps.config.logger },
      deps.inodePressure,
    );
    if (!dispatchAllowed) return;
    if (await suppressedByWorkspaceLock(deps, issue)) return;
  }
  try {
    const states = await deps.tracker.fetchIssueStatesByIds([issue.id]);
    const currentState = states.get(issue.id);
    if (
      currentState !== undefined &&
      !deps.config.trackerConfig.active_states.includes(currentState)
    ) {
      return;
    }
  } catch {
    // Re-validation failed; proceed with dispatch (fail-open)
  }
  // Re-check after the await: stop() may have landed during the tracker
  // call, in which case registering a new RunningEntry would orphan a
  // worker past the drain barrier.
  if (deps.isStopped() || deps.isDraining()) return;

  // Make the claim visible in the tracker before any work starts (FRG-1988).
  // No-op with the master `custom_workflows` flag off.
  const claim = await claimForDispatch(deps.tracker, deps.config, issue);
  if (!claim.dispatch) return;
  if (deps.isStopped() || deps.isDraining()) return;
  // Re-check synchronously before claiming: a concurrent retry or poll may
  // have registered this issue while the tracker calls above were in flight.
  if (suppressedByLiveSession(deps, issue, attempt)) return;

  deps.state.claimed.add(issue.id);
  deps.callbacks.onDispatch?.(issue);

  const abortController = new AbortController();
  const workerConfig: WorkerConfig = {
    maxTurns: deps.config.maxTurns,
    turnTimeoutMs: deps.config.turnTimeoutMs,
    readTimeoutMs: deps.config.readTimeoutMs,
    helperWaitMs: deps.config.helperWaitMs,
    approvalPolicy: deps.config.approvalPolicy,
    promptTemplate: deps.config.promptTemplate,
    trackerConfig: deps.config.trackerConfig,
    mcpServers: deps.config.mcpServers,
    skillsManifest: deps.config.skillsManifest,
    attempt,
    logger: deps.config.logger,
  };

  // Register entry BEFORE starting worker so onEvent can find it immediately
  const now = performance.now();
  const entry: RunningEntry = {
    issueId: issue.id,
    identifier: issue.identifier,
    issue,
    startedAt: now,
    wallClockStartedAtMs: Date.now(),
    lastActivityAt: now,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    workspacePath: null,
    attempt,
    abortController,
    workerPromise: Promise.resolve(), // placeholder until worker starts
    sessionId: null,
    turnCount: 0,
    lastEvent: "",
    lastMessage: "",
    host: null,
    turnTimings: [],
  };
  // While the tracker-reported build stays active we keep one continuous
  // Runtime clock for the whole build, even if individual workers finish and
  // the anvil momentarily goes idle between polls.
  const buildActive = isBuildActive(deps.state.progress);

  // Open a fresh build clock on the first dispatch of a new active build.
  // This clock is held steady until the build finishes, so the Anvil Runtime
  // for a multi-ticket Forge build (e.g. the initial build) does not restart
  // every time an individual worker completes.
  if (buildActive && deps.state.buildStartedAt == null) {
    deps.state.buildStartedAt = now;
  }

  // Session-boundary reset: when the anvil is fully idle (nothing running and
  // nothing pending retry) and the tracker-reported build is complete or not
  // yet known, this dispatch opens a new active session, so start the Runtime
  // clock here. Held untouched while work is already in-flight or retrying,
  // so a new Smith feature gets its own clock. Captured before the set below
  // so the first dispatch of a fresh session wins.
  const openingNewSession = !buildActive && hasNoLiveWork(deps.state);
  deps.state.running.set(issue.id, entry);
  deps.state.claimed.delete(issue.id);
  if (openingNewSession) {
    deps.state.sessionStartedAt = now;
    deps.state.buildStartedAt = undefined;
  }

  // Fire-and-forget telemetry start. Mirrors onTicketComplete: must never
  // throw — the callback owns its own error handling.
  try {
    deps.callbacks.onTicketStart?.(issue.id, {
      identifier: issue.identifier,
      ticketTitle: issue.title,
      attempt,
      startedAtMs: entry.wallClockStartedAtMs,
    });
  } catch {
    // Defensive: orchestrator must never wedge on a telemetry-start hook.
  }

  entry.workerPromise = runWorker(
    issue,
    workerConfig,
    deps.agent,
    deps.tracker,
    deps.workspace,
    makeWorkerCallbacks(deps.state, deps.callbacks, abortController.signal),
  )
    .then((result) => {
      deps.handleWorkerComplete(issue.id, result, attempt, entry);
    })
    .catch((error) => {
      deps.handleWorkerError(issue.id, issue.identifier, error, attempt, entry);
    });
}

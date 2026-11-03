/**
 * Workspace dispatch-lock gate (FRG-4527) and the reap of locks held only by
 * a dead orchestrator's surviving agent processes (FRG-5429): refuses
 * dispatch into a held workspace, tracks the refusals the state snapshot
 * lists, and schedules the reap.
 */

import type { Logger } from "pino";
import type { NormalizedIssue } from "../tracker/types.js";
import {
  type LiveLockHolder,
  lockHolderLogFields,
  WORKSPACE_LOCK_HELD,
} from "../workspace/lock.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { ORPHAN_REAP_AFTER_MS, reapOrphanedLock } from "../workspace/orphan-reaper.js";
import type { OrchestratorState } from "./types.js";

export interface WorkspaceLockGateDeps {
  state: OrchestratorState;
  workspace: WorkspaceManager;
  config: { logger?: Logger };
  isStopped: () => boolean;
  isDraining: () => boolean;
}

/** Whether the reap may act on `found`: orphaned, with marked processes to signal. */
const reapable = (found: LiveLockHolder) => found.orphaned && found.markedPids.length > 0;

/**
 * Record `found` as the live holder of `issue`'s workspace lock. A new holder
 * is logged once; for the same holder only its marked pids and orphan status
 * are refreshed, keeping when it was first seen (orphaned).
 */
function trackHolder(deps: WorkspaceLockGateDeps, issue: NormalizedIssue, found: LiveLockHolder) {
  const { holder, orphaned, markedPids } = found;
  const holderKey = `${holder.token}@${holder.startedAt}`;
  const now = performance.now();
  const entry = deps.state.workspaceLocked.get(issue.id);
  if (entry?.holderKey === holderKey) {
    entry.holderAgentPid = holder.agentPid;
    entry.markedPids = markedPids;
    entry.orphaned = orphaned;
    entry.orphanedSinceMs = reapable(found) ? (entry.orphanedSinceMs ?? now) : null;
    return;
  }
  deps.state.workspaceLocked.set(issue.id, {
    identifier: issue.identifier,
    holderKey,
    holderPid: holder.pid,
    holderAgentPid: holder.agentPid,
    holderStartedAt: holder.startedAt,
    markedPids,
    orphaned,
    sinceMs: Date.now(),
    orphanedSinceMs: reapable(found) ? now : null,
    reaping: false,
  });
  deps.config.logger?.warn(
    {
      issueId: issue.id,
      identifier: issue.identifier,
      orphaned,
      ...lockHolderLogFields(holder, markedPids),
    },
    WORKSPACE_LOCK_HELD,
  );
}

/**
 * FRG-4527: refuse an issue whose workspace dispatch lock is held by another
 * live process (a second orchestrator, or a previous one's surviving agent
 * tree) before the claim, so the refusal costs no retry, QA attempt, or
 * failure telemetry. Logged once per holder; the dispatcher ranks the issue
 * last until {@link refreshWorkspaceLocks} sees the lock freed, so it cannot
 * starve the rest. The worker's own lock acquisition stays authoritative.
 */
export async function suppressedByWorkspaceLock(
  deps: WorkspaceLockGateDeps,
  issue: NormalizedIssue,
): Promise<boolean> {
  // A reap in flight may be about to SIGKILL marked processes: a new agent in
  // the workspace would carry the same marker.
  if (deps.state.workspaceLocked.get(issue.id)?.reaping) return true;
  // An invalid path is the worker's to report; let the dispatch proceed.
  const found = await deps.workspace.lockHolder(issue).catch(() => null);
  if (!found) {
    deps.state.workspaceLocked.delete(issue.id);
    return false;
  }
  trackHolder(deps, issue, found);
  return true;
}

/**
 * FRG-5429: once a lock has been orphan-held by marked processes for
 * {@link ORPHAN_REAP_AFTER_MS}, reap them and reclaim the lock in the background, one
 * reap per issue at a time. A reap that leaves the lock held restarts the
 * grace period, so it is retried at most once per period. A lock kept live
 * only by the agent's process group has nothing the reap may signal.
 */
function maybeReap(deps: WorkspaceLockGateDeps, issueId: string, workspacePath: string): void {
  const entry = deps.state.workspaceLocked.get(issueId);
  if (!entry || entry.reaping || entry.orphanedSinceMs === null) return;
  if (deps.isStopped() || deps.isDraining()) return;
  if (performance.now() - entry.orphanedSinceMs < ORPHAN_REAP_AFTER_MS) return;
  entry.reaping = true;
  const { logger } = deps.config;
  void reapOrphanedLock(workspacePath, { logger })
    .catch((err: unknown) =>
      logger?.warn(
        { issueId, identifier: entry.identifier, err },
        "Reap of orphaned workspace lock failed",
      ),
    )
    .finally(() => {
      entry.reaping = false;
      entry.orphanedSinceMs = performance.now();
    });
}

/**
 * Start-of-tick re-check of the issues ranked last for a held workspace lock:
 * drop those that left the candidates or whose lock has been freed, so a freed
 * issue regains its priority rank even while a backlog fills every slot; and
 * reap locks that only a dead orchestrator's agent processes still hold.
 */
export async function refreshWorkspaceLocks(
  deps: WorkspaceLockGateDeps,
  candidates: NormalizedIssue[],
): Promise<void> {
  const { workspaceLocked } = deps.state;
  if (workspaceLocked.size === 0) return;
  const byId = new Map(candidates.map((issue) => [issue.id, issue]));
  for (const id of [...workspaceLocked.keys()]) {
    const issue = byId.get(id);
    const found = issue && (await deps.workspace.lockHolder(issue).catch(() => null));
    if (!issue || !found) {
      workspaceLocked.delete(id);
      continue;
    }
    trackHolder(deps, issue, found);
    maybeReap(deps, id, found.workspacePath);
  }
}

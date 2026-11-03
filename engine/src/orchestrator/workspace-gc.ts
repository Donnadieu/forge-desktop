/**
 * Auto-GC helpers for the orchestrator poll loop. Extracted from
 * `orchestrator.ts` so the class file stays under the 400-line architecture
 * cap and so the terminal-transition logic can be unit-tested without
 * spinning up a full orchestrator. See FRG-1547 for the incident (inode
 * exhaustion on a deployed box because stale per-ticket `node_modules` trees
 * were never reaped).
 *
 * `toRetry` is intentionally excluded — the retry reuses the worktree.
 */
import type { Logger } from "pino";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { ReconcileResult } from "./reconciler.js";
import type { OrchestratorConfig, OrchestratorState } from "./types.js";

/**
 * Read `workspacePath` from each still-live `RunningEntry`. Returns `[]` when
 * `cleanupCompletedWorkspaces` is disabled so callers trivially short-circuit.
 */
export function snapshotWorkspacePathsForCleanup(
  state: OrchestratorState,
  config: OrchestratorConfig,
  issueIds: string[],
): string[] {
  if (!config.cleanupCompletedWorkspaces) return [];
  const paths: string[] = [];
  for (const issueId of issueIds) {
    const entry = state.running.get(issueId);
    if (entry?.workspacePath && !state.preserveWorkspacePaths.has(entry.workspacePath)) {
      paths.push(entry.workspacePath);
    }
  }
  return paths;
}

/**
 * Delegate to `WorkspaceManager.cleanupCompletedWorkspace` for each path.
 * Sequential (not parallel) to bound rmSync CPU on inode-heavy `node_modules`
 * trees; errors are logged and swallowed so a cleanup failure never wedges
 * the poll loop.
 */
export async function runWorkspaceCleanup(
  workspace: WorkspaceManager,
  logger: Logger | undefined,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  for (const path of paths) {
    try {
      const result = await workspace.cleanupCompletedWorkspace(path);
      if (result.removed) {
        logger?.info({ path }, "auto-GC removed workspace");
      } else if (result.reason !== "workspace already absent") {
        logger?.debug(
          { path, reason: result.reason, errors: result.errors },
          "auto-GC skipped workspace",
        );
      }
    } catch (err) {
      logger?.warn(
        { path, err: err instanceof Error ? err.message : String(err) },
        "auto-GC threw (swallowed)",
      );
    }
  }
}

/**
 * Callbacks the orchestrator hands in so this helper can drive settlement
 * without importing the class. Keeps `workspace-gc.ts` a leaf module and
 * makes the whole terminal-transition path testable in isolation.
 */
export interface TerminalTransitionCallbacks {
  onComplete: (issueId: string) => void;
  onKill: (issueId: string) => void;
  onRetry: (issueId: string) => void;
  onReconcile?: (killed: string[], retried: string[]) => void;
}

/**
 * Drive one poll cycle's terminal transitions:
 *   1. Snapshot workspace paths for `toComplete ∪ toKill` BEFORE settling
 *      (settle callbacks remove the RunningEntry from `state.running`).
 *   2. Fire settle callbacks in order: complete → kill → retry.
 *   3. Invoke `onReconcile(killed, retried)` if provided.
 *   4. Fire-and-forget cleanup for the snapshotted paths, once every killed
 *      worker among the targets has exited (FRG-4086): a worker still in
 *      `settling` may be running its `after_run` hook in that workspace.
 *
 * Fire-and-forget on the cleanup is deliberate: rmSync over a `node_modules`
 * tree can take seconds, and blocking the poll loop on it would delay
 * dispatch. Errors inside cleanup are swallowed by {@link runWorkspaceCleanup}.
 */
export function handleTerminalTransitions(
  state: OrchestratorState,
  config: OrchestratorConfig,
  workspace: WorkspaceManager,
  reconcileResult: ReconcileResult,
  callbacks: TerminalTransitionCallbacks,
): void {
  const gcTargets = [...reconcileResult.toComplete, ...reconcileResult.toKill];
  const cleanupPaths = snapshotWorkspacePathsForCleanup(state, config, gcTargets);
  for (const issueId of reconcileResult.toComplete) callbacks.onComplete(issueId);
  for (const issueId of reconcileResult.toKill) callbacks.onKill(issueId);
  for (const issueId of reconcileResult.toRetry) callbacks.onRetry(issueId);
  callbacks.onReconcile?.(reconcileResult.toKill, reconcileResult.toRetry);
  const exiting = gcTargets.flatMap((id) => state.settling.get(id)?.exited ?? []);
  void Promise.all(exiting).then(() => runWorkspaceCleanup(workspace, config.logger, cleanupPaths));
}

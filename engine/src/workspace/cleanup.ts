/**
 * Auto-GC helper for WorkspaceManager — extracted so `manager.ts` stays
 * under the 400-line architecture cap. See FRG-1547.
 *
 * `WorkspaceManager.cleanupCompletedWorkspace` is a thin wrapper that binds
 * its instance-scoped `validatePath` and `runHook` into the callbacks below.
 */
import { existsSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { acquireWorkspaceLock } from "./lock.js";

export interface CleanupWorkspaceHooks {
  /** Throws on invalid path (traversal, symlink escape, root-equality). */
  validatePath: (workspacePath: string) => Promise<void>;
  /** Runs the configured `before_remove` hook; caller-provided when non-null. */
  runBeforeRemoveHook: ((workspacePath: string) => Promise<void>) | null;
}

export interface CleanupWorkspaceResult {
  removed: boolean;
  reason: string;
  errors: string[];
}

/**
 * Delete a workspace directory whose ticket has reached a terminal state
 * (Done / Cancelled / Closed) — the reason auto-GC exists. Unlike the legacy
 * `removeWorkspace` no-op, this DOES delete the directory, but only under
 * conditions that make it safe to do so:
 *
 *   - Path must resolve under the workspace root (no traversal / symlink
 *     escape). Enforced by the caller-supplied `validatePath` hook.
 *   - The `.forge-ready` marker must exist AND be at least `minAgeMs` old
 *     (default 60_000). Freshly-created workspaces are protected from a
 *     pathological "create and immediately terminal" race.
 *   - No live process holds the workspace's dispatch lock (FRG-4527): an
 *     agent tree that outlived its orchestrator may still be running there.
 *     Cleanup takes the lock itself and holds it while deleting, so a
 *     dispatch cannot start in the workspace mid-removal.
 *   - `before_remove` hook, if provided, is invoked first. Its failure is
 *     recorded but not fatal — cleanup must never wedge the poll loop.
 *
 * Errors are swallowed to `errors[]` on the return value; the poll loop
 * treats them as advisory.
 *
 * See FRG-1547: `/data` inode exhaustion on a deployed box because 22 stale
 * per-ticket `node_modules` trees were never reaped after their tickets
 * moved Done/Cancelled/Merged.
 */
export async function cleanupCompletedWorkspaceImpl(
  workspacePath: string,
  hooks: CleanupWorkspaceHooks,
  options: { minAgeMs?: number } = {},
): Promise<CleanupWorkspaceResult> {
  const errors: string[] = [];
  const minAgeMs = options.minAgeMs ?? 60_000;

  // Path validation FIRST — a traversal attempt must be refused before we
  // even stat anything. validatePath throws on escape / root-equality; the
  // caller sees `removed:false` with the reason recorded.
  try {
    await hooks.validatePath(workspacePath);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { removed: false, reason: `invalid path: ${msg}`, errors };
  }

  if (!existsSync(workspacePath)) {
    return { removed: false, reason: "workspace already absent", errors };
  }

  // Age guard: refuse to nuke a workspace whose ready marker is too fresh.
  // If the marker is missing entirely, the workspace was never fully
  // initialized — safe to remove (matches the ensureWorkspace recovery paths
  // that treat a missing marker as broken partial state).
  const readyMarker = join(workspacePath, ".forge-ready");
  if (existsSync(readyMarker)) {
    try {
      const ageMs = Date.now() - lstatSync(readyMarker).mtimeMs;
      if (ageMs < minAgeMs) {
        return {
          removed: false,
          reason: `too fresh (age ${Math.floor(ageMs)}ms < ${minAgeMs}ms)`,
          errors,
        };
      }
    } catch (error) {
      // Stat failure on the marker is odd but not a reason to abort the
      // deletion — record and proceed.
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`marker stat failed: ${msg}`);
    }
  }

  let locked: Awaited<ReturnType<typeof acquireWorkspaceLock>>;
  try {
    locked = await acquireWorkspaceLock(workspacePath);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { removed: false, reason: `lock failed: ${msg}`, errors: [...errors, msg] };
  }
  if (!locked.acquired) {
    return { removed: false, reason: `locked by live pid ${locked.holder.pid}`, errors };
  }
  try {
    if (hooks.runBeforeRemoveHook) {
      try {
        await hooks.runBeforeRemoveHook(workspacePath);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`before_remove hook: ${msg}`);
      }
    }

    try {
      rmSync(workspacePath, { recursive: true, force: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { removed: false, reason: `rm failed: ${msg}`, errors: [...errors, msg] };
    }

    return { removed: true, reason: "ok", errors };
  } finally {
    await locked.lock.release();
  }
}

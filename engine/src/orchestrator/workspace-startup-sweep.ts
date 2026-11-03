/**
 * Startup workspace sweep for FRG-1886. Before the first dispatch, reap
 * per-ticket workspaces that were left behind by prior process lifetimes and
 * that the ordinary auto-GC (which only fires on terminal transitions) never
 * had a chance to clean. This prevents `/data` inode exhaustion when heavy
 * `node_modules` trees accumulate faster than tickets reach terminal states.
 *
 * A workspace is eligible for removal when ALL of the following hold:
 *   - It sits under the configured workspace root.
 *   - Its `.forge-ready` marker exists and is at least 24 hours old.
 *   - The tracker reports no active issue with a matching identifier.
 *   - No process currently has the workspace open (`fuser -s`).
 *
 * Deletion is delegated to `WorkspaceManager.cleanupCompletedWorkspace` so the
 * configured `before_remove` hook and path validation still run. Errors for
 * individual workspaces are logged and swallowed; the sweep never blocks
 * startup.
 */
import { execFile } from "node:child_process";
import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { TrackerAdapter, TrackerConfig } from "../tracker/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";

const execFileAsync = promisify(execFile);

export interface StartupSweepDeps {
  workspaceRoot: string;
  tracker: TrackerAdapter;
  trackerConfig: TrackerConfig;
  workspace: WorkspaceManager;
  logger: Logger | undefined;
  nowMs?: number;
  hasOpenHandles?: (path: string) => Promise<boolean>;
  estimateInodeCount?: (path: string) => Promise<number>;
}

export interface StartupSweepResult {
  scanned: number;
  removed: number;
  skipped: number;
  inodesFreed: number;
}

const STALE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * List immediate subdirectories of `workspaceRoot`. Returns an empty array if
 * the root does not exist or is unreachable.
 */
async function listWorkspaceDirectories(workspaceRoot: string): Promise<string[]> {
  const directories: string[] = [];
  try {
    const dir = await opendir(workspaceRoot);
    for await (const entry of dir) {
      if (entry.isDirectory()) {
        directories.push(join(workspaceRoot, entry.name));
      }
    }
  } catch {
    // Root missing or unreadable — nothing to sweep.
  }
  return directories;
}

/**
 * Build a set of identifiers for issues the tracker considers active. Uses
 * `fetchCandidates` because that is the orchestrator's definition of "active
 * issues in the project".
 */
async function fetchActiveIssueIdentifiers(
  tracker: TrackerAdapter,
  trackerConfig: TrackerConfig,
): Promise<Set<string> | null> {
  try {
    const active = await tracker.fetchCandidates(trackerConfig);
    return new Set(active.map((issue) => issue.identifier));
  } catch {
    // If we cannot determine which issues are active, sweep nothing. Deleting
    // an in-use workspace is far worse than leaving a stale one behind.
    return null;
  }
}

/**
 * Resolve the workspace path's issue identifier. The directory name is the
 * sanitized issue identifier produced by `WorkspaceManager.toSafeId`; for
 * typical Linear identifiers this is a lossless round-trip.
 */
function identifierFromPath(workspacePath: string): string {
  return workspacePath.split("/").pop() ?? workspacePath;
}

/**
 * True if the workspace's `.forge-ready` marker exists and is at least
 * `STALE_AGE_MS` old.
 */
async function isStaleWorkspace(workspacePath: string, nowMs: number): Promise<boolean> {
  const markerPath = join(workspacePath, ".forge-ready");
  try {
    const stats = await stat(markerPath);
    return nowMs - stats.mtimeMs >= STALE_AGE_MS;
  } catch {
    // Missing or unreadable marker — the workspace was never fully initialized
    // or is already being touched; do not sweep it here.
    return false;
  }
}

/**
 * Default open-handle check. `fuser -s <path>` exits 0 when at least one
 * process has the path open and 1 when no process has it open. Any other exit
 * code is treated as "has handles" to be safe.
 */
async function defaultHasOpenHandles(path: string): Promise<boolean> {
  try {
    await execFileAsync("fuser", ["-s", path], { timeout: 5000 });
    return true;
  } catch (err) {
    // Exit code 1 means no process is using the path.
    if (err instanceof Error && "code" in err && err.code === 1) {
      return false;
    }
    // Any other error (command missing, permission denied, timeout) is treated
    // conservatively: assume the workspace is in use.
    return true;
  }
}

/**
 * Approximate inode count for a directory tree. Counts every directory entry
 * (file, directory, symlink) as one inode. This is intentionally approximate:
 * hard links share inodes and directories consume extra blocks, but the goal
 * is a coarse "inodes freed" metric for the sweep summary.
 */
async function defaultEstimateInodeCount(path: string): Promise<number> {
  let count = 0;
  async function walk(dirPath: string): Promise<void> {
    const dir = await opendir(dirPath);
    for await (const entry of dir) {
      count++;
      if (entry.isDirectory()) {
        await walk(join(dirPath, entry.name));
      }
    }
  }
  try {
    await walk(path);
  } catch {
    // Unreadable portions are omitted from the estimate.
  }
  return count;
}

/**
 * Run the startup sweep. Returns a summary of scanned/removed/skipped
 * workspaces and the approximate inode count freed. All errors are swallowed
 * and logged; the caller can safely fire-and-forget this function.
 */
export async function runWorkspaceStartupSweep(
  deps: StartupSweepDeps,
): Promise<StartupSweepResult> {
  const {
    workspaceRoot,
    tracker,
    trackerConfig,
    workspace,
    logger,
    nowMs = Date.now(),
    hasOpenHandles = defaultHasOpenHandles,
    estimateInodeCount = defaultEstimateInodeCount,
  } = deps;

  const result: StartupSweepResult = {
    scanned: 0,
    removed: 0,
    skipped: 0,
    inodesFreed: 0,
  };

  const directories = await listWorkspaceDirectories(workspaceRoot);
  const activeIdentifiers = await fetchActiveIssueIdentifiers(tracker, trackerConfig);

  if (activeIdentifiers === null) {
    result.scanned = directories.length;
    logger?.warn(
      { workspaceRoot, scanned: result.scanned },
      "startup sweep aborted: could not fetch active issue list",
    );
    return result;
  }

  for (const workspacePath of directories) {
    result.scanned++;
    const identifier = identifierFromPath(workspacePath);

    if (activeIdentifiers.has(identifier)) {
      result.skipped++;
      logger?.debug({ workspacePath, identifier }, "startup sweep skipped: issue is active");
      continue;
    }

    if (!(await isStaleWorkspace(workspacePath, nowMs))) {
      result.skipped++;
      logger?.debug(
        { workspacePath, identifier },
        "startup sweep skipped: workspace is not stale (marker < 24h)",
      );
      continue;
    }

    if (await hasOpenHandles(workspacePath)) {
      result.skipped++;
      logger?.warn(
        { workspacePath, identifier },
        "startup sweep skipped: workspace has open file handles",
      );
      continue;
    }

    try {
      const inodes = await estimateInodeCount(workspacePath);
      const cleanup = await workspace.cleanupCompletedWorkspace(workspacePath, { minAgeMs: 0 });
      if (cleanup.removed) {
        result.removed++;
        result.inodesFreed += inodes;
        logger?.info(
          { workspacePath, identifier, approximateInodesFreed: inodes },
          "startup sweep removed stale workspace",
        );
      } else {
        result.skipped++;
        logger?.debug(
          { workspacePath, identifier, reason: cleanup.reason },
          "startup sweep skipped: cleanup refused",
        );
      }
    } catch (err) {
      result.skipped++;
      logger?.warn(
        {
          workspacePath,
          identifier,
          err: err instanceof Error ? err.message : String(err),
        },
        "startup sweep failed to remove workspace (swallowed)",
      );
    }
  }

  logger?.info(
    {
      workspaceRoot,
      scanned: result.scanned,
      removed: result.removed,
      skipped: result.skipped,
      approximateInodesFreed: result.inodesFreed,
    },
    "workspace startup sweep complete (FRG-1886)",
  );

  return result;
}

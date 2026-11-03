/**
 * Inode / byte pressure watchdog for the workspace filesystem — extracted
 * from the orchestrator poll loop so `orchestrator.ts` stays under the
 * 400-line architecture cap. FRG-1547.
 *
 * On each poll we `statfs()` the workspace root and emit a warn-level log
 * when either free inodes or free bytes drop below a configurable threshold
 * (default 15%). This is the same class of failure that took a deployed
 * box down: `/data` hit 100% inode usage while byte usage was only 73%, so
 * `df -h` looked fine and Smith received cryptic ENOSPC errors from
 * `.forge-ready` writes.
 *
 * Log lines are memoized per warn/clear transition so a persistently full
 * disk emits ONE warning per crossing, not one per 10s poll.
 */
import { statfs } from "node:fs/promises";
import type { Logger } from "pino";

export interface InodePressureConfig {
  /** Absolute path to the workspace filesystem to monitor. */
  workspaceRoot: string;
  /** Warn when free inodes or free bytes drop below this ratio (0..1). */
  warnRatio?: number;
  logger: Logger | undefined;
}

/**
 * Mutable memo of the last emitted state so we log on transitions, not
 * every tick. `pressed:true` means we're currently below the watchdog
 * threshold; `dispatchBlocked:true` means the dispatch gate has already
 * warned for the current low-space episode.
 */
export interface InodePressureState {
  pressed: boolean;
  dispatchBlocked: boolean;
}

export function createInodePressureState(): InodePressureState {
  return { pressed: false, dispatchBlocked: false };
}

/**
 * Run one poll's-worth of inode-pressure check. Fire-and-forget from the
 * caller — errors are swallowed so a broken statfs never wedges dispatch.
 */
export async function checkInodePressure(
  cfg: InodePressureConfig,
  state: InodePressureState,
): Promise<void> {
  const warnRatio = cfg.warnRatio ?? 0.15;
  try {
    const stats = await statfs(cfg.workspaceRoot);
    const totalInodes = Number(stats.files);
    const freeInodes = Number(stats.ffree);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bfree) * Number(stats.bsize);

    // Guard against a filesystem that reports 0 total inodes/bytes (some
    // virtual FS). Treat as "not under pressure" and move on.
    const inodeRatio = totalInodes > 0 ? freeInodes / totalInodes : 1;
    const byteRatio = totalBytes > 0 ? freeBytes / totalBytes : 1;
    const pressed = inodeRatio < warnRatio || byteRatio < warnRatio;

    if (pressed && !state.pressed) {
      cfg.logger?.warn(
        {
          path: cfg.workspaceRoot,
          freeInodePct: Math.round(inodeRatio * 100),
          freeBytePct: Math.round(byteRatio * 100),
          totalInodes,
          freeInodes,
          totalBytes,
          freeBytes,
        },
        "workspace filesystem is under inode/byte pressure (FRG-1547)",
      );
      state.pressed = true;
    } else if (!pressed && state.pressed) {
      cfg.logger?.info(
        {
          path: cfg.workspaceRoot,
          freeInodePct: Math.round(inodeRatio * 100),
          freeBytePct: Math.round(byteRatio * 100),
        },
        "workspace filesystem pressure cleared",
      );
      state.pressed = false;
    }
  } catch (err) {
    // Bad path, permission denied, unsupported FS — don't spam the log
    // every poll. Warn once and give up until the next process restart by
    // marking pressed=false (so the "clear" branch stays quiet too).
    cfg.logger?.debug(
      { path: cfg.workspaceRoot, err: err instanceof Error ? err.message : String(err) },
      "inode-pressure statfs failed (swallowed)",
    );
  }
}

export interface CanDispatchConfig {
  /** Absolute path to the workspace filesystem to check. */
  workspaceRoot: string;
  /** Block dispatch when free inodes or free bytes drop below this ratio (0..1). */
  dispatchRatio?: number;
  logger: Logger | undefined;
}

/**
 * Dispatch gate for FRG-1886. Returns false when the workspace filesystem has
 * fewer than `dispatchRatio` (default 10%) free inodes or free bytes, and logs
 * a clear warning. Uses the shared `InodePressureState` so the warning is
 * emitted once per low-space episode rather than once per candidate.
 *
 * Fail-open: if statfs throws, allow dispatch and avoid wedging the queue.
 */
export async function canDispatch(
  cfg: CanDispatchConfig,
  state: InodePressureState,
): Promise<boolean> {
  const dispatchRatio = cfg.dispatchRatio ?? 0.1;
  try {
    const stats = await statfs(cfg.workspaceRoot);
    const totalInodes = Number(stats.files);
    const freeInodes = Number(stats.ffree);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bfree) * Number(stats.bsize);

    const inodeRatio = totalInodes > 0 ? freeInodes / totalInodes : 1;
    const byteRatio = totalBytes > 0 ? freeBytes / totalBytes : 1;
    const blocked = inodeRatio < dispatchRatio || byteRatio < dispatchRatio;

    if (blocked) {
      if (!state.dispatchBlocked) {
        cfg.logger?.warn(
          {
            path: cfg.workspaceRoot,
            freeInodePct: Math.round(inodeRatio * 100),
            freeBytePct: Math.round(byteRatio * 100),
            totalInodes,
            freeInodes,
            totalBytes,
            freeBytes,
          },
          "dispatch blocked: workspace filesystem free inodes/bytes below threshold (FRG-1886)",
        );
        state.dispatchBlocked = true;
      }
      return false;
    }

    // Pressure cleared — reset the dispatch-block latch so the next episode
    // warns again.
    state.dispatchBlocked = false;
    return true;
  } catch (err) {
    cfg.logger?.warn(
      { path: cfg.workspaceRoot, err: err instanceof Error ? err.message : String(err) },
      "dispatch gate statfs failed; allowing dispatch to avoid wedging queue",
    );
    return true;
  }
}

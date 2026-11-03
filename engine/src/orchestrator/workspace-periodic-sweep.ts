/**
 * Periodic + pressure-triggered workspace sweep (FRG-1886 follow-up).
 *
 * The terminal-transition auto-GC (`workspace-gc.ts`) only fires while a
 * worker is still running when its ticket reaches a terminal state, and the
 * startup sweep only runs once per process. A ticket that goes Done after its
 * worker exited (e.g. merged later by a human) therefore leaks its workspace
 * until the next restart. On a long-lived orchestrator those leaks accumulate
 * until the FRG-1886 dispatch gate blocks all dispatch — and nothing frees
 * space, so the queue stays wedged indefinitely.
 *
 * This sweeper runs from the poll loop and removes a workspace only when ALL
 * of the following hold:
 *   - Its directory name matches an issue the tracker reports in a terminal
 *     state (Done / Closed / Cancelled / ...). Active, Todo, review and
 *     merging tickets are never touched.
 *   - The issue is not running or queued for retry in this orchestrator.
 *   - Its path is not in `preserveWorkspacePaths` (known-issues evidence).
 *   - No process has the workspace open (`fuser -s`).
 *
 * Parked tickets (FRG-5471): a workspace whose ticket sits in a parked state
 * (default `Backlog`) is also removed, but only when its git checkout holds
 * nothing that would be lost: no uncommitted changes outside Forge scratch
 * dirs and no commits that are not on a remote branch. Triage creates a
 * workspace for every ticket it spikes and then parks the ticket in Backlog,
 * so without this those ~300MB checkouts accumulate until the dispatch gate
 * wedges the queue (forjado-hq 2026-10-01: 16 Backlog workspaces, /data 96%).
 * A ticket that comes back out of Backlog simply gets a fresh workspace.
 *
 * Deletion goes through `WorkspaceManager.cleanupCompletedWorkspace` so path
 * validation, the `before_remove` hook and the 60s ready-marker guard apply.
 *
 * Triggers:
 *   - Periodic, every `intervalMs` — only when `cleanupCompletedWorkspaces`
 *     is on (multi-tenant boxes keep failed-build workspaces for post-mortem).
 *   - Under disk pressure, at most every `pressureCooldownMs` — ALWAYS on.
 *     A full disk blocks every dispatch, so reaping finished tickets beats
 *     preserving them.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { TrackerAdapter, TrackerConfig } from "../tracker/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { OrchestratorState } from "./types.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
export const DEFAULT_PRESSURE_COOLDOWN_MS = 5 * 60 * 1000;
/** Non-active, non-terminal states whose clean workspaces may be reclaimed. */
export const DEFAULT_PARKED_STATES: readonly string[] = ["Backlog"];

export interface TerminalSweepDeps {
  workspaceRoot: string;
  tracker: TrackerAdapter;
  trackerConfig: TrackerConfig;
  workspace: WorkspaceManager;
  state: OrchestratorState;
  logger: Logger | undefined;
  reason: "periodic" | "pressure";
  hasOpenHandles?: (path: string) => Promise<boolean>;
  /** States treated as parked (default `DEFAULT_PARKED_STATES`); `[]` disables. */
  parkedStates?: readonly string[];
  /** True when the checkout holds no unsaved work (default: git status + unpushed commits). */
  isDisposableCheckout?: (path: string) => Promise<boolean>;
}

export interface TerminalSweepResult {
  scanned: number;
  removed: number;
  skipped: number;
}

async function listWorkspaceDirectories(workspaceRoot: string): Promise<string[]> {
  const directories: string[] = [];
  try {
    const dir = await opendir(workspaceRoot);
    for await (const entry of dir) {
      if (entry.isDirectory()) directories.push(entry.name);
    }
  } catch {
    // Root missing or unreadable — nothing to sweep.
  }
  return directories;
}

/** `fuser -s` exits 0 when the path is open, 1 when not; anything else = assume open. */
async function defaultHasOpenHandles(path: string): Promise<boolean> {
  try {
    await execFileAsync("fuser", ["-s", path], { timeout: 5000 });
    return true;
  } catch (err) {
    return !(err instanceof Error && "code" in err && err.code === 1);
  }
}

/** Forge scratch paths that never count as unsaved work. */
const SCRATCH_PREFIXES = [".forge/", ".forge-ready", ".context/"];

/**
 * A checkout is disposable only when git positively confirms it has no
 * uncommitted changes (outside Forge scratch) and no commits missing from
 * every remote branch. Any git failure (not a repo, corrupt, timeout) means
 * "keep it". A directory without its own `.git` is never a checkout, even when
 * git would resolve an enclosing repository above the workspace root.
 */
async function defaultIsDisposableCheckout(path: string): Promise<boolean> {
  if (!existsSync(join(path, ".git"))) return false;
  try {
    const { stdout: status } = await execFileAsync(
      "git",
      ["-C", path, "status", "--porcelain", "--untracked-files=all"],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const dirty = status
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((file) => file && !SCRATCH_PREFIXES.some((prefix) => file.startsWith(prefix)));
    if (dirty.length > 0) return false;
    const { stdout: unpushed } = await execFileAsync(
      "git",
      ["-C", path, "rev-list", "--count", "HEAD", "--not", "--remotes"],
      { timeout: 30_000 },
    );
    return unpushed.trim() === "0";
  } catch {
    return false;
  }
}

/** Identifiers this orchestrator still owns (running, killed but not exited, or queued for retry). */
function inFlightIdentifiers(state: OrchestratorState): Set<string> {
  const ids = new Set<string>();
  for (const entry of state.running.values()) ids.add(entry.identifier);
  for (const entry of state.settling.values()) ids.add(entry.identifier);
  for (const entry of state.retryAttempts.values()) ids.add(entry.identifier);
  return ids;
}

/**
 * Remove workspaces whose tickets are terminal in the tracker. Never throws:
 * a tracker failure sweeps nothing (deleting a live workspace is far worse
 * than leaving a finished one behind).
 */
export async function runTerminalWorkspaceSweep(
  deps: TerminalSweepDeps,
): Promise<TerminalSweepResult> {
  const { workspaceRoot, tracker, trackerConfig, workspace, state, logger, reason } = deps;
  const hasOpenHandles = deps.hasOpenHandles ?? defaultHasOpenHandles;
  const result: TerminalSweepResult = { scanned: 0, removed: 0, skipped: 0 };

  const directories = await listWorkspaceDirectories(workspaceRoot);
  if (directories.length === 0) return result;

  let terminal: Set<string>;
  try {
    const issues = await tracker.fetchTerminalIssues(trackerConfig);
    terminal = new Set(issues.map((issue) => issue.identifier));
  } catch (err) {
    logger?.warn(
      { reason, err: err instanceof Error ? err.message : String(err) },
      "workspace sweep aborted: could not fetch terminal issues",
    );
    return result;
  }

  // Parked tickets reuse the terminal-issue query with the parked state names.
  // The read swallows tracker errors and returns [], which parks nothing.
  const parkedStates = (deps.parkedStates ?? DEFAULT_PARKED_STATES).filter(
    (s) => !trackerConfig.active_states.includes(s) && !trackerConfig.terminal_states.includes(s),
  );
  let parked = new Set<string>();
  if (parkedStates.length > 0) {
    try {
      const issues = await tracker.fetchTerminalIssues({
        ...trackerConfig,
        terminal_states: [...parkedStates],
      });
      parked = new Set(issues.map((issue) => issue.identifier));
    } catch (err) {
      logger?.warn(
        { reason, err: err instanceof Error ? err.message : String(err) },
        "workspace sweep: could not fetch parked issues; skipping parked workspaces",
      );
    }
  }
  const isDisposable = deps.isDisposableCheckout ?? defaultIsDisposableCheckout;

  const inFlight = inFlightIdentifiers(state);
  for (const name of directories) {
    result.scanned++;
    const workspacePath = join(workspaceRoot, name);
    const isTerminal = terminal.has(name);
    const isParked = !isTerminal && parked.has(name);
    if (
      (!isTerminal && !isParked) ||
      inFlight.has(name) ||
      state.preserveWorkspacePaths.has(workspacePath) ||
      (await hasOpenHandles(workspacePath)) ||
      (isParked && !(await isDisposable(workspacePath)))
    ) {
      result.skipped++;
      continue;
    }
    try {
      const cleanup = await workspace.cleanupCompletedWorkspace(workspacePath);
      if (cleanup.removed) {
        result.removed++;
        logger?.info(
          { workspacePath, identifier: name, reason, parked: isParked },
          "workspace sweep removed",
        );
      } else {
        result.skipped++;
      }
    } catch (err) {
      result.skipped++;
      logger?.warn(
        { workspacePath, err: err instanceof Error ? err.message : String(err) },
        "workspace sweep failed to remove workspace (swallowed)",
      );
    }
  }

  logger?.info({ workspaceRoot, reason, ...result }, "workspace sweep complete");
  return result;
}

export interface WorkspaceSweeperOptions {
  /** Enables the periodic trigger (mirrors `cleanupCompletedWorkspaces`). */
  periodic: boolean;
  intervalMs?: number;
  pressureCooldownMs?: number;
  now?: () => number;
}

/**
 * Decides when to sweep and guarantees at most one sweep in flight. The
 * orchestrator calls `maybeSweep` every poll; the sweep itself runs
 * fire-and-forget so a slow `rm` over `node_modules` never delays dispatch.
 */
export class WorkspaceSweeper {
  private inFlight: Promise<TerminalSweepResult> | null = null;
  private lastPeriodicAt: number;
  private lastPressureAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;

  constructor(private readonly options: WorkspaceSweeperOptions) {
    this.now = options.now ?? Date.now;
    // The startup sweep just ran; wait a full interval for the first periodic pass.
    this.lastPeriodicAt = this.now();
  }

  /** Returns the started sweep's promise, or null when nothing was triggered. */
  maybeSweep(
    underPressure: boolean,
    deps: Omit<TerminalSweepDeps, "reason">,
  ): Promise<TerminalSweepResult> | null {
    if (this.inFlight) return null;
    const now = this.now();
    const intervalMs = this.options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    const cooldownMs = this.options.pressureCooldownMs ?? DEFAULT_PRESSURE_COOLDOWN_MS;

    let reason: TerminalSweepDeps["reason"] | null = null;
    if (underPressure && now - this.lastPressureAt >= cooldownMs) {
      reason = "pressure";
      this.lastPressureAt = now;
    } else if (this.options.periodic && now - this.lastPeriodicAt >= intervalMs) {
      reason = "periodic";
    }
    if (reason === null) return null;
    this.lastPeriodicAt = now;

    const sweep = runTerminalWorkspaceSweep({ ...deps, reason }).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = sweep;
    return sweep;
  }
}

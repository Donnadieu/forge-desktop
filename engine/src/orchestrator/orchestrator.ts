import type { AgentAdapter } from "../agent/types.js";
import type {
  RunningSessionSnapshot,
  StateSnapshot,
  TerminalBuildOutcome,
} from "../observability/types.js";
import type { NormalizedIssue, TrackerAdapter } from "../tracker/types.js";
import { checkInodePressure, createInodePressureState } from "../workspace/inode-pressure.js";
import { LeftoverSweeper } from "../workspace/leftover-sweep.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { BacklogPromoter } from "./backlog-promotion.js";
import { enforceCostCeiling } from "./cost-ceiling.js";
import { type DispatchIssueDeps, dispatchIssue as runDispatchIssue } from "./dispatch-issue.js";
import { effectiveAgentLimit, inFlightCount, selectIssuesToDispatch } from "./dispatcher.js";
import { reconcileRunningIssues } from "./reconciler.js";
import { refetchAndDispatch } from "./refetch-dispatch.js";
import { cancelAllRetries, cancelRetry, scheduleRetry } from "./retry-queue.js";
import { buildIssueSnapshot, buildStateSnapshot } from "./snapshot.js";
import {
  createInitialState,
  isBuildActive,
  type OrchestratorCallbacks,
  type OrchestratorConfig,
  type OrchestratorState,
} from "./types.js";
import { forgetStaleLimits, limitActive } from "./usage-limits.js";
import {
  completeSettledFromTracker,
  recordKilledTicket,
  handleWorkerComplete as runHandleWorkerComplete,
  handleWorkerError as runHandleWorkerError,
  settleRunningEntry,
} from "./worker-outcomes.js";
import { handleTerminalTransitions } from "./workspace-gc.js";
import { refreshWorkspaceLocks } from "./workspace-lock-gate.js";
import { WorkspaceSweeper } from "./workspace-periodic-sweep.js";
import { runWorkspaceStartupSweep } from "./workspace-startup-sweep.js";

export type { OrchestratorCallbacks, OrchestratorConfig } from "./types.js";

export class Orchestrator {
  private state: OrchestratorState;
  private tracker: TrackerAdapter;
  private agent: AgentAdapter;
  private workspace: WorkspaceManager;
  private config: OrchestratorConfig;
  private callbacks: OrchestratorCallbacks;
  private stopped = false;
  // Drain phase: stopped is true (no new dispatches, no scheduled ticks) but
  // existing workers run to completion. Cleared once Promise.allSettled
  // returns. Visible separately from `stopped` so tests/observers can tell
  // "stopping" apart from "fully stopped" if needed.
  private draining = false;
  private tickRunning = false;
  private pollRequested = false;
  private buildReportGenerated = false;
  private consecutiveEmptyPolls = 0;
  // Poll-health telemetry surfaced over /api/v1/orchestrator/status so Smith
  // (and operators) can see WHY nothing is dispatching — the poll error was
  // previously log-only, invisible to any API consumer. lastPollError is the
  // most recent poll-cycle failure message (e.g. "Linear project slug is
  // required"), cleared on the next clean poll. null = never polled yet.
  private lastPollAtMs: number | null = null;
  private lastPollError: string | null = null;
  // An empty poll returns *normally* (it isn't a thrown error), so onTick would
  // otherwise clear lastPollError and the "queue looks empty — verify the slug"
  // reason — the single most actionable signal for the brewbox no-pickup case —
  // would never reach the status endpoint. checkEmptyPolls stashes the
  // diagnostic here and onTick promotes it into lastPollError after a clean
  // cycle. null = the queue is not in a stuck-empty state.
  private emptyPollDiagnostic: string | null = null;
  // Latches once the per-build runaway-cost ceiling (FRG-958) trips so the
  // abort path runs exactly once even if a tick is already in flight.
  private costCeilingTripped = false;
  private readonly inodePressure = createInodePressureState();
  // Dev servers left running by runs that ended without their engine (leftover-sweep.ts).
  private readonly leftovers = new LeftoverSweeper();
  private startupSweepPromise: Promise<void> | null = null;
  // Periodic + disk-pressure reaper for terminal-ticket workspaces; see
  // workspace-periodic-sweep.ts. Built lazily so updateConfig() can't desync it.
  private workspaceSweeper: WorkspaceSweeper | null = null;
  // Moves cards out of Backlog (tracker.promote); built lazily like the sweeper.
  private backlogPromoter: BacklogPromoter | null = null;

  constructor(
    tracker: TrackerAdapter,
    agent: AgentAdapter,
    workspace: WorkspaceManager,
    config: OrchestratorConfig,
    callbacks: OrchestratorCallbacks = {},
  ) {
    this.state = createInitialState();
    this.tracker = tracker;
    this.agent = agent;
    this.workspace = workspace;
    this.config = config;
    this.callbacks = callbacks;
  }

  start(): void {
    // Idempotent — calling start() on a running orchestrator must not orphan
    // the existing tick timer by overwriting it with a fresh scheduleTick.
    if (!this.stopped && this.state.tickTimerId !== null) return;
    // No wall-clock reset here: `state.sessionStartedAt` is owned by the dispatch
    // path (re-stamped on the idle→active transition), and while idle Runtime
    // reads 0 regardless — so a stopped→running transition has nothing to reset.
    this.stopped = false;
    // Latch: the startup sweep runs exactly once per orchestrator lifetime,
    // before the first dispatch. The tick loop awaits the promise so dispatch
    // cannot outrun the reap pass.
    if (this.startupSweepPromise === null) {
      this.startupSweepPromise = this.runStartupSweep();
    }
    this.scheduleTick(0);
  }

  private async runStartupSweep(): Promise<void> {
    const workspaceRoot = this.workspace.config?.root;
    if (!workspaceRoot) return;
    try {
      await runWorkspaceStartupSweep({
        workspaceRoot,
        tracker: this.tracker,
        trackerConfig: this.config.trackerConfig,
        workspace: this.workspace,
        logger: this.config.logger,
      });
    } catch (err) {
      // The sweep must never prevent the orchestrator from starting. Log and
      // continue; the per-poll auto-GC remains available.
      this.config.logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "workspace startup sweep failed (continuing)",
      );
    }
  }

  /**
   * Refuses new dispatches, stops the tick loop, and resolves once every
   * running worker has settled.
   *
   * Default is a graceful drain: in-flight workers run to completion (no
   * abort). With `{ abort: true }` (process shutdown signal) every running
   * worker first goes through the kill path — recorded `cancelled`, its
   * session aborted (the adapter kills the agent's process group), no retry
   * and no `onComplete` — and the drain then waits for those workers to exit.
   */
  async stop(opts: { abort?: boolean } = {}): Promise<void> {
    this.stopped = true;
    this.draining = true;
    if (this.state.tickTimerId) {
      clearTimeout(this.state.tickTimerId);
      this.state.tickTimerId = null;
    }
    cancelAllRetries(this.state);
    if (opts.abort && this.state.running.size > 0) {
      this.config.logger?.info(
        { count: this.state.running.size },
        "Aborting running workers for shutdown",
      );
      for (const issueId of [...this.state.running.keys()]) this.killWorker(issueId, "cancelled");
    }
    // Killed-but-not-yet-exited workers (`settling`) are drained too, so stop()
    // never returns while an agent process may still be writing a workspace.
    const promises = [
      ...Array.from(this.state.running.values()).map((e) => e.workerPromise.catch(() => {})),
      ...Array.from(this.state.settling.values(), (s) => s.exited),
    ];
    // The agent kill sweep waits on unref'd timers. During process shutdown
    // nothing else may hold the event loop (the HTTP server is closed), so Node
    // would exit before the killed workers run after_run and release their
    // locks. Hold the loop until the drain completes.
    const keepAlive = opts.abort ? setInterval(() => {}, 60_000) : undefined;
    try {
      await Promise.allSettled(promises);
    } finally {
      clearInterval(keepAlive);
      this.state.running.clear();
      this.state.settling.clear();
      this.draining = false;
    }
  }
  getState(): Readonly<OrchestratorState> {
    return this.state;
  }
  getSnapshot(): StateSnapshot {
    return buildStateSnapshot(this.state);
  }
  setTerminalBuildOutcome(outcome: TerminalBuildOutcome): void {
    if (this.state.terminalBuildOutcome) return; // first-write-wins
    this.state.terminalBuildOutcome = outcome;
  }
  /**
   * Mark a workspace path as preserved so it is not auto-GC'd on terminal
   * transition. Used by the known-issues path to keep QA evidence (FRG-1718).
   */
  preserveWorkspacePath(path: string): void {
    this.state.preserveWorkspacePaths.add(path);
  }
  /**
   * Live poll-health for the status endpoint. Lets Smith answer "is it actually
   * being worked on / why hasn't it started" from real orchestrator state
   * rather than guessing: `lastPollError` surfaces a stuck poll (e.g. an empty
   * project slug), `consecutiveEmptyPolls` flags a queue the orchestrator sees
   * as empty, and the running/retrying counts are the in-flight worker load.
   */
  getPollHealth(): {
    lastPollAtMs: number | null;
    lastPollError: string | null;
    consecutiveEmptyPolls: number;
    running: number;
    retrying: number;
  } {
    return {
      lastPollAtMs: this.lastPollAtMs,
      lastPollError: this.lastPollError,
      consecutiveEmptyPolls: this.consecutiveEmptyPolls,
      running: this.state.running.size,
      retrying: this.state.retryAttempts.size,
    };
  }
  getIssueSnapshot(identifier: string): RunningSessionSnapshot | null {
    return buildIssueSnapshot(this.state, identifier);
  }
  triggerPoll(): void {
    if (this.stopped) return;
    if (this.tickRunning) {
      this.pollRequested = true;
      return;
    }
    if (this.state.tickTimerId) {
      clearTimeout(this.state.tickTimerId);
      this.state.tickTimerId = null;
    }
    this.scheduleTick(0);
  }
  updateConfig(config: Partial<OrchestratorConfig>): void {
    this.config = { ...this.config, ...config };
  }
  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    this.state.tickTimerId = setTimeout(() => this.onTick(), delayMs);
  }
  private async onTick(): Promise<void> {
    if (this.stopped) return;
    this.tickRunning = true;
    this.pollRequested = false;

    try {
      // Ensure the once-only startup sweep finishes before the first dispatch.
      if (this.startupSweepPromise) {
        await this.startupSweepPromise;
      }
      await this.pollCycle();
      // A clean cycle clears the last *thrown* error, but an empty-queue poll
      // returns normally while still being a diagnosable stuck state. Promote
      // its diagnostic (null when the queue is healthy) so the status tool
      // reports the real "why isn't it building" reason instead of nothing.
      this.lastPollError = this.emptyPollDiagnostic;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.lastPollError = err.message;
      this.callbacks.onPollError?.(err);
    }
    // Stamp the poll time once — identical on success and failure.
    this.lastPollAtMs = Date.now();
    this.tickRunning = false;
    if (this.pollRequested) {
      this.pollRequested = false;
      this.scheduleTick(0);
    } else {
      this.scheduleTick(this.config.pollIntervalMs);
    }
  }

  // Per-build runaway-cost ceiling (FRG-958). Decision + abort orchestration
  // live in cost-ceiling.ts; this wrapper only owns the latching flags.
  private enforceCostCeiling(): boolean {
    const action = enforceCostCeiling({
      tokens: this.state.totalTokens,
      ceiling: this.config.costCeiling,
      alreadyTripped: this.costCeilingTripped,
      buildReportGenerated: this.buildReportGenerated,
      logger: this.config.logger,
      onExceeded: this.callbacks.onCostCeilingExceeded,
      killWorker: (issueId) => this.killWorker(issueId, "cancelled"),
      runningIssueIds: () => Array.from(this.state.running.keys()),
      stop: () => void this.stop(),
    });
    if (action.markTripped) this.costCeilingTripped = true;
    if (action.markBuildReportGenerated) this.buildReportGenerated = true;
    return action.tripped;
  }

  private maybeSweepWorkspaces(workspaceRoot: string | undefined): void {
    if (!workspaceRoot) return;
    this.workspaceSweeper ??= new WorkspaceSweeper({
      periodic: this.config.cleanupCompletedWorkspaces === true,
    });
    const underPressure = this.inodePressure.pressed || this.inodePressure.dispatchBlocked;
    void this.workspaceSweeper.maybeSweep(underPressure, {
      workspaceRoot,
      tracker: this.tracker,
      trackerConfig: this.config.trackerConfig,
      workspace: this.workspace,
      state: this.state,
      logger: this.config.logger,
    });
  }

  private async maybePromoteBacklog(): Promise<void> {
    const promotion = this.config.backlogPromotion;
    if (!promotion) return;
    this.backlogPromoter ??= new BacklogPromoter(promotion);
    await this.backlogPromoter.maybePromote({
      tracker: this.tracker,
      trackerConfig: this.config.trackerConfig,
      logger: this.config.logger,
    });
  }

  private async pollCycle(): Promise<void> {
    if (this.enforceCostCeiling()) return;
    const workspaceRoot = this.workspace.config?.root;
    if (workspaceRoot) {
      void checkInodePressure({ workspaceRoot, logger: this.config.logger }, this.inodePressure);
      void this.leftovers.maybeSweep(workspaceRoot, this.config.logger);
    }
    const reconcileResult = await reconcileRunningIssues(this.state, this.tracker, {
      active_states: this.config.trackerConfig.active_states,
      terminal_states: this.config.trackerConfig.terminal_states,
      done_states: this.config.trackerConfig.done_states,
      stall_timeout_seconds: this.config.stallTimeoutSeconds,
    });
    handleTerminalTransitions(this.state, this.config, this.workspace, reconcileResult, {
      onComplete: (id) => this.completeWorkerFromTracker(id),
      onKill: (id) => this.killWorker(id, "cancelled"),
      onRetry: (id) => this.killAndRetry(id, "failure", "Stalled"),
      onReconcile: this.callbacks.onReconcile,
    });
    this.maybeSweepWorkspaces(workspaceRoot);
    // Before the candidate read, so a card just moved into Triage/Todo is
    // dispatchable this same cycle. Best-effort: never throws.
    await this.maybePromoteBacklog();
    // Fetch dispatch candidates and the project's progress counts atomically.
    // `candidates` gates dispatch, so its throw must propagate (getPollHealth
    // surfaces it); the progress count is read straight from the tracker (Linear
    // is the source of truth — no local accumulator), and its failure is
    // swallowed to `null` to honor "must never block dispatch".
    const [candidates, progress] = await Promise.all([
      this.tracker.fetchCandidates(this.config.trackerConfig),
      this.tracker.fetchProgressCounts(this.config.trackerConfig).catch((error): null => {
        this.config.logger?.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "Failed to refresh build-progress counts (keeping previous)",
        );
        return null;
      }),
    ]);
    // Fresh tracker counts (Linear = source of truth), set BEFORE both checks
    // below; keep the prior snapshot on read failure (never blocks dispatch).
    if (progress) {
      this.state.progress = progress;
      if (isBuildActive(progress)) {
        // Seed the build-level Runtime clock as soon as the tracker reports an
        // active build, even before the first ticket is dispatched. This avoids
        // falling back to a stale `sessionStartedAt` origin from a prior session
        // and inflating the dashboard Runtime metric.
        if (this.state.buildStartedAt == null) {
          this.state.buildStartedAt = performance.now();
        }
      } else if (inFlightCount(this.state) === 0) {
        // The build-level Runtime clock only makes sense while the tracker
        // reports an active build OR local work is still in flight. Clear it
        // only once the anvil is fully idle so a retry attempt or finishing
        // worker does not lose the continuous build clock.
        this.state.buildStartedAt = undefined;
      }
    }
    this.checkEmptyPolls(candidates);
    const dispatchCandidates = candidates;

    await refreshWorkspaceLocks(this.dispatchIssueDeps(), dispatchCandidates);
    forgetStaleLimits(this.state);
    const toDispatch = selectIssuesToDispatch(dispatchCandidates, this.state, {
      active_states: this.config.trackerConfig.active_states,
      terminal_states: this.config.trackerConfig.terminal_states,
      max_concurrent_agents: effectiveAgentLimit(this.config, inFlightCount(this.state)),
      limited: (issue) => limitActive(this.state, this.config.roleOf?.(issue.state) ?? -1),
    });
    for (const issue of toDispatch) {
      await this.dispatchIssue(issue);
    }
  }
  private checkEmptyPolls(candidates: NormalizedIssue[]): void {
    // Zero cards while nothing ever ran and the tracker counts no cards at all is a bad
    // project, not a finished board (an all-done project also returns zero candidates).
    const neverWorked = this.state.running.size === 0 && this.state.completed.size === 0;
    const trackerEmpty = (this.state.progress?.total ?? 0) === 0;
    if (candidates.length === 0 && neverWorked && trackerEmpty) {
      this.consecutiveEmptyPolls++;
      if (this.consecutiveEmptyPolls >= 3) {
        const slug = this.config.trackerConfig.project_slug;
        const diagnostic =
          `No candidates found for ${this.consecutiveEmptyPolls} consecutive polls ` +
          `(project_slug: "${slug}"). Verify the slug is a valid Linear project slugId.`;
        // Surface to the status endpoint (via onTick → lastPollError), not just
        // the logger — this is the actual reason a build never starts.
        this.emptyPollDiagnostic = diagnostic;
        this.callbacks.onPollError?.(new Error(diagnostic));
      }
    } else {
      this.consecutiveEmptyPolls = 0;
      this.emptyPollDiagnostic = null;
    }
  }
  private dispatchIssueDeps(): DispatchIssueDeps {
    return {
      state: this.state,
      tracker: this.tracker,
      agent: this.agent,
      workspace: this.workspace,
      config: this.config,
      callbacks: this.callbacks,
      isStopped: () => this.stopped,
      isDraining: () => this.draining,
      inodePressure: this.inodePressure,
      handleWorkerComplete: (id, result, n, owner) =>
        runHandleWorkerComplete(this.workerOutcomeDeps(), id, result, n, owner),
      handleWorkerError: (id, identifier, err, n, owner) =>
        runHandleWorkerError(this.workerOutcomeDeps(), id, identifier, err, n, owner),
    };
  }

  private dispatchIssue(issue: NormalizedIssue, attempt = 1): Promise<void> {
    return runDispatchIssue(this.dispatchIssueDeps(), issue, attempt);
  }

  private workerOutcomeDeps() {
    return {
      state: this.state,
      config: this.config,
      callbacks: this.callbacks,
      refetchAndDispatch: (id: string, n: number, check: boolean) =>
        this.refetchAndDispatch(id, n, check),
    };
  }

  private killWorker(issueId: string, status: "cancelled" | "stalled" = "cancelled"): void {
    settleRunningEntry(this.workerOutcomeDeps(), issueId, (deps, entry) =>
      recordKilledTicket(deps, entry, status),
    );
    cancelRetry(this.state, issueId);
  }

  /**
   * The tracker reached a SUCCESS/done state for an issue whose worker is still
   * mid-flight. Record the ticket as completed (success) — NOT cancelled — then
   * abort the now-redundant worker.
   */
  private completeWorkerFromTracker(issueId: string): void {
    completeSettledFromTracker(this.workerOutcomeDeps(), issueId);
    cancelRetry(this.state, issueId);
  }

  /** Forge Desktop: the person steers a running card from its session; false when no agent runs it. */
  steer(issueId: string, text: string): boolean {
    const entry = this.state.running.get(issueId);
    if (!entry?.sessionId) return false;
    const agent = this.config.agentForState?.(entry.issue.state) ?? this.agent;
    return agent.steer?.(entry.sessionId, text) ?? false;
  }

  private killAndRetry(
    issueId: string,
    delayType: "continuation" | "failure",
    error: string,
  ): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;
    const { attempt, identifier } = entry;
    this.killWorker(issueId, "stalled");

    if (attempt < this.config.maxRetryAttempts) {
      scheduleRetry(
        this.state,
        issueId,
        identifier,
        attempt + 1,
        delayType,
        error,
        this.config.maxRetryDelayMs,
        (retryIssueId) => this.refetchAndDispatch(retryIssueId, attempt + 1, false),
        this.config.retryBaseDelayMs,
      );
    }
  }

  /** Re-fetch an issue from the tracker and dispatch it for retry. */
  private refetchAndDispatch(issueId: string, attempt: number, checkState: boolean): void {
    refetchAndDispatch(
      {
        state: this.state,
        tracker: this.tracker,
        config: this.config,
        dispatchIssue: (issue, n) => this.dispatchIssue(issue, n),
        onError: (id, e) => this.callbacks.onError?.(id, e),
      },
      issueId,
      attempt,
      checkState,
    );
  }
}

import type { Logger } from "pino";
import type { AgentAdapter, AgentEvent } from "../agent/types.js";
import type { LimitKind } from "../agent/usage-limit.js";
import type { TerminalBuildOutcome } from "../observability/types.js";
import type { TicketTelemetry, TokenTotals, TurnTimingEntry } from "../telemetry/types.js";
import type { NormalizedIssue, ProgressCounts, TrackerConfig } from "../tracker/types.js";
import type { WorkerResult } from "../worker/runner.js";
import type { HelperActivity } from "./activity.js";
import type { BacklogPromotionConfig } from "./backlog-promotion.js";
import type { CostCeilingConfig } from "./cost-ceiling.js";

export type { TicketTelemetry, TokenTotals, TurnTimingEntry } from "../telemetry/types.js";

export interface OrchestratorConfig {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  /**
   * Forge Desktop: how many agents may be in flight now, given this engine's own count (the ceiling across
   * every engine on the Mac, orchestrator/shared-slots.ts). Unset: `maxConcurrentAgents` alone.
   */
  agentLimit?: (inFlight: number) => number;
  /** Forge Desktop: the agent for a card's state (agent/roles.ts). Unset: the orchestrator's one agent. */
  agentForState?: (state: string) => AgentAdapter;
  /** Forge Desktop: which role a state belongs to; a card moving to another role ends its run. */
  roleOf?: (state: string) => number;
  maxTurns: number;
  turnTimeoutMs?: number;
  readTimeoutMs?: number;
  /** How long a lead agent may wait for its helpers after ending its turn (worker/helper-wait.ts). */
  helperWaitMs?: number;
  approvalPolicy?: string;
  stallTimeoutSeconds: number;
  maxRetryAttempts: number;
  maxRetryDelayMs: number;
  retryBaseDelayMs?: number;
  trackerConfig: TrackerConfig;
  promptTemplate: string;
  mcpServers?: Record<string, unknown>;
  skillsManifest?: string;
  repoCloneUrl?: string;
  /**
   * Stamped-repo marker path (Smith only). When the marker is non-empty at
   * build completion, `repoCloneUrl` is the customer's repo and the build
   * report is not committed to it (FRG-2081). Unset on factory builds.
   */
  stampedRepoFile?: string;
  runId?: string;
  stack?: string;
  logger?: Logger;
  /**
   * Per-build runaway-cost ceiling (FRG-958). Omitted or `maxBuildUsd <= 0`
   * disables enforcement, preserving prior unbounded behavior.
   */
  costCeiling?: CostCeilingConfig;
  /**
   * Auto-GC ephemeral workspaces when their ticket transitions to a terminal
   * state (Done / Cancelled / Closed) — see FRG-1547. When true (default off,
   * caller opts in), the orchestrator fires
   * {@link WorkspaceManager.cleanupCompletedWorkspace} for every worker that
   * settles via `reconcileRunningIssues` classifying it terminal. Retries
   * (`toRetry`) are NEVER cleaned up here — the retry will reuse the worktree.
   * Off unless `FORGE_WORKSPACE_AUTO_CLEANUP` enables it, so post-mortem
   * debugging of failed builds remains possible.
   */
  cleanupCompletedWorkspaces?: boolean;
  /**
   * Master `custom_workflows` flag (FRG-1988). Off by default; when off, every
   * custom-workflows code path in the orchestrator is skipped and dispatch
   * behaves exactly as it did before the feature existed.
   */
  customWorkflows?: boolean;
  /**
   * Ticket-claim settings used when `customWorkflows` is on. Ignored otherwise.
   */
  claimOptions?: ClaimDispatchOptions;
  /**
   * Forge moves cards out of `Backlog` itself (workflow file `tracker.promote`):
   * untriaged cards into `Triage`, ready-for-execution cards into `Todo`. See
   * `backlog-promotion.ts`. Omitted ⇒ Backlog is only ever emptied by a person.
   */
  backlogPromotion?: BacklogPromotionConfig;
  /**
   * Set when this box's build worker must not dispatch at all (FRG-2928: a
   * BYOK Smith whose own key can't back the worker would otherwise spend the
   * platform key). Candidates stay unclaimed and in their tracker state, and
   * the hold is surfaced on `/api/v1/orchestrator/status`. Fixed at boot — a
   * provider-config change reboots the box.
   */
  dispatchHold?: DispatchHold;
}

/** A standing refusal to dispatch any worker, with the owner-facing reason. */
export interface DispatchHold {
  reason: string;
  message: string;
}

/** Ticket-claim settings for `dispatchIssue` (FRG-1988). */
export interface ClaimDispatchOptions {
  /**
   * Tracker identity the claim is registered under. Defaults to `"me"` — the
   * API key's own viewer — which is what a factory-run agent wants.
   */
  assignee?: string;
  /**
   * Workflow state the ticket is moved to as part of the claim, so the claim is
   * visible in the tracker as more than an assignment. Omitted ⇒ assignment only.
   */
  stateName?: string;
}

export interface OrchestratorCallbacks {
  onDispatch?: (issue: NormalizedIssue) => void;
  /**
   * `willRetry` is true when the orchestrator has scheduled a re-dispatch of
   * this ticket because the failure is retryable (preserveWorkspace +
   * !success + attempts remaining). Consumers that drive a *terminal* state
   * off this callback (e.g. the Smith `failed` lifecycle transition) MUST NOT
   * finalize when `willRetry` is true — a later attempt may still succeed.
   */
  onComplete?: (
    issueId: string,
    result: WorkerResult,
    issue: NormalizedIssue,
    willRetry?: boolean,
  ) => void;
  onError?: (issueId: string, error: Error) => void;
  onEvent?: (issueId: string, event: AgentEvent) => void;
  onReconcile?: (toKill: string[], toRetry: string[]) => void;
  onPollError?: (error: Error) => void;
  /**
   * Fired once when the per-build runaway-cost ceiling (FRG-958) is tripped,
   * immediately before in-flight workers are aborted and the run is stopped.
   * Fire-and-forget: implementations MUST handle their own errors.
   */
  onCostCeilingExceeded?: (info: {
    spendUsd: number;
    maxBuildUsd: number;
    tokens: { input: number; output: number };
  }) => void;
  /**
   * Fired once per ticket at dispatch time, before the worker starts. Paired
   * with onTicketComplete so persistence layers can land a "running" row at
   * the start of work — mid-flight crashes then leave a visible trace
   * instead of vanishing. Same fire-and-forget contract as onTicketComplete.
   */
  onTicketStart?: (
    issueId: string,
    info: {
      identifier: string;
      ticketTitle: string;
      attempt: number;
      startedAtMs: number;
    },
  ) => void;
  /**
   * Fired once per ticket after the worker settles (success, failure, or
   * terminal error). Receives the bundled telemetry for that ticket so a
   * downstream consumer can persist it. The orchestrator awaits no return
   * value — implementations MUST catch their own errors; a thrown promise
   * here would surface as an unhandled rejection.
   */
  onTicketComplete?: (issueId: string, telemetry: TicketTelemetry) => void;
}

export interface RunningEntry {
  issueId: string;
  identifier: string;
  issue: NormalizedIssue;
  startedAt: number; // performance.now() monotonic
  /** Date.now() snapshot at dispatch — used to project per-turn perf.now() values back to wall-clock. */
  wallClockStartedAtMs: number;
  lastActivityAt: number; // performance.now() monotonic
  tokens: TokenTotals;
  workspacePath: string | null;
  attempt: number;
  abortController: AbortController;
  workerPromise: Promise<void>;
  sessionId: string | null;
  turnCount: number;
  lastEvent: string;
  lastMessage: string;
  /** One plain line about what the agent is doing now (orchestrator/activity.ts). */
  activity: string;
  /** The lead's helpers, from Claude Code's background-task events. */
  helpers: HelperActivity[];
  /** The last plain activity lines, newest last, for the card's detail. */
  recent: Array<{ at: string; line: string }>;
  host: string | null;
  /** Per-turn telemetry, populated by orchestrator's onTurnStart / onTurnEnd / onEvent consumers. */
  turnTimings: TurnTimingEntry[];
  /** Forge Desktop: whose account this run uses, for usage limits (the role's index, -1 = the project's own). */
  limitKey?: number;
}

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number; // performance.now() monotonic
  delayType: "continuation" | "failure";
  error: string | null;
  timerId: ReturnType<typeof setTimeout>;
  /**
   * Forge Desktop: waiting for its account's usage limit to reset (orchestrator/usage-limits.ts). It holds no
   * agent slot and used no retry; it turns into an ordinary reservation when the wait ends.
   */
  limitKey?: number;
}

export interface TicketOutcomeEntry {
  result: WorkerResult;
  identifier: string;
  durationMs: number;
  /**
   * Full telemetry captured at the same moment, including wall-clock start /
   * finish and per-turn timings. Populated by the worker-outcomes handlers
   * so build-report.ts can emit a complete per-ticket timeline.
   */
  telemetry?: TicketTelemetry;
}

/** A killed worker that has not exited yet; `exited` resolves (never rejects) once it has. */
export interface SettlingEntry {
  identifier: string;
  exited: Promise<void>;
}

export interface OrchestratorState {
  running: Map<string, RunningEntry>;
  completed: Set<string>;
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  /**
   * Issues whose worker was killed (stall, reconcile, cost/QA breach) and left
   * `running`, but whose process has not exited yet. The issue stays reserved
   * until the promise settles, so no retry or poll starts a second session in
   * the same workspace (FRG-4086). Keyed by issue id.
   */
  settling: Map<string, SettlingEntry>;
  totalTokens: TokenTotals;
  /** The latest Claude subscription usage window seen, by window name (five_hour, seven_day...). */
  rateLimits: Record<
    string,
    { percent: number | null; resetsAt: string | null; status: string; seenAt: string }
  >;
  tickTimerId: ReturnType<typeof setTimeout> | null;
  secondsRunning: number; // sum of finished agent-seconds; see StateSnapshot.codexTotals
  /**
   * `performance.now()` origin of the current active session, read by
   * `buildStateSnapshot` for the dashboard "Runtime" metric. Reset to the
   * dispatch time on the idle→active transition (see `dispatchIssue`) so a new
   * Smith feature does not inherit a previous Forge build's runtime, and left
   * untouched while any work is in-flight or pending retry. Meaningless while
   * the anvil is idle (Runtime reads 0 then, ignoring this value).
   */
  sessionStartedAt: number;
  /**
   * `performance.now()` origin of the current tracker-reported multi-ticket
   * build. Set on the first dispatch while the build is active and cleared by
   * the poll cycle once the tracker reports the build is no longer active (or
   * once the build-complete path fires). Used by `buildStateSnapshot` so the
   * Anvil Runtime clock stays continuous across individual workers finishing
   * within a single Forge build (e.g. the initial build), instead of restarting
   * for every ticket. `undefined` when no active build is in flight.
   */
  buildStartedAt?: number;
  ticketOutcomes: Map<string, TicketOutcomeEntry>;
  /**
   * Latest build-progress counts, read straight from the tracker each poll via
   * `fetchProgressCounts` (`total` = every issue in the project's label scope,
   * `done` = the terminal subset). No local accumulation, so a worker restart
   * doesn't reset the bar to 0%. `null` until the first successful poll.
   *
   * This full-scope `total` deliberately differs from the build report's
   * active+terminal `totalTickets` (see build-report.ts): a ticket parked in a
   * non-active/non-terminal state (e.g. "In Review") counts here but not there.
   */
  progress: ProgressCounts | null;
  /**
   * Consecutive polls a tracker-only "all terminal" observation has repeated for
   * a process that did no local work (restart / late join). Confirmation across
   * polls guards against Linear's cross-query eventual consistency triggering a
   * premature, irreversible completion. Reset whenever the observation lapses.
   */
  consecutiveTrackerCompletePolls: number;
  /**
   * Workspace paths that must not be auto-GC'd because they hold evidence for
   * the known-issues path (FRG-1718). Populated by the breach handler before the
   * QA worker is killed so the QA report + screenshots survive completion.
   */
  preserveWorkspacePaths: Set<string>;
  /**
   * Set once when the build reaches a terminal state. Survives orchestrator.stop()
   * so the Anvil page can render a stable completion/failure state instead of
   * going blank when the worker process is no longer running work.
   */
  terminalBuildOutcome?: TerminalBuildOutcome;
  /** Issue ids already logged as held by `OrchestratorConfig.dispatchHold`. */
  dispatchHoldLogged: Set<string>;
  /**
   * Issue id → holder of its workspace dispatch lock, for issues last refused
   * because another live process holds it (FRG-4527). Dedupes the log line,
   * ranks those issues last for dispatch, drives the orphan reap (FRG-5429),
   * and is listed in the state snapshot.
   */
  workspaceLocked: Map<string, WorkspaceLockedEntry>;
  /**
   * Issue id → `Date.now()` when its claim was last refused because someone
   * else holds the card. Those issues rank last for dispatch for a while
   * (`CLAIM_REFUSED_BACKOFF_MS`), so a card held by another person or agent
   * can't take the free slot every poll and starve the cards behind it.
   */
  claimRefused: Map<string, number>;
  /** Forge Desktop: accounts that hit a usage, spend or rate limit, by limit key (orchestrator/usage-limits.ts). */
  usageLimits: Map<number, LimitState>;
}

/** An account that hit a usage, spend or rate limit, and when Forge tries it again. */
export interface LimitState {
  /** The role's index whose account is limited; -1 = the project's own provider. */
  key: number;
  kind: LimitKind;
  reason: string;
  /** The provider's own words. */
  message: string;
  link: string | null;
  /** When the provider said it resets (ISO 8601), or null. */
  resetsAt: string | null;
  /** `Date.now()` when waiting cards try again (the reset, or a check when no reset was given). */
  untilMs: number;
  /** `Date.now()` when this limit was first seen. */
  sinceMs: number;
}

/** An issue refused dispatch because its workspace lock has a live holder. */
export interface WorkspaceLockedEntry {
  identifier: string;
  /** `token@startedAt`: identifies one lock holder. */
  holderKey: string;
  holderPid: number;
  holderAgentPid: number | undefined;
  holderStartedAt: string;
  /** Processes carrying the workspace's agent marker at the last check. */
  markedPids: number[];
  /** Live only through processes of a dead orchestrator's agent tree. */
  orphaned: boolean;
  /** `Date.now()` when this holder was first seen. */
  sinceMs: number;
  /**
   * `performance.now()` the reap grace period counts from; `null` unless
   * orphaned with marked processes.
   */
  orphanedSinceMs: number | null;
  /** Whether a reap of this lock is in flight. */
  reaping: boolean;
}

export function createInitialState(): OrchestratorState {
  return {
    running: new Map(),
    completed: new Set(),
    claimed: new Set(),
    retryAttempts: new Map(),
    settling: new Map(),
    totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    rateLimits: {},
    tickTimerId: null,
    secondsRunning: 0,
    sessionStartedAt: performance.now(),
    buildStartedAt: undefined,
    ticketOutcomes: new Map(),
    progress: null,
    consecutiveTrackerCompletePolls: 0,
    preserveWorkspacePaths: new Set(),
    terminalBuildOutcome: undefined,
    dispatchHoldLogged: new Set(),
    workspaceLocked: new Map(),
    claimRefused: new Map(),
    usageLimits: new Map(),
  };
}

/**
 * A tracker-reported build is "active" when there are still unfinished tickets
 * in the project's scope. Used to decide when to open, hold, and clear the
 * build-level Runtime clock (`buildStartedAt`).
 */
export function isBuildActive(progress: ProgressCounts | null): boolean {
  return progress != null && progress.total > 0 && progress.done < progress.total;
}

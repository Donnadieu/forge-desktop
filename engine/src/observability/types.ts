/**
 * Snapshot types consumed by the TUI dashboard and HTTP server.
 * Layer 0 — no cross-module imports.
 */

export interface RunningSessionSnapshot {
  issueId: string;
  identifier: string;
  title: string;
  description: string;
  state: string;
  sessionId: string | null;
  turnCount: number;
  lastEvent: string;
  lastMessage: string;
  activity: string;
  helpers: Array<{ id: string; description: string; running: boolean }>;
  recent: Array<{ at: string; line: string }>;
  startedAt: string;
  lastEventAt: string;
  tokens: { input: number; output: number; total: number };
  workspacePath: string | null;
  attempt: number;
  host: string | null;
}

export interface RetrySnapshot {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAt: string;
  error: string | null;
  /** Forge Desktop: waiting for its account's usage limit to reset, not retrying a failure. */
  waitingForLimit?: boolean;
}

/**
 * An issue refused dispatch because a live process holds its workspace
 * dispatch lock (SPEC §9.6, FRG-5429).
 */
export interface WorkspaceLockedSnapshot {
  issueId: string;
  identifier: string;
  holderPid: number;
  holderAgentPid: number | null;
  holderStartedAt: string;
  /** Processes carrying the workspace's agent marker at the last check. */
  markedPids: number[];
  /** Held only by processes of a dead orchestrator's agent tree; reaped after a grace period. */
  orphaned: boolean;
  /** When this holder was first seen refusing the dispatch. */
  since: string;
  /** Whether a reap of the orphaned processes is in flight. */
  reaping: boolean;
}

/**
 * Terminal outcome of a per-build worker run. Recorded once when the
 * orchestrator decides the build is complete, then served by the Anvil page
 * so the dashboard remains useful after the orchestrator stops polling.
 */
export interface TerminalBuildOutcome {
  /** completed = deployed and all tickets terminal-done; failed = deploy failed or any ticket failed. */
  status: "completed" | "failed";
  completedAt: string;
  deploymentUrl: string | null;
  /** Non-token-bearing URL of the app's Smith control plane; null when unavailable. */
  smithUrl: string | null;
  ticketsCompleted: number;
  ticketsFailed: number;
  totalTickets: number;
  /** Human-readable summary for the dashboard; null when no extra detail is needed. */
  message: string | null;
}

/**
 * Wire (snake_case) shape of {@link TerminalBuildOutcome} as served on
 * `/api/v1/orchestrator/status` and read by the dashboard client. Declared
 * explicitly so `toStateJson`'s hand-remap is compiler-checked (`satisfies`):
 * a missed or misspelled snake_case key becomes a build error instead of a
 * silent `undefined` on the Anvil page. Keep the field set in lockstep with
 * `TerminalBuildOutcome` and the client reads in `renderTerminal` (html.ts).
 */
export interface TerminalBuildOutcomeJson {
  status: TerminalBuildOutcome["status"];
  completed_at: string;
  deployment_url: string | null;
  smith_url: string | null;
  tickets_completed: number;
  tickets_failed: number;
  total_tickets: number;
  message: string | null;
}

export interface StateSnapshot {
  generatedAt: string;
  counts: { running: number; retrying: number };
  running: RunningSessionSnapshot[];
  retrying: RetrySnapshot[];
  /** Issues refused dispatch for a held workspace lock. */
  workspaceLocked: WorkspaceLockedSnapshot[];
  codexTotals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    // Sum of agent-seconds (finished + in-flight). Scales with concurrency.
    secondsRunning: number;
    // Wall-clock seconds of the current active session or tracker-reported
    // multi-ticket build, measured from `sessionStartedAt` for Smith/non-build
    // work and from `buildStartedAt` for an active Forge build. Steady as
    // individual workers finish within a build; reads 0 when the anvil is fully
    // idle and the tracker reports no active build, so each feature gets its
    // own runtime clock. What the TUI Runtime shows. (Canonical definition —
    // the UI labels reference this.)
    wallClockSeconds: number;
  };
  /**
   * Build-progress counts for the per-build worker dashboard. `null` until the
   * first poll populates it (or when there are no tickets in scope). `percent`
   * is `done/total` rounded to an integer, clamped 0–100.
   */
  progress: { total: number; done: number; percent: number } | null;
  /** Serialized mirror of OrchestratorState.terminalBuildOutcome; see there for rationale. */
  terminalBuildOutcome?: TerminalBuildOutcome;
  rateLimits: unknown;
  /**
   * Forge Desktop: accounts at a usage, spend or rate limit. `role` is the role's index (-1 = the project's own
   * provider); `until` is when waiting cards try again.
   */
  limits?: Array<{
    role: number;
    kind: string;
    reason: string;
    message: string;
    link: string | null;
    resetsAt: string | null;
    until: string;
    since: string;
  }>;
}

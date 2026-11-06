/**
 * Snapshot → snake_case transformers (SPEC 13.7.2).
 *
 * The local API sends these to the app.
 */

import type {
  RunningSessionSnapshot,
  StateSnapshot,
  TerminalBuildOutcomeJson,
  WorkspaceLockedSnapshot,
} from "../observability/types.js";

export function toRunningJson(s: RunningSessionSnapshot): Record<string, unknown> {
  return {
    issue_id: s.issueId,
    issue_identifier: s.identifier,
    issue_title: s.title,
    issue_description: s.description,
    state: s.state,
    session_id: s.sessionId,
    turn_count: s.turnCount,
    last_event: s.lastEvent,
    last_message: s.lastMessage,
    activity: s.activity,
    helpers: s.helpers,
    recent: s.recent,
    started_at: s.startedAt,
    last_event_at: s.lastEventAt,
    tokens: {
      input_tokens: s.tokens.input,
      output_tokens: s.tokens.output,
      total_tokens: s.tokens.total,
    },
    workspace_path: s.workspacePath,
    attempt: s.attempt,
    host: s.host,
  };
}

export function toRetryJson(r: {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAt: string;
  error: string | null;
  waitingForLimit?: boolean;
}): Record<string, unknown> {
  return {
    issue_id: r.issueId,
    issue_identifier: r.identifier,
    attempt: r.attempt,
    due_at: r.dueAt,
    error: r.error,
    ...(r.waitingForLimit ? { waiting_for_limit: true } : {}),
  };
}

export function toWorkspaceLockedJson(w: WorkspaceLockedSnapshot): Record<string, unknown> {
  return {
    issue_id: w.issueId,
    issue_identifier: w.identifier,
    holder_pid: w.holderPid,
    holder_agent_pid: w.holderAgentPid,
    holder_started_at: w.holderStartedAt,
    marked_pids: w.markedPids,
    orphaned: w.orphaned,
    since: w.since,
    reaping: w.reaping,
  };
}

export function toStateJson(snap: StateSnapshot): Record<string, unknown> {
  const outcome = snap.terminalBuildOutcome;
  return {
    generated_at: snap.generatedAt,
    counts: { running: snap.counts.running, retrying: snap.counts.retrying },
    running: snap.running.map(toRunningJson),
    retrying: snap.retrying.map(toRetryJson),
    workspace_locked: snap.workspaceLocked.map(toWorkspaceLockedJson),
    codex_totals: {
      input_tokens: snap.codexTotals.inputTokens,
      output_tokens: snap.codexTotals.outputTokens,
      total_tokens: snap.codexTotals.totalTokens,
      seconds_running: snap.codexTotals.secondsRunning,
      wall_clock_seconds: snap.codexTotals.wallClockSeconds,
    },
    progress: snap.progress,
    terminal_build_outcome: outcome
      ? ({
          status: outcome.status,
          completed_at: outcome.completedAt,
          deployment_url: outcome.deploymentUrl,
          smith_url: outcome.smithUrl,
          tickets_completed: outcome.ticketsCompleted,
          tickets_failed: outcome.ticketsFailed,
          total_tickets: outcome.totalTickets,
          message: outcome.message,
        } satisfies TerminalBuildOutcomeJson)
      : null,
    rate_limits: snap.rateLimits,
    limits: (snap.limits ?? []).map((l) => ({
      role: l.role,
      kind: l.kind,
      reason: l.reason,
      message: l.message,
      link: l.link,
      resets_at: l.resetsAt,
      until: l.until,
      since: l.since,
    })),
  };
}

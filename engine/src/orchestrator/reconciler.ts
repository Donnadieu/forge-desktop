import type { TrackerAdapter } from "../tracker/types.js";
import type { OrchestratorState } from "./types.js";

// Defensive fallback only — `done_states` is set by config assembly in practice
// (see DEFAULT_DONE_STATES in config/schema.ts, the canonical copy). The
// orchestrator layer may not import config per ARCHITECTURE.md, so this local
// default is intentionally duplicated; keep it in sync with the config one.
const DEFAULT_DONE_STATES = ["Done", "Closed"];

export interface ReconcileResult {
  toComplete: string[]; // issue IDs whose tracker reached a success/done state
  toKill: string[]; // issue IDs that should be terminated (cancelled)
  toRetry: string[]; // issue IDs that should be retried (stalled)
  staleIds: string[]; // issue IDs no longer visible in tracker
}

/**
 * Reconcile running issues against current tracker state.
 */
export async function reconcileRunningIssues(
  state: OrchestratorState,
  tracker: TrackerAdapter,
  config: {
    active_states: string[];
    terminal_states: string[];
    done_states?: string[];
    stall_timeout_seconds: number;
  },
): Promise<ReconcileResult> {
  const result: ReconcileResult = { toComplete: [], toKill: [], toRetry: [], staleIds: [] };
  const doneStates = config.done_states ?? DEFAULT_DONE_STATES;

  if (state.running.size === 0) return result;

  // Batch fetch current states for all running issues
  const runningIds = Array.from(state.running.keys());
  let currentStates: Map<string, string>;
  try {
    currentStates = await tracker.fetchIssueStatesByIds(runningIds);
  } catch {
    // State refresh failed; keep workers running, try again next tick
    return result;
  }

  const now = performance.now();

  for (const [issueId, entry] of state.running) {
    const currentState = currentStates.get(issueId);

    // Issue disappeared from tracker
    if (!currentState) {
      result.staleIds.push(issueId);
      result.toKill.push(issueId);
      continue;
    }

    // Issue moved to terminal state. A success/done terminal (Linear
    // "Done"/"Closed") means the work landed — record it as completed, NOT
    // killed-as-cancelled (the bug that mislabeled every successful ticket
    // `cancelled` because agents move their own tickets to Done on success).
    // Reserve kill (cancelled) for cancel-category terminals.
    if (config.terminal_states.includes(currentState)) {
      if (doneStates.includes(currentState)) {
        result.toComplete.push(issueId);
      } else {
        result.toKill.push(issueId);
      }
      continue;
    }

    // Issue no longer in active state
    if (!config.active_states.includes(currentState)) {
      result.toKill.push(issueId);
      continue;
    }

    // Check for stall (no activity within timeout)
    if (config.stall_timeout_seconds > 0) {
      const stallThresholdMs = config.stall_timeout_seconds * 1000;
      const elapsed = now - entry.lastActivityAt;
      if (elapsed > stallThresholdMs) {
        result.toRetry.push(issueId);
      }
    }
  }

  return result;
}

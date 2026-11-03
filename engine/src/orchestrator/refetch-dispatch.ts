/**
 * `refetchAndDispatch`: re-fetch an issue from the tracker and dispatch it
 * for retry. Extracted from `Orchestrator` so the class file stays under
 * the architecture line-count ceiling.
 */

import type { NormalizedIssue, TrackerAdapter } from "../tracker/types.js";
import { inFlightCountExcluding } from "./dispatcher.js";
import { cancelRetry } from "./retry-queue.js";
import { liveSessionReason, logDispatchSuppressed } from "./session-guard.js";
import type { OrchestratorConfig, OrchestratorState } from "./types.js";

export interface RefetchAndDispatchDeps {
  state: OrchestratorState;
  tracker: TrackerAdapter;
  config: OrchestratorConfig;
  dispatchIssue: (issue: NormalizedIssue, attempt: number) => Promise<void>;
  onError: (issueId: string, err: Error) => void;
}

export function refetchAndDispatch(
  deps: RefetchAndDispatchDeps,
  issueId: string,
  attempt: number,
  checkState: boolean,
): void {
  const go = async (): Promise<void> => {
    try {
      const identifier = deps.state.retryAttempts.get(issueId)?.identifier;
      // A killed worker is still exiting: hold this retry's reservation until
      // it has, rather than start a second session in its workspace (FRG-4086).
      const settling = deps.state.settling.get(issueId)?.exited;
      if (settling) {
        logDispatchSuppressed(deps.config.logger, {
          issueId,
          identifier,
          attempt,
          reason: "settling",
        });
        await settling;
        // The retry may have been cancelled (stop, kill) while we waited.
        if (deps.state.retryAttempts.get(issueId)?.attempt !== attempt) return;
      }
      if (checkState) {
        const states = await deps.tracker.fetchIssueStatesByIds([issueId]);
        const state = states.get(issueId);
        if (!state || !deps.config.trackerConfig.active_states.includes(state)) return;
      }
      const live = liveSessionReason(deps.state, issueId);
      if (live) {
        logDispatchSuppressed(deps.config.logger, { issueId, identifier, attempt, reason: live });
        return;
      }
      // Check slot availability before retry dispatch. This
      // issue's own reservation still sits in `retryAttempts` (held continuously
      // since the timer fired), so exclude it: the retry owns that slot, and
      // only OTHER in-flight work should block it.
      if (inFlightCountExcluding(deps.state, issueId) >= deps.config.maxConcurrentAgents) return;
      const candidates = await deps.tracker.fetchCandidates(deps.config.trackerConfig);
      const issue = candidates.find((c) => c.id === issueId);
      // `dispatchIssue` resolves only after the issue is registered in
      // `running`, so the slot is held continuously: `retryAttempts` (below)
      // hands off to `running` with no window where the agent looks free.
      if (issue) await deps.dispatchIssue(issue, attempt);
    } finally {
      // Release the slot reservation on every path — dispatched (now in
      // `running`), bailed (state changed / capacity full), or stopped. The
      // timer already fired, so the cleared timer is a no-op. Guard on `attempt`
      // so we never clobber a *newer* reservation: if the dispatched worker
      // already failed and scheduled the next attempt, that entry must survive.
      const reservation = deps.state.retryAttempts.get(issueId);
      if (reservation && reservation.attempt === attempt) {
        cancelRetry(deps.state, issueId);
      }
    }
  };
  go().catch((err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    deps.onError(issueId, e);
  });
}

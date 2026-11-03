/**
 * The dispatch-time ticket claim (FRG-1988).
 *
 * Kept out of `dispatch-issue.ts` so the fail-closed decision is testable on
 * its own and readable in one screen — it is the only place in the dispatch
 * path that deliberately inverts the surrounding fail-open policy.
 */

import type { NormalizedIssue, TrackerAdapter } from "../tracker/types.js";
import type { ClaimDispatchOptions, OrchestratorConfig } from "./types.js";

export type ClaimDecision =
  | { dispatch: true; claimed: boolean; reason?: string }
  | { dispatch: false; reason: string };

/**
 * Decide whether `issue` may be dispatched, claiming it in the tracker first
 * when the master flag is on.
 *
 * Fail-open when the feature is off, fail-**closed** when it is on. That
 * asymmetry is the point: the surrounding state re-validation in
 * `dispatchIssue` proceeds when the tracker read fails, because a stale read is
 * only a wasted worker. A failed claim is different — an unverified claim is
 * not a claim, and dispatching on one is exactly how two agents end up holding
 * the same ticket.
 */
export async function claimForDispatch(
  tracker: TrackerAdapter,
  config: Pick<OrchestratorConfig, "customWorkflows" | "claimOptions" | "trackerConfig" | "logger">,
  issue: NormalizedIssue,
): Promise<ClaimDecision> {
  if (!config.customWorkflows) {
    return { dispatch: true, claimed: false, reason: "flag-off" };
  }
  if (!tracker.claimIssue) {
    // A tracker with no write path cannot make a claim visible. That is a
    // configuration fact, not a race, so it must not silently block every
    // dispatch — but it is worth saying out loud once per ticket.
    config.logger?.warn(
      { issue: issue.identifier, tracker: tracker.kind },
      "custom_workflows on but tracker cannot claim tickets; dispatching unclaimed",
    );
    return { dispatch: true, claimed: false, reason: "tracker-cannot-claim" };
  }

  const options: ClaimDispatchOptions = config.claimOptions ?? {};
  try {
    const result = await tracker.claimIssue(
      {
        issueId: issue.id,
        assignee: options.assignee ?? "me",
        stateName: options.stateName,
      },
      { activeStates: config.trackerConfig.active_states },
    );
    if (!result.claimed) {
      config.logger?.info(
        { issue: issue.identifier, heldBy: result.heldBy, reason: result.reason },
        "ticket claim refused; another agent holds it",
      );
      return { dispatch: false, reason: result.reason ?? "already-claimed" };
    }
    return { dispatch: true, claimed: true };
  } catch (error) {
    config.logger?.warn(
      { issue: issue.identifier, err: error },
      "ticket claim failed; skipping dispatch (fail-closed)",
    );
    return { dispatch: false, reason: "claim-error" };
  }
}

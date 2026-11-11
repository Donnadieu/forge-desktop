import type { NormalizedIssue } from "../tracker/types.js";
import { liveSessionReason } from "./session-guard.js";
import type { OrchestratorState } from "./types.js";

/**
 * Count the agent slots currently occupied by in-flight work. A single agent's
 * slot is held across the whole lifecycle of a feature: while its worker runs
 * (`running`), while it's being prepared for dispatch (`claimed`), and while it
 * waits to resume after a failure or continuation (`retryAttempts`). Counting
 * only `running` would free the slot during the retry delay, letting a waiting
 * `approved` feature be dispatched against the same agent — see the cap=1 bug
 * this guards against. A killed worker whose process has not exited yet
 * (`settling`) still occupies its slot; when it also holds a retry reservation
 * the slot is counted once.
 */
export function inFlightCount(state: OrchestratorState): number {
  let settling = 0;
  for (const issueId of state.settling.keys()) {
    if (!state.retryAttempts.has(issueId)) settling++;
  }
  // Forge Desktop: a card waiting for its account's usage limit holds no slot (orchestrator/usage-limits.ts).
  let waitingForLimit = 0;
  for (const r of state.retryAttempts.values()) if (r.limitKey !== undefined) waitingForLimit++;
  return (
    state.running.size + state.claimed.size + state.retryAttempts.size - waitingForLimit + settling
  );
}

/**
 * Like `inFlightCount`, but discounts `issueId`'s own retry reservation if it
 * holds one. The retry-dispatch path uses this so a feature resuming from its
 * reservation doesn't count itself against the cap — only OTHER in-flight work
 * should block it.
 */
export function inFlightCountExcluding(state: OrchestratorState, issueId: string): number {
  const own = state.retryAttempts.get(issueId);
  return inFlightCount(state) - (own && own.limitKey === undefined ? 1 : 0);
}

/**
 * The most agents this engine may have in flight: its own `maxConcurrentAgents`, and (Forge Desktop) what's left
 * under the Mac-wide ceiling once the other engines' agents are counted (`agentLimit`).
 */
export function effectiveAgentLimit(
  config: { maxConcurrentAgents: number; agentLimit?: (inFlight: number) => number },
  inFlight: number,
): number {
  const shared = config.agentLimit?.(inFlight);
  return shared === undefined
    ? config.maxConcurrentAgents
    : Math.min(config.maxConcurrentAgents, shared);
}

/**
 * Rank a ticket's pipeline stage: further along the pipeline = higher number =
 * dispatched first. The order comes from `activeStates`, which callers list in
 * pipeline order (earliest first, e.g. `Todo` … `Merging`), so a later index
 * means a later stage. This is why `active_states` in WORKFLOW.md
 * MUST stay in pipeline order — dispatch priority is derived from it. A state
 * not present in `activeStates` (or when no ordering is supplied) ranks -1 so it
 * sorts after every known stage.
 */
function stageRank(state: string, activeStates: readonly string[] | undefined): number {
  if (!activeStates?.length) return -1;
  return activeStates.indexOf(state);
}

/**
 * Sort issues for dispatch. Primary key: pipeline stage DESC (tickets further
 * along the pipeline first, so anything ready to merge lands before new work is
 * started — then walk backwards through the earlier stages). Within a stage:
 * priority ASC (0=urgent first), then createdAt ASC (oldest first), then
 * identifier. `activeStates` supplies the pipeline order; omit it to fall back
 * to the priority/age ordering only.
 */
export function sortIssuesForDispatch(
  issues: NormalizedIssue[],
  activeStates?: readonly string[],
): NormalizedIssue[] {
  return [...issues].sort((a, b) => {
    const stageComp = stageRank(b.state, activeStates) - stageRank(a.state, activeStates);
    if (stageComp !== 0) return stageComp;
    const aPri = a.priority ?? Infinity;
    const bPri = b.priority ?? Infinity;
    if (aPri !== bPri) return aPri - bPri;
    const dateComp = a.createdAt.localeCompare(b.createdAt);
    if (dateComp !== 0) return dateComp;
    return a.identifier.localeCompare(b.identifier);
  });
}

/**
 * Check if an issue should be dispatched.
 */
export function shouldDispatchIssue(
  issue: NormalizedIssue,
  state: OrchestratorState,
  config: {
    active_states: string[];
    terminal_states: string[];
    max_concurrent_agents: number;
    max_concurrent_agents_by_state?: Record<string, number>;
  },
): boolean {
  // Running, claimed, or a killed worker still exiting (FRG-4086)
  if (liveSessionReason(state, issue.id)) return false;

  // Pending retry
  if (state.retryAttempts.has(issue.id)) return false;

  // Not in active state
  if (!config.active_states.includes(issue.state)) return false;

  // Check if blocked by non-terminal issues (only for Todo issues)
  if (hasNonTerminalBlockers(issue, config.terminal_states, issue.state)) return false;

  // Check concurrency limit against all in-flight slots (running + claimed +
  // pending retries), not just running — a feature mid-retry still owns its
  // agent slot.
  if (inFlightCount(state) >= config.max_concurrent_agents) return false;

  // Check per-state concurrency limit
  const perStateLimit = config.max_concurrent_agents_by_state?.[issue.state];
  if (perStateLimit !== undefined) {
    let countInState = 0;
    for (const [, entry] of state.running) {
      if (entry.issue.state === issue.state) countInState++;
    }
    if (countInState >= perStateLimit) return false;
  }

  return true;
}

/**
 * Check if any blocker is still in a non-terminal state.
 */
function hasNonTerminalBlockers(
  issue: NormalizedIssue,
  terminalStates: string[],
  issueState: string,
): boolean {
  // Only Todo issues are blocked; non-Todo issues with blockers are allowed to proceed
  if (issueState.trim().toLowerCase() !== "todo") return false;
  return issue.blockedBy.some(
    (b) => b.state != null && b.state !== "" && !terminalStates.includes(b.state),
  );
}

/**
 * How long a card whose claim was refused (someone else holds it) ranks last.
 * After that it gets one try at its normal rank, so a card the other holder
 * gave back is picked up again without waiting for the whole queue.
 */
export const CLAIM_REFUSED_BACKOFF_MS = 10 * 60 * 1000;

/** Remember that `issueId`'s claim was refused, dropping marks that expired. */
export function noteClaimRefused(
  state: OrchestratorState,
  issueId: string,
  now = Date.now(),
): void {
  for (const [id, at] of state.claimRefused) {
    if (now - at >= CLAIM_REFUSED_BACKOFF_MS) state.claimRefused.delete(id);
  }
  state.claimRefused.set(issueId, now);
}

/** Whether `issueId`'s claim was refused within the backoff window. */
export function claimRefusedRecently(
  state: OrchestratorState,
  issueId: string,
  now = Date.now(),
): boolean {
  const at = state.claimRefused.get(issueId);
  return at !== undefined && now - at < CLAIM_REFUSED_BACKOFF_MS;
}

/**
 * Select issues to dispatch from candidates.
 */
export function selectIssuesToDispatch(
  candidates: NormalizedIssue[],
  state: OrchestratorState,
  config: {
    active_states: string[];
    terminal_states: string[];
    max_concurrent_agents: number;
    max_concurrent_agents_by_state?: Record<string, number>;
    /** Forge Desktop: the card's account is at a usage limit, so it isn't started (usage-limits.ts). */
    limited?: (issue: NormalizedIssue) => boolean;
    /** Forge Desktop: the card waits on the person, its next stage has no column (parking.ts). */
    parked?: (issue: NormalizedIssue) => boolean;
  },
): NormalizedIssue[] {
  const sorted = sortIssuesForDispatch(candidates, config.active_states);
  // Issues whose workspace another live process holds go last (FRG-4527): they
  // are re-checked at the start of every tick, but cannot starve the rest.
  // Cards someone else holds (claim refused recently) go last too, for the same
  // reason: tried every poll at their stage's rank, they took the only free slot
  // and the cards behind them never ran.
  const now = Date.now();
  const last = (issue: NormalizedIssue) =>
    state.workspaceLocked.has(issue.id) || claimRefusedRecently(state, issue.id, now);
  sorted.sort((a, b) => Number(last(a)) - Number(last(b)));
  const selected: NormalizedIssue[] = [];
  // `inFlightCount` is loop-invariant: selected issues aren't registered in
  // `state` until after this function returns, so only `selected.length` grows.
  const baseInFlight = inFlightCount(state);

  for (const issue of sorted) {
    if (baseInFlight + selected.length >= config.max_concurrent_agents) break;
    if (config.limited?.(issue) || config.parked?.(issue)) continue;
    if (shouldDispatchIssue(issue, state, config)) {
      selected.push(issue);
    }
  }

  return selected;
}

export interface NormalizedIssue {
  id: string;
  identifier: string; // human-readable, e.g. "MT-123"
  title: string;
  description: string;
  state: string;
  priority: number | null; // 0 = urgent, 4 = none, null = unset
  assignee?: string;
  labels: string[];
  branchName?: string;
  url?: string;
  blockedBy: Array<{ id?: string; identifier?: string; state?: string }>;
  createdAt: string; // ISO 8601
  updatedAt: string;
  /**
   * A GitHub PR URL discovered on the issue (its own body/description, or —
   * for trackers that support it, e.g. Basecamp — its comments) that was NOT
   * necessarily opened by Forge itself. Set when a different process/bot/
   * human already attached real work to this ticket before Forge ever
   * dispatched it, so the agent can check that PR out instead of assuming
   * there is nothing to review and looping. Undefined when no PR link was
   * found anywhere Forge looked.
   */
  existingPrUrl?: string;
}

export interface TrackerConfig {
  kind: string;
  project_slug: string;
  active_states: string[];
  terminal_states: string[];
  /**
   * The subset of terminal states that mean SUCCESS (e.g. Linear "Done" /
   * "Closed"), as opposed to abandon ("Cancelled"/"Canceled"/"Duplicate"). The
   * orchestrator uses this so a ticket whose issue reached a done state while
   * its worker was mid-flight is recorded `completed`/`success`, not killed-and-
   * relabeled `cancelled`. Optional — consumers default to `["Done","Closed"]`.
   */
  done_states?: string[];
  api_key?: string;
  endpoint?: string;
  assignee?: string;
  /**
   * Optional label filter. When provided (non-empty), the tracker should only
   * return issues that carry at least one of the listed label NAMES (any-of
   * match). Empty/undefined ⇒ no filter (all issues pass).
   *
   * Adapters lowercase the filter before comparing, so casing in this array
   * does not matter. The matching contract is then adapter-specific:
   *   - `MemoryTracker` lowercases both sides — fully case-insensitive.
   *   - `LinearTracker` sends the lowercased filter to Linear's
   *     `labels: { name: { in: [...] } }` GraphQL clause, which matches
   *     server-side exact-case. The actual workspace labels must therefore
   *     also be lowercase for the filter to match. Smith mode's labels
   *     (`smith_feature` / `smith_bug`) follow this
   *     convention.
   *
   * Used by Smith mode (FRG-910) to scope the dispatcher to
   * `smith_feature`/`smith_bug` tickets.
   */
  labels?: string[];
}

export interface IssueComment {
  id: string;
  body: string;
  createdAt: string;
}

export interface CreateIssueArgs {
  /** Linear team UUID. */
  teamId: string;
  title: string;
  description: string;
  /** Label NAMES; resolved to IDs internally. */
  labels?: string[];
  /** Workflow state NAME (e.g. "Backlog"); resolved to stateId internally. */
  stateName?: string;
  /** Optional project bucket. */
  projectId?: string;
  /** 0..4 (0 = none, 1 = urgent). */
  priority?: number;
}

export interface CreateIssueResult {
  id: string;
  identifier: string;
  url: string;
}

/**
 * Caller-facing relation vocabulary. Linear's API uses `blocks` / `related`;
 * `blockedBy` is exposed for symmetry and translated to an inverse `blocks`
 * by the adapter so handlers can use whichever direction is more natural.
 */
export type IssueRelationType = "blocks" | "blockedBy" | "related";

/** Authoritative build-progress counts read straight from the tracker. */
export interface ProgressCounts {
  /** Total issues in the project (the build's full ticket scope). */
  total: number;
  /** Issues in a terminal state (Done/Closed/Cancelled/…) — the completed count. */
  done: number;
}

/**
 * A ticket claim (FRG-1988). Parallel agents must never hold the same ticket,
 * so pickup registers a visible claim in the tracker itself — assignment plus
 * (optionally) a workflow-state move — rather than in Forge-local memory.
 */
export interface ClaimIssueArgs {
  issueId: string;
  /**
   * Tracker identity the claim is registered under. `"me"` resolves to the
   * API key's viewer; anything else is passed through as a tracker user id.
   */
  assignee: string;
  /** Workflow state to move the ticket into as part of the claim. Optional. */
  stateName?: string;
}

/**
 * Outcome of a claim attempt. `claimed: false` is a normal, expected result —
 * it means another agent got there first — not an error. Errors (transport,
 * auth) reject instead, because callers must be able to tell "someone else
 * holds it" apart from "we do not know who holds it".
 */
export interface ClaimIssueOptions {
  /**
   * Workflow states the ticket may be claimed from. When provided, a ticket
   * that has moved out of this set between poll and pickup is refused with
   * `reason: "not-active"` instead of being claimed.
   */
  activeStates?: string[];
}

export interface ClaimResult {
  claimed: boolean;
  /** Tracker identity holding the ticket after the attempt, when known. */
  heldBy?: string;
  /** Why the claim was refused. Present only when `claimed` is false. */
  reason?: "already-claimed" | "lost-race" | "not-active";
}

export interface TrackerAdapter {
  readonly kind: string;
  /**
   * Every card in `states` for the app's board (Forge Desktop). Throws when the
   * tracker can't be reached. Optional: the board falls back to fetchCandidates.
   */
  fetchBoard?(config: TrackerConfig, states: string[]): Promise<BoardCard[]>;
  fetchCandidates(config: TrackerConfig): Promise<NormalizedIssue[]>;
  fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>>;
  fetchTerminalIssues(config: TrackerConfig): Promise<NormalizedIssue[]>;
  /**
   * Count the project's tickets directly from the tracker: `total` is every
   * issue in scope, `done` is the terminal subset. The tracker is the source of
   * truth, so this is a fresh read — callers must not accumulate or cache it.
   */
  fetchProgressCounts(config: TrackerConfig): Promise<ProgressCounts>;
  /**
   * Atomically claim an issue for this agent, making the claim visible in the
   * tracker. Optional — trackers without writes simply omit it, and callers
   * must decide for themselves whether an unclaimable tracker may dispatch.
   *
   * Implementations MUST verify the claim after writing it (compare-and-set),
   * not assume the write won. Returns `claimed: false` when another agent
   * holds the ticket; throws only on transport/auth failure.
   */
  claimIssue?(args: ClaimIssueArgs, options?: ClaimIssueOptions): Promise<ClaimResult>;
  /** Transition an issue to a named workflow state. Optional — not all trackers support writes. */
  updateIssueState?(issueId: string, stateName: string): Promise<void>;
  /** Create a comment on an issue. Returns the comment ID. Optional. */
  createComment?(issueId: string, body: string): Promise<string>;
  /** Fetch comments on an issue. Optional — not all trackers support reads. */
  fetchIssueComments?(issueId: string): Promise<IssueComment[]>;
  /** Create a new issue. Returns id/identifier/url. Optional. */
  createIssue?(args: CreateIssueArgs): Promise<CreateIssueResult>;
  /**
   * Link two issues. `from` and `to` are caller-facing; `blockedBy` is
   * translated to an inverse `blocks` relation by the adapter. Optional.
   */
  linkIssues?(fromIssueId: string, toIssueId: string, type: IssueRelationType): Promise<void>;
  /**
   * Fetch all "open" issues in a project by project id. Optional — used by the
   * Smith bug intake path to deduplicate against orphan Linear tickets.
   */
  fetchOpenProjectIssues?(projectId: string): Promise<NormalizedIssue[]>;
}

/** One card on the app's board (Forge Desktop). */
export interface BoardCard {
  id: string;
  identifier: string;
  title: string;
  state: string;
  url: string | null;
  assignee: string | null;
  branchName: string | null;
  /** The card's GitHub pull request, from the tracker's GitHub link on the card. */
  prUrl: string | null;
  priority: number | null;
  updatedAt: string;
}

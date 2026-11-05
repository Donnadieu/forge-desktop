/**
 * Backlog promotion: Forge moves cards out of `Backlog` itself.
 *
 * The workflow's state machine parks two kinds of card in `Backlog` and,
 * without this sweep, waits for a person to move each one out:
 *   - Untriaged cards (new work, follow-ups filed during a run). With
 *     `backlogToTriage` on, Forge moves them into `Triage` for a spike.
 *   - Triaged cards that came back from `Triage` marked ready for execution
 *     (the `ready-for-execution` label the triage skill adds). With
 *     `readyToTodo` on, Forge moves them into `Todo` to be built.
 *
 * Both rules are off unless the workflow file turns them on (`tracker.promote`;
 * the app writes it from the Workflow Studio screen).
 *
 * What keeps a card from looping or being taken from someone:
 *   - Backlog -> Triage only takes UNASSIGNED cards without the ready label.
 *     Triage dispatch claims the card (assigns Forge), so a card that has
 *     been triaged comes back to `Backlog` assigned and is never re-triaged.
 *     That is why this rule needs ticket claiming on (`resolveBacklogPromotion`).
 *     Cards a person holds stay where they are.
 *   - Backlog -> Todo only takes ready cards that are unassigned or held by
 *     Forge's own identity. A card someone else holds would be refused at
 *     claim time anyway, and in an active column it would starve dispatch.
 *   - `maxInTriage` caps how full `Triage` gets, so a large Backlog is fed
 *     into Triage a few cards at a time instead of all at once.
 *
 * The sweep is best-effort and never blocks dispatch: a failed read skips
 * the sweep, a failed move is logged and the next card is tried.
 */
import type { Logger } from "pino";
import type { NormalizedIssue, TrackerAdapter, TrackerConfig } from "../tracker/types.js";

export const BACKLOG_STATE = "Backlog";
export const TRIAGE_STATE = "Triage";
export const TODO_STATE = "Todo";

export interface BacklogPromotionConfig {
  /** Move unassigned, not-yet-ready Backlog cards into Triage. */
  backlogToTriage: boolean;
  /** Move Backlog cards that carry `readyLabel` into Todo. */
  readyToTodo: boolean;
  /** Label that marks a triaged card ready for execution (case-insensitive). */
  readyLabel: string;
  /** Stop moving cards into Triage once it holds this many. */
  maxInTriage: number;
  /** Minimum time between two sweeps. */
  intervalMs: number;
  /**
   * Forge's own tracker identity, when known. Ready cards held by anyone
   * else stay in Backlog. Unset ⇒ the ready rule ignores assignees and leaves
   * the decision to the dispatch-time claim.
   */
  identity?: string;
}

/** The workflow file's `tracker.promote` block, as parsed by the config schema. */
export interface PromoteSettings {
  backlog_to_triage: boolean;
  ready_to_todo: boolean;
  ready_label: string;
  max_in_triage: number;
  interval_ms: number;
}

/**
 * Turn the workflow file's block into orchestrator config, or `undefined` when
 * both rules are off (or the block is missing, e.g. a config assembled
 * without the schema's defaults). Backlog -> Triage is dropped (with a
 * warning) when ticket claiming is off: claiming is what marks a card as
 * already triaged, so without it a triaged card would go straight back to
 * Triage forever.
 */
export function resolveBacklogPromotion(
  settings: PromoteSettings | undefined,
  opts: { customWorkflows: boolean; identity?: string; logger?: Logger },
): BacklogPromotionConfig | undefined {
  if (!settings) return undefined;
  let backlogToTriage = settings.backlog_to_triage;
  if (backlogToTriage && !opts.customWorkflows) {
    opts.logger?.warn(
      "tracker.promote.backlog_to_triage needs ticket claiming (FORGE_CUSTOM_WORKFLOWS_ENABLED=true); leaving Backlog -> Triage off",
    );
    backlogToTriage = false;
  }
  if (!backlogToTriage && !settings.ready_to_todo) return undefined;
  return {
    backlogToTriage,
    readyToTodo: settings.ready_to_todo,
    readyLabel: settings.ready_label,
    maxInTriage: settings.max_in_triage,
    intervalMs: settings.interval_ms,
    identity: opts.identity,
  };
}

export interface PlannedMove {
  issue: NormalizedIssue;
  to: typeof TRIAGE_STATE | typeof TODO_STATE;
}

const sameState = (a: string, b: string) => a.trim().toLowerCase() === b.toLowerCase();

/**
 * Decide which Backlog cards move where. `issues` holds the cards in Backlog
 * and Triage, in the order the tracker returns them, and that order is kept.
 */
export function planBacklogPromotions(
  issues: NormalizedIssue[],
  config: BacklogPromotionConfig,
): PlannedMove[] {
  const readyLabel = config.readyLabel.trim().toLowerCase();
  const isReady = (issue: NormalizedIssue) =>
    issue.labels.some((label) => label.trim().toLowerCase() === readyLabel);
  const backlog = issues.filter((issue) => sameState(issue.state, BACKLOG_STATE));
  const moves: PlannedMove[] = [];

  if (config.readyToTodo) {
    for (const issue of backlog) {
      if (!isReady(issue)) continue;
      const heldByOther = issue.assignee && config.identity && issue.assignee !== config.identity;
      if (!heldByOther) moves.push({ issue, to: TODO_STATE });
    }
  }

  if (config.backlogToTriage) {
    const inTriage = issues.filter((issue) => sameState(issue.state, TRIAGE_STATE)).length;
    let room = config.maxInTriage - inTriage;
    for (const issue of backlog) {
      if (room <= 0) break;
      if (issue.assignee || isReady(issue)) continue;
      moves.push({ issue, to: TRIAGE_STATE });
      room -= 1;
    }
  }
  return moves;
}

export interface BacklogPromotionDeps {
  tracker: TrackerAdapter;
  trackerConfig: TrackerConfig;
  logger?: Logger;
}

/** Runs `planBacklogPromotions` from the poll loop, at most every `intervalMs`. */
export class BacklogPromoter {
  private lastSweepMs: number | null = null;

  constructor(
    private readonly config: BacklogPromotionConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns the moves that went through (empty when the sweep was skipped). */
  async maybePromote(deps: BacklogPromotionDeps): Promise<PlannedMove[]> {
    const { tracker, logger } = deps;
    if (!tracker.updateIssueState) return [];
    const nowMs = this.now();
    if (this.lastSweepMs !== null && nowMs - this.lastSweepMs < this.config.intervalMs) return [];
    this.lastSweepMs = nowMs;

    let issues: NormalizedIssue[];
    try {
      issues = await tracker.fetchCandidates({
        ...deps.trackerConfig,
        active_states: [BACKLOG_STATE, TRIAGE_STATE],
        assignee: undefined,
      });
    } catch (error) {
      logger?.warn({ err: error }, "backlog promotion: could not read Backlog; skipping sweep");
      return [];
    }

    const done: PlannedMove[] = [];
    for (const move of planBacklogPromotions(issues, this.config)) {
      try {
        await tracker.updateIssueState(move.issue.id, move.to);
        done.push(move);
        logger?.info(
          { issue: move.issue.identifier, from: BACKLOG_STATE, to: move.to },
          "backlog promotion: moved card",
        );
      } catch (error) {
        logger?.warn(
          { err: error, issue: move.issue.identifier, to: move.to },
          "backlog promotion: move failed",
        );
      }
    }
    return done;
  }
}

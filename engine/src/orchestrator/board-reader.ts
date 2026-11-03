/**
 * The app's board: every card in the pipeline's columns, read from the tracker
 * on each poll, merged with what the agents holding them are doing right now.
 *
 * New in Forge Desktop.
 */
import type { RunningSessionSnapshot } from "../observability/types.js";
import type {
  BoardCard,
  NormalizedIssue,
  TrackerAdapter,
  TrackerConfig,
} from "../tracker/types.js";

export interface BoardColumn {
  name: string;
  cards: Array<
    BoardCard & {
      /** One plain line about what the agent is doing, when an agent holds the card. */
      activity: string | null;
      agent: { started_at: string; turn: number; attempt: number } | null;
      helpers: Array<{ id: string; description: string; running: boolean }>;
      recent: Array<{ at: string; line: string }>;
    }
  >;
}

export interface BoardView {
  columns: BoardColumn[];
  read_at: string | null;
  /** Why the last read failed, in plain words; null when it worked. */
  problem: string | null;
}

function fromIssue(i: NormalizedIssue): BoardCard {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    state: i.state,
    url: i.url ?? null,
    assignee: i.assignee ?? null,
    branchName: i.branchName ?? null,
    prUrl: i.existingPrUrl ?? null,
    priority: i.priority,
    updatedAt: i.updatedAt,
  };
}

export class BoardReader {
  private cards: BoardCard[] = [];
  private readAt: string | null = null;
  private problem: string | null = null;
  private reading: Promise<void> | null = null;

  constructor(
    private readonly tracker: TrackerAdapter,
    private readonly config: TrackerConfig,
    private readonly columns: string[],
  ) {}

  /** Reads the board again. Concurrent calls share one read. */
  refresh(): Promise<void> {
    this.reading ??= this.read().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async read(): Promise<void> {
    try {
      this.cards = this.tracker.fetchBoard
        ? await this.tracker.fetchBoard(this.config, this.columns)
        : (await this.tracker.fetchCandidates({ ...this.config, active_states: this.columns })).map(
            fromIssue,
          );
      this.readAt = new Date().toISOString();
      this.problem = null;
    } catch (err) {
      this.problem = `Forge couldn't read the board from ${this.tracker.kind === "linear" ? "Linear" : this.tracker.kind}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  /** The card's workpad: the agent's one running note on the card (its comment that starts with a Workpad heading). */
  async workpad(cardId: string): Promise<{ workpad: string | null; comments: number }> {
    const comments = (await this.tracker.fetchIssueComments?.(cardId)) ?? [];
    const pad = comments.filter((c) => /^#{1,3}\s*(\w+\s+)?workpad\b/i.test(c.body.trim())).pop();
    return { workpad: pad?.body ?? null, comments: comments.length };
  }

  /** The board with each held card's live activity. Cards in columns not on the board are left out. */
  view(running: RunningSessionSnapshot[]): BoardView {
    const byId = new Map(running.map((r) => [r.issueId, r]));
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
    const columns: BoardColumn[] = this.columns.map((name) => ({ name, cards: [] }));
    const index = new Map(columns.map((c) => [norm(c.name), c]));
    for (const card of this.cards) {
      const run = byId.get(card.id);
      index.get(norm(run?.state ?? card.state))?.cards.push({
        ...card,
        activity: run ? run.activity || "Working" : null,
        agent: run
          ? { started_at: run.startedAt, turn: run.turnCount, attempt: run.attempt }
          : null,
        helpers: run?.helpers ?? [],
        recent: run?.recent ?? [],
      });
    }
    for (const c of columns) {
      c.cards.sort(
        (a, b) =>
          Number(b.agent !== null) - Number(a.agent !== null) ||
          (a.priority ?? 5) - (b.priority ?? 5),
      );
    }
    return { columns, read_at: this.readAt, problem: this.problem };
  }
}

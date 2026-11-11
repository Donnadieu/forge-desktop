/**
 * The columns the person's board really has. Shared team boards often lack
 * Forge's optional columns (AI Review, QA, Human Review, Rework, Merging), and
 * nobody wants Forge adding columns the whole team sees. So Forge never moves a
 * card into a column that isn't there: `guardMoves` refuses before the tracker
 * is called, and the board view tells the app which columns exist, so Workflow
 * Studio turns a stage back on once its column shows up.
 *
 * New in Forge Desktop.
 */
import type { TrackerAdapter, TrackerConfig } from "./types.js";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

export class BoardColumns {
  private names: string[] | null = null;
  private readAtMs: number | null = null;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly tracker: TrackerAdapter,
    private readonly config: TrackerConfig,
    opts: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** The board's column names; null when the tracker can't list them (then nothing is guarded). */
  async present(): Promise<string[] | null> {
    if (!this.tracker.fetchColumns) return null;
    const fresh = this.readAtMs !== null && this.now() - this.readAtMs < this.ttlMs;
    if (!fresh) {
      try {
        const names = await this.tracker.fetchColumns(this.config);
        // An empty list means the tracker doesn't know (an old setup): guard nothing rather than everything.
        this.names = names.length > 0 ? names : null;
        this.readAtMs = this.now();
      } catch {
        // Keep the last known columns; a failed read never blocks a move on its own.
      }
    }
    return this.names;
  }

  /** The last columns read, without reading again (the board view). */
  known(): string[] | null {
    return this.names;
  }

  /** True only when the board's columns are known and `name` isn't one of them. */
  async missing(name: string): Promise<boolean> {
    const names = await this.present();
    return names !== null && !names.some((n) => norm(n) === norm(name));
  }
}

/** The plain-words refusal for a move into a column the board doesn't have. */
export function missingColumnProblem(name: string): string {
  return `This board has no ${name} column.`;
}

/** The tracker, except that a move into a column the board doesn't have is refused before it's sent. */
export function guardMoves(tracker: TrackerAdapter, columns: BoardColumns): TrackerAdapter {
  const move = tracker.updateIssueState?.bind(tracker);
  if (!move) return tracker;
  return new Proxy(tracker, {
    get(target, prop, receiver) {
      if (prop === "updateIssueState") {
        return async (issueId: string, stateName: string) => {
          if (await columns.missing(stateName))
            throw new Error(missingColumnProblem(stateName).slice(0, -1));
          return move(issueId, stateName);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

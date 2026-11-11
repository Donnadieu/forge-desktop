import type {
  ClaimIssueArgs,
  ClaimResult,
  IssueComment,
  NormalizedIssue,
  ProgressCounts,
  TrackerAdapter,
  TrackerConfig,
} from "./types.js";

/**
 * Apply a `labels` filter from `TrackerConfig` to an issue. Returns true when
 * the filter is empty/undefined (no-op) or when at least one of the issue's
 * labels matches the filter (case-insensitive any-of).
 *
 * Case-sensitivity caveat: the Linear adapter pushes a lowercased filter into
 * Linear's `labels: { name: { in: [...] } }` GraphQL — Linear is
 * case-sensitive on the wire, so the actual workspace labels MUST be lowercase
 * (matches the Smith convention `smith_feature` / `smith_bug`).
 * MemoryTracker is fully case-insensitive on both sides for ergonomic test
 * fixtures.
 */
function matchesLabelFilter(issueLabels: string[], filter: string[] | undefined): boolean {
  if (!filter || filter.length === 0) return true;
  const wanted = new Set(filter.map((l) => l.trim().toLowerCase()).filter((l) => l.length > 0));
  if (wanted.size === 0) return true;
  return issueLabels.some((l) => wanted.has(l.toLowerCase()));
}

export class MemoryTracker implements TrackerAdapter {
  readonly kind = "memory";
  private issues: NormalizedIssue[] = [];
  private comments = new Map<string, Array<{ id: string; body: string }>>();
  private commentCounter = 0;

  private readonly columns: string[] | undefined;

  /** `columns`: the board's columns, for tests of missing ones; without it the board can't list them. */
  constructor(issues?: NormalizedIssue[], opts?: { columns?: string[] }) {
    if (issues) this.issues = [...issues];
    this.columns = opts?.columns;
    if (this.columns) {
      const names = [...this.columns];
      this.fetchColumns = async () => [...names];
    }
  }

  fetchColumns?: (config: TrackerConfig) => Promise<string[]>;

  addIssue(issue: NormalizedIssue): void {
    this.issues.push(issue);
  }

  /**
   * In-memory analogue of the Linear compare-and-set. Single-process and
   * synchronous, so the "re-read" is trivially the same object — but the
   * refuse-if-held-by-someone-else contract is identical, which is what the
   * dispatch-gate tests exercise.
   */
  async claimIssue(args: ClaimIssueArgs): Promise<ClaimResult> {
    const issue = this.issues.find((i) => i.id === args.issueId);
    if (!issue) return { claimed: false, reason: "not-active" };
    if (issue.assignee && issue.assignee !== args.assignee) {
      return { claimed: false, heldBy: issue.assignee, reason: "already-claimed" };
    }
    issue.assignee = args.assignee;
    if (args.stateName) issue.state = args.stateName;
    return { claimed: true, heldBy: args.assignee };
  }

  async updateIssueState(id: string, state: string): Promise<void> {
    const issue = this.issues.find((i) => i.id === id);
    if (issue) issue.state = state;
  }

  async createComment(issueId: string, body: string): Promise<string> {
    const commentId = `comment-${++this.commentCounter}`;
    const existing = this.comments.get(issueId) ?? [];
    existing.push({ id: commentId, body });
    this.comments.set(issueId, existing);
    return commentId;
  }

  getComments(issueId: string): Array<{ id: string; body: string }> {
    return this.comments.get(issueId) ?? [];
  }

  getIssue(id: string): NormalizedIssue | undefined {
    return this.issues.find((i) => i.id === id);
  }

  async fetchCandidates(config: TrackerConfig): Promise<NormalizedIssue[]> {
    return this.issues
      .filter((i) => config.active_states.includes(i.state))
      .filter((i) => matchesLabelFilter(i.labels, config.labels));
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const id of ids) {
      const issue = this.issues.find((i) => i.id === id);
      if (issue) result.set(id, issue.state);
    }
    return result;
  }

  async fetchTerminalIssues(config: TrackerConfig): Promise<NormalizedIssue[]> {
    return this.issues
      .filter((i) => config.terminal_states.includes(i.state))
      .filter((i) => matchesLabelFilter(i.labels, config.labels));
  }

  async fetchProgressCounts(config: TrackerConfig): Promise<ProgressCounts> {
    const inScope = this.issues.filter((i) => matchesLabelFilter(i.labels, config.labels));
    const done = inScope.filter((i) => config.terminal_states.includes(i.state)).length;
    return { total: inScope.length, done };
  }

  async fetchIssueComments(issueId: string): Promise<IssueComment[]> {
    return (this.comments.get(issueId) ?? []).map((c) => ({
      ...c,
      createdAt: new Date().toISOString(),
    }));
  }
}

/**
 * GitHub Issues as Forge's board, through a GitHub Projects (v2) board: the
 * project's Status field is the column, the issue carries the assignees,
 * labels (`ready-for-execution` after triage) and comments (the workpad), and
 * the pull request that closes the issue is the card's pull request.
 *
 * A card's id is the issue's node id. Moving a card sets the Status of the
 * issue's item on this project (adding the issue to the project first if it
 * isn't there). Claiming assigns the signed-in person, compare-and-set like
 * Linear and Basecamp: read, refuse if someone else holds it, write, re-read.
 *
 * New in Forge Desktop.
 */
import { BASECAMP_STAGE_NAMES, resolveStage } from "./basecamp-normalize.js";
import type { BasecampTokenProvider } from "./basecamp-token-provider.js";
import {
  ADD_ASSIGNEE,
  ADD_COMMENT,
  ADD_TO_PROJECT,
  boardCard,
  COMMENTS,
  ISSUES_BY_ID,
  normalizeIssue,
  PROJECT_ITEMS,
  placement,
  type RawIssue,
  REMOVE_ASSIGNEE,
  SET_STATUS,
  stageFor,
  VIEWER,
} from "./github-queries.js";
import type {
  BoardCard,
  ClaimIssueArgs,
  ClaimIssueOptions,
  ClaimResult,
  IssueComment,
  NormalizedIssue,
  ProgressCounts,
  TrackerAdapter,
  TrackerConfig,
} from "./types.js";

export interface GitHubAdapterOptions {
  /** GraphQL endpoint (default https://api.github.com/graphql). */
  endpoint?: string;
  /** The project's node id (`PVT_…`). */
  projectId: string;
  /** The project's Status field id (single select). */
  statusFieldId: string;
  /** Pipeline column name -> Status option id. */
  columns: Record<string, string>;
  /** The token for the person Forge acts as (needs the `repo` and `project` scopes). */
  tokenProvider: BasecampTokenProvider;
}

export class GitHubGraphQLError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubGraphQLError";
  }
}

const USER_AGENT = "Forge Desktop (https://github.com/Donnadieu/forge-desktop)";
const MAX_PAGES = 40;

interface Located {
  issue: RawIssue;
  state: string;
}

export class GitHubTracker implements TrackerAdapter {
  readonly kind = "github";
  private readonly endpoint: string;
  private viewer: { id: string; login: string } | null = null;

  constructor(private readonly opts: GitHubAdapterOptions) {
    this.endpoint = opts.endpoint || "https://api.github.com/graphql";
  }

  /** One GraphQL call. A 401 asks the token command again once. */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const send = async (forceRefresh: boolean) => {
      const token = await this.opts.tokenProvider.getAccessToken({ forceRefresh });
      if (!token) throw new GitHubGraphQLError("GitHub sign-in needed: no token");
      return fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({ query, variables }),
      });
    };
    let response = await send(false);
    if (response.status === 401) response = await send(true);
    if (response.status === 401) {
      throw new GitHubGraphQLError("GitHub sign-in needed: GitHub didn't accept it", 401);
    }
    if (!response.ok)
      throw new GitHubGraphQLError(`GitHub answered ${response.status}`, response.status);
    const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      throw new GitHubGraphQLError(`GitHub said: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    return json.data as T;
  }

  /** The signed-in person: who "me" is when claiming. */
  async me(): Promise<{ id: string; login: string }> {
    this.viewer ??= (await this.graphql<{ viewer: { id: string; login: string } }>(VIEWER)).viewer;
    return this.viewer;
  }

  private stateOf(issue: RawIssue): string | null {
    const at = placement(issue, this.opts.projectId, this.opts.statusFieldId);
    return at ? stageFor(at.optionId, this.opts.columns) : null;
  }

  /** Every issue on the project that sits in a mapped column. */
  private async readProject(): Promise<Located[]> {
    const out: Located[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      type Page = {
        node: {
          items: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{ content: RawIssue | null }>;
          };
        } | null;
      };
      const data: Page = await this.graphql<Page>(PROJECT_ITEMS, {
        project: this.opts.projectId,
        after,
      });
      if (!data.node) throw new GitHubGraphQLError("GitHub couldn't find the project");
      for (const item of data.node.items.nodes) {
        const issue = item.content;
        if (issue?.__typename !== "Issue") continue;
        const state = this.stateOf(issue);
        if (state) out.push({ issue, state });
      }
      if (!data.node.items.pageInfo.hasNextPage) break;
      after = data.node.items.pageInfo.endCursor;
    }
    return out;
  }

  private async issues(ids: string[]): Promise<RawIssue[]> {
    if (ids.length === 0) return [];
    const data = await this.graphql<{ nodes: Array<RawIssue | null> }>(ISSUES_BY_ID, { ids });
    return data.nodes.filter((n): n is RawIssue => n?.__typename === "Issue");
  }

  private async issue(id: string): Promise<RawIssue> {
    const [found] = await this.issues([id]);
    if (!found) throw new GitHubGraphQLError(`GitHub couldn't find issue ${id}`);
    return found;
  }

  private static inStates(state: string, names: string[]): boolean {
    const want = new Set(names.map((n) => resolveStage(n) ?? n));
    return want.has(state);
  }

  async fetchBoard(_config: TrackerConfig, states: string[]): Promise<BoardCard[]> {
    const all = await this.readProject();
    return all
      .filter((l) => GitHubTracker.inStates(l.state, states))
      .map((l) => boardCard(l.issue, l.state));
  }

  async fetchCandidates(config: TrackerConfig): Promise<NormalizedIssue[]> {
    const assignee =
      config.assignee?.toLowerCase() === "me" ? (await this.me()).login : config.assignee;
    const labels = (config.labels ?? []).map((l) => l.toLowerCase());
    return (await this.readProject())
      .filter((l) => GitHubTracker.inStates(l.state, config.active_states))
      .map((l) => normalizeIssue(l.issue, l.state))
      .filter((i) => !assignee || i.assignee === assignee)
      .filter((i) => labels.length === 0 || i.labels.some((l) => labels.includes(l)));
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const issue of await this.issues(ids)) {
      const state = this.stateOf(issue);
      if (state) map.set(issue.id, state);
    }
    return map;
  }

  async fetchTerminalIssues(config: TrackerConfig): Promise<NormalizedIssue[]> {
    return (await this.readProject())
      .filter((l) => GitHubTracker.inStates(l.state, config.terminal_states))
      .map((l) => normalizeIssue(l.issue, l.state));
  }

  async fetchProgressCounts(config: TrackerConfig): Promise<ProgressCounts> {
    const all = await this.readProject();
    const done = all.filter((l) => GitHubTracker.inStates(l.state, config.terminal_states));
    return { total: all.length, done: done.length };
  }

  async claimIssue(args: ClaimIssueArgs, options?: ClaimIssueOptions): Promise<ClaimResult> {
    const me = await this.me();
    const target = args.assignee.toLowerCase() === "me" ? me.login : args.assignee;
    const before = await this.issue(args.issueId);
    const other = before.assignees.nodes.find((a) => a.login !== target);
    if (other) return { claimed: false, heldBy: other.login, reason: "already-claimed" };
    const state = this.stateOf(before);
    if (
      options?.activeStates?.length &&
      state &&
      !GitHubTracker.inStates(state, options.activeStates)
    ) {
      return { claimed: false, reason: "not-active" };
    }
    if (target !== me.login) {
      throw new GitHubGraphQLError("Forge can only claim GitHub issues as the signed-in person");
    }
    await this.graphql(ADD_ASSIGNEE, { issue: args.issueId, users: [me.id] });
    const after = await this.issue(args.issueId);
    const lost = after.assignees.nodes.find((a) => a.login !== target);
    if (lost) return { claimed: false, heldBy: lost.login, reason: "lost-race" };
    return { claimed: true, heldBy: target };
  }

  /** Moves the issue's card to the column named `stateName` (Done's aliases fold into Done). */
  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    const stage = resolveStage(stateName);
    const option = stage ? this.opts.columns[stage] : undefined;
    if (!stage || !option) {
      throw new GitHubGraphQLError(
        `The project has no Status for "${stateName}" (expected one of ${BASECAMP_STAGE_NAMES.join(", ")})`,
      );
    }
    const issue = await this.issue(issueId);
    let itemId = placement(issue, this.opts.projectId, this.opts.statusFieldId)?.itemId;
    if (!itemId) {
      const added = await this.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
        ADD_TO_PROJECT,
        { project: this.opts.projectId, content: issueId },
      );
      itemId = added.addProjectV2ItemById.item.id;
    }
    await this.graphql(SET_STATUS, {
      project: this.opts.projectId,
      item: itemId,
      field: this.opts.statusFieldId,
      option,
    });
  }

  /** Releases a claim: takes the signed-in person off the issue. */
  async unassignIssue(issueId: string): Promise<void> {
    await this.graphql(REMOVE_ASSIGNEE, { issue: issueId, users: [(await this.me()).id] });
  }

  async createComment(issueId: string, body: string): Promise<string> {
    const data = await this.graphql<{ addComment: { commentEdge: { node: { id: string } } } }>(
      ADD_COMMENT,
      { issue: issueId, body },
    );
    return data.addComment.commentEdge.node.id;
  }

  async fetchIssueComments(issueId: string): Promise<IssueComment[]> {
    const out: IssueComment[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      type Page = {
        node: {
          comments: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{ id: string; body: string; createdAt: string }>;
          };
        } | null;
      };
      const data: Page = await this.graphql<Page>(COMMENTS, { issue: issueId, after });
      if (!data.node) break;
      out.push(
        ...data.node.comments.nodes.map((c) => ({
          id: c.id,
          body: c.body,
          createdAt: c.createdAt,
        })),
      );
      if (!data.node.comments.pageInfo.hasNextPage) break;
      after = data.node.comments.pageInfo.endCursor;
    }
    return out;
  }
}

import { BasecampBoard } from "./basecamp-board.js";
import { claimBasecampIssue } from "./basecamp-claim.js";
import { BasecampHttpError } from "./basecamp-errors.js";
import type { BasecampStageName } from "./basecamp-normalize.js";
import { parseNextLink } from "./basecamp-paginate.js";
import {
  fetchCandidates as fetchCandidatesRead,
  fetchIssueStatesByIds as fetchIssueStatesByIdsRead,
  fetchProgressCounts as fetchProgressCountsRead,
  fetchTerminalIssues as fetchTerminalIssuesRead,
} from "./basecamp-reads.js";
import {
  type BasecampTokenProvider,
  StaticBasecampTokenProvider,
} from "./basecamp-token-provider.js";
import { BasecampWriteClient } from "./basecamp-writes.js";
import { PLAIN_USER_AGENT } from "./marks.js";
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

export { BasecampHttpError } from "./basecamp-errors.js";
export { BASECAMP_STAGE_NAMES, type BasecampStageName } from "./basecamp-normalize.js";
export {
  BasecampAuthRequiredError,
  type BasecampTokenProvider,
  type BasecampTokenSnapshot,
  createCliDelegatedRefreshFn,
  createCommandTokenFn,
  createOAuthRefreshFn,
  RefreshingBasecampTokenProvider,
  StaticBasecampTokenProvider,
} from "./basecamp-token-provider.js";

/**
 * CORRECTION (confirmed live against the real ConstructEase Basecamp
 * account): an earlier version of this adapter assumed Basecamp "has no
 * single resource that is both assignable and stage-tracked" and worked
 * around that with a `cardId:todoId` compound issue id plus an HTML-comment
 * marker (`<!-- forge-todo-id: N -->`) embedded in the card's `content`
 * field to cross-reference the two. That premise was wrong: a Basecamp Card
 * Table card (`GET /buckets/{project}/card_tables/cards/{id}.json`) carries
 * its own native `assignees` array directly on the card object — e.g. a
 * real ConstructEase card shows `"assignees": [{"id": 52942343, ...}]` — and
 * is simultaneously stage-tracked via its column. A card is one object that
 * is both assignable and stage-tracked; there was never a need for a
 * separate to-do lookup for Forge-scoped work that lives on the card table.
 * The compound id and marker have been removed: a Forge-scoped Basecamp
 * issue id IS the card's own id, full stop. Claim reads/writes the card's
 * `assignee_ids` directly (`basecamp-claim.ts`); state transitions move the
 * card's column (`basecamp-writes.ts`); comments post to the card's own
 * `recordings/{cardId}/comments.json`.
 *
 * This also corrects the writeback assumption that a to-do always exists
 * alongside a card. A card created standalone (not from converting an
 * existing to-do) has no to-do to mark complete, so `updateIssueState`
 * no longer tries to complete one — moving the card to `Done` is itself the
 * full completion signal; there is nothing else to update. (The flat to-do
 * LISTS used for the migration backlog are still correctly flat/stage-less
 * per the design doc — that part is unaffected; this correction is scoped
 * to cards on the Forge Card Table.)
 *
 * Low-level request executor shared by the sibling read/write/claim modules —
 * decouples them from `BasecampTracker`'s private `fetch` wiring, same role
 * `LinearGraphQLExecutor` plays for the Linear adapter's siblings.
 */
export type BasecampExecutor = <T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<{ data: T; nextPath: string | null }>;

/**
 * Per-project configuration a `BasecampTracker` instance is scoped to. Unlike
 * Linear (one API key reaches every team/project Linear-side), Basecamp's
 * Card Table setup is per-project (design doc, "Setup requirement, confirmed
 * real") — one dedicated Card Table with its ten columns must exist before
 * any of this works, so a tracker instance is wired to one project's column
 * ids at construction time, the same way it is wired to one endpoint/token.
 */
export interface BasecampAdapterOptions {
  /** Basecamp API base, e.g. `https://3.basecampapi.com`. */
  endpoint?: string;
  /** OAuth2 bearer access token, obtained once via the CLI's device-code flow. */
  apiKey?: string;
  /** Numeric Basecamp account id (the path segment after the API base). */
  accountId?: string;
  /** The project (bucket) id this tracker instance is scoped to. */
  projectId?: string;
  /**
   * Forge's own Basecamp person id. Resolves `assignee: "me"` in
   * `claimIssue`/`fetchCandidates` — required per the design doc's flagged
   * gap #2 (a dedicated Forge identity, not Omar's own account).
   */
  identityId?: string;
  /** WORKFLOW.md stage name -> Basecamp Card Table column id. */
  columns?: Partial<Record<BasecampStageName, string>>;
  /**
   * The Card Table's own id (distinct from any column id or the project
   * bucket id). Required for `moveCard`'s dedicated move endpoint — see
   * `basecamp-writes.ts`'s header comment for why a bare card PUT does not
   * work moving a card out of this project's "Backlog" column.
   */
  cardTableId?: string;
  /**
   * Resolves/refreshes the bearer token used on every request. When set,
   * takes priority over the plain `apiKey`/second constructor argument —
   * callers that only have a static key keep working unchanged (wrapped in
   * `StaticBasecampTokenProvider` by `createTrackerFromConfig`).
   */
  tokenProvider?: BasecampTokenProvider;
}

const DEFAULT_ENDPOINT = "https://3.basecampapi.com";
const USER_AGENT = PLAIN_USER_AGENT;

export class BasecampTracker implements TrackerAdapter {
  readonly kind = "basecamp";
  private readonly endpoint: string;
  private readonly tokenProvider: BasecampTokenProvider;
  private readonly accountId: string;
  private readonly projectId: string;
  private readonly identityId: string | undefined;
  private readonly columns: Partial<Record<BasecampStageName, string>>;
  private readonly writes: BasecampWriteClient;
  private readonly board: BasecampBoard;

  constructor(endpoint?: string, apiKey?: string, options?: BasecampAdapterOptions) {
    this.endpoint = endpoint || options?.endpoint || DEFAULT_ENDPOINT;
    const staticKey = apiKey || options?.apiKey || "";
    this.tokenProvider = options?.tokenProvider ?? new StaticBasecampTokenProvider(staticKey);
    this.accountId = options?.accountId || "";
    this.projectId = options?.projectId || "";
    this.identityId = options?.identityId;
    this.columns = options?.columns || {};
    this.writes = new BasecampWriteClient(
      (method, path, body) => this.request(method, path, body),
      this.projectId,
      this.columns,
      options?.cardTableId || "",
    );
    this.board = new BasecampBoard(
      (method, path, body) => this.request(method, path, body),
      this.projectId,
      this.columns,
    );
  }

  /**
   * Safe-to-display auth status (no token values), when the configured
   * token provider exposes one. Only `RefreshingBasecampTokenProvider` does;
   * a static key has no refresh/expiry state to report.
   */
  get authStatus(): { ok: boolean; message?: string; expiresAt?: string } | undefined {
    const provider = this.tokenProvider as { status?: { ok: boolean; message?: string } };
    return provider.status;
  }

  private resolveAssignee = async (assignee: string): Promise<string> => {
    if (assignee.trim().toLowerCase() !== "me") return assignee;
    if (!this.identityId) {
      throw new Error(
        'Basecamp identityId is required to resolve assignee "me" — configure Forge\'s dedicated Basecamp person id',
      );
    }
    return this.identityId;
  };

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ data: T; nextPath: string | null }> {
    if (!this.accountId) {
      throw new Error("Basecamp account id is required");
    }

    const url = path.startsWith("http") ? path : `${this.endpoint}/${this.accountId}${path}`;
    const doFetch = async (forceRefresh: boolean) => {
      const token = await this.tokenProvider.getAccessToken({ forceRefresh });
      if (!token) {
        throw new Error("Basecamp API token is required");
      }
      return fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": USER_AGENT,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    };

    let response = await doFetch(false);
    // A 401 can mean the access token expired between our last proactive
    // refresh and now (the orchestrator's poll interval can outlast the
    // ~1hr token window). Refresh once and retry once; a second 401, or the
    // refresh itself failing, is a real auth problem — propagate it (the
    // refresh failure already carries a "Basecamp sign-in needed" message).
    if (response.status === 401) {
      response = await doFetch(true);
    }

    if (!response.ok) {
      throw new BasecampHttpError(response.status, response.statusText);
    }

    const text = await response.text();
    const data = (text ? JSON.parse(text) : undefined) as T;
    // The `next` URL in Basecamp's Link header includes the account id
    // (e.g. https://3.basecampapi.com/6068025/buckets/...), so the base to
    // strip must include it too — stripping only `this.endpoint` leaves the
    // account id in `nextPath`, which then gets double-prepended on the next
    // call's `${this.endpoint}/${this.accountId}${path}` (verified against
    // the live API: a column with more than one page of cards 404s on page
    // 2 without this fix, since no column had exceeded a page before).
    const nextPath = parseNextLink(
      response.headers.get("Link"),
      `${this.endpoint}/${this.accountId}`,
    );
    return { data, nextPath };
  }

  /** Every card in `states`' columns, for the app's board. Throws when Basecamp can't be reached. */
  fetchBoard(_config: TrackerConfig, states: string[]): Promise<BoardCard[]> {
    return this.board.read(states);
  }

  async fetchCandidates(config: TrackerConfig): Promise<NormalizedIssue[]> {
    const resolvedAssignee = config.assignee
      ? await this.resolveAssignee(config.assignee)
      : undefined;
    return fetchCandidatesRead(
      (m, p, b) => this.request(m, p, b),
      this.projectId,
      this.columns,
      config,
      resolvedAssignee,
    );
  }

  fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>> {
    return fetchIssueStatesByIdsRead((m, p, b) => this.request(m, p, b), this.projectId, ids);
  }

  fetchTerminalIssues(config: TrackerConfig): Promise<NormalizedIssue[]> {
    return fetchTerminalIssuesRead(
      (m, p, b) => this.request(m, p, b),
      this.projectId,
      this.columns,
      config,
    );
  }

  /**
   * Count the project's build-scoped cards straight from Basecamp (see
   * `fetchProgressCounts` in `basecamp-reads.ts`). Basecamp is the source of
   * truth for build progress, so this is a fresh read with no local counter.
   */
  fetchProgressCounts(config: TrackerConfig): Promise<ProgressCounts> {
    return fetchProgressCountsRead(
      (m, p, b) => this.request(m, p, b),
      this.projectId,
      this.columns,
      config,
    );
  }

  /**
   * Claim an issue for this agent (design doc, "Collision-avoidance (claim)
   * — final recommendation"). Delegates to the compare-and-set helper — see
   * `basecamp-claim.ts` for why a single write is not enough. Operates
   * directly on the card's own `assignee_ids` (see this file's header
   * comment for why no separate to-do lookup is needed).
   */
  claimIssue(args: ClaimIssueArgs, options?: ClaimIssueOptions): Promise<ClaimResult> {
    return claimBasecampIssue(
      (m, p, b) => this.request(m, p, b),
      this.projectId,
      this.resolveAssignee,
      args,
      options,
    );
  }

  /**
   * Move an issue's card to the column matching `stateName` (design doc,
   * "State mapping"). Moving to `Done` is itself the full writeback — see
   * this file's header comment for why there is no separate to-do to
   * complete. See `basecamp-writes.ts`.
   */
  updateIssueState(issueId: string, stateName: string): Promise<void> {
    return this.writes.updateIssueState(issueId, stateName);
  }

  /**
   * Release a claim without finishing the work. Not part of the
   * `TrackerAdapter` contract (no other adapter needs an explicit un-claim),
   * but Basecamp's own writeback contract calls for it on a give-up path
   * (design doc, "Writeback", step 3).
   */
  unassignIssue(issueId: string): Promise<void> {
    return this.writes.unassignIssue(issueId);
  }

  createComment(issueId: string, body: string): Promise<string> {
    return this.writes.createComment(issueId, body);
  }

  fetchIssueComments(issueId: string): Promise<IssueComment[]> {
    return this.writes.fetchIssueComments(issueId);
  }
}

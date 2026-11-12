/**
 * A session's pull request through `gh`, with the GitHub account that reaches the repo: its number, state and what
 * GitHub says about merging it (mergeable, merge state, review decision, checks and which are required, unresolved
 * review threads per file), the one status the Changes panel shows, the review threads to pull into a chat, the
 * merge, and the panel's small fixes (update the branch, mark it ready for review).
 *
 * New in Forge Desktop.
 */
import { run } from "./git.js";

export interface Check {
  name: string;
  /** The conclusion once it finished, else its status (QUEUED, IN_PROGRESS, PENDING, EXPECTED). */
  state: string;
  url: string;
  /** A rule on the base branch needs this check to pass. */
  required: boolean;
}

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  state: string;
  url: string;
  isDraft: boolean;
  /** MERGEABLE, CONFLICTING or UNKNOWN (GitHub works it out lazily: ask again). */
  mergeable: string;
  /** CLEAN, BEHIND, BLOCKED, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT or UNKNOWN. */
  mergeStateStatus: string;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or "" (no review rule). */
  reviewDecision: string;
  /** Who asked for changes, from each reviewer's latest review. */
  changesRequestedBy: string[];
  base: string;
  headOid: string;
  checks: Check[];
  /** Unresolved review threads, and how many of them sit on each file. */
  unresolved: number;
  threadsByPath: Record<string, number>;
}

export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  author: string;
  body: string;
  url: string;
  resolved: boolean;
  outdated: boolean;
}

function env(token: string | null): NodeJS.ProcessEnv {
  return token ? { ...process.env, GH_TOKEN: token } : process.env;
}

type J = Record<string, unknown>;
const nodes = (v: unknown): J[] => ((v as { nodes?: J[] } | null | undefined)?.nodes ?? []) as J[];
const REPO = /^[\w.-]+\/[\w.-]+$/;

async function graphql(
  query: string,
  vars: Record<string, string | number>,
  token: string | null,
): Promise<J | null> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars))
    args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  const r = await run("gh", args, process.cwd(), env(token), 30_000);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out) as J;
  } catch {
    return null;
  }
}

const FIND = `query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){pullRequests(headRefName:$branch,first:1,orderBy:{field:CREATED_AT,direction:DESC}){nodes{number}}}}`;

/** Everything the Changes panel's one status comes from, in one call (engine/test/fixtures/github/pr-states). */
export const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id number title url state isDraft mergeable mergeStateStatus reviewDecision baseRefName headRefOid latestReviews(first:30){nodes{state author{login}}} commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion detailsUrl isRequired(pullRequestNumber:$number)} ... on StatusContext{context state targetUrl isRequired(pullRequestNumber:$number)}}}}}}} reviewThreads(first:100){nodes{isResolved path}}}}}`;

/** GitHub's answer to PR_QUERY, as the app reads it. Null when the pull request isn't in it. */
export function parsePullRequest(answer: unknown): PullRequest | null {
  const repo = ((answer as J | null)?.data as J | undefined)?.repository as J | undefined;
  const pr = repo?.pullRequest as J | null | undefined;
  if (!pr) return null;
  const rollup = (nodes(pr.commits)[0]?.commit as J | undefined)?.statusCheckRollup as J | null;
  const checks: Check[] = nodes(rollup?.contexts).map((c) =>
    c.__typename === "StatusContext"
      ? {
          name: String(c.context ?? "status"),
          state: String(c.state ?? ""),
          url: String(c.targetUrl ?? ""),
          required: c.isRequired === true,
        }
      : {
          name: String(c.name ?? "check"),
          state: String(c.status === "COMPLETED" ? c.conclusion || "" : c.status || ""),
          url: String(c.detailsUrl ?? ""),
          required: c.isRequired === true,
        },
  );
  const open = nodes(pr.reviewThreads).filter((t) => t.isResolved !== true);
  const threadsByPath: Record<string, number> = {};
  for (const t of open) {
    const path = String(t.path ?? "");
    threadsByPath[path] = (threadsByPath[path] ?? 0) + 1;
  }
  return {
    id: String(pr.id ?? ""),
    number: Number(pr.number),
    title: String(pr.title ?? ""),
    state: String(pr.state ?? ""),
    url: String(pr.url ?? ""),
    isDraft: pr.isDraft === true,
    mergeable: String(pr.mergeable ?? "UNKNOWN"),
    mergeStateStatus: String(pr.mergeStateStatus ?? "UNKNOWN"),
    reviewDecision: String(pr.reviewDecision ?? ""),
    changesRequestedBy: nodes(pr.latestReviews)
      .filter((r) => r.state === "CHANGES_REQUESTED")
      .map((r) => String((r.author as J | null)?.login ?? "someone")),
    base: String(pr.baseRefName ?? ""),
    headOid: String(pr.headRefOid ?? ""),
    checks,
    unresolved: open.length,
    threadsByPath,
  };
}

const FAILED = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const RUNNING = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "EXPECTED", "WAITING", "REQUESTED"]);

/** What the panel shows: a colour, one sentence, and the one button that fixes it (null: nothing to press). */
export interface MergeStatus {
  tone: "ready" | "blocked" | "failing" | "waiting" | "checking" | "merged" | "closed";
  label: string;
  action:
    | "merge"
    | "resolve"
    | "update"
    | "view_checks"
    | "pull_comments"
    | "ready_for_review"
    | "open"
    | null;
}

/**
 * The one status, in the order docs/design/sidebar-pr-panel.md section 3 gives: the first that applies wins.
 * When the repo marks some checks required, only those block; otherwise every failing check does.
 */
export function mergeStatus(pr: PullRequest): MergeStatus {
  const base = pr.base || "main";
  const anyRequired = pr.checks.some((c) => c.required);
  const failed = pr.checks.filter((c) => FAILED.has(c.state) && (c.required || !anyRequired));
  const running = pr.checks.filter((c) => RUNNING.has(c.state)).length;
  if (pr.state === "MERGED") return { tone: "merged", label: "Merged", action: null };
  if (pr.state === "CLOSED") return { tone: "closed", label: "Closed", action: null };
  if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN")
    return { tone: "checking", label: "Checking with GitHub…", action: null };
  if (pr.isDraft) return { tone: "waiting", label: "Draft", action: "ready_for_review" };
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY")
    return { tone: "blocked", label: `Conflicts with ${base}`, action: "resolve" };
  if (failed.length > 0)
    return {
      tone: "failing",
      label: `Checks failing (${failed.length} of ${pr.checks.length})`,
      action: "view_checks",
    };
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    const by = pr.changesRequestedBy.length ? ` by @${pr.changesRequestedBy.join(", @")}` : "";
    return { tone: "blocked", label: `Changes requested${by}`, action: "pull_comments" };
  }
  if (pr.unresolved > 0)
    return {
      tone: "blocked",
      label: pr.unresolved === 1 ? "1 review comment" : `${pr.unresolved} review comments`,
      action: "pull_comments",
    };
  if (pr.mergeStateStatus === "BEHIND")
    return { tone: "blocked", label: `Branch is behind ${base}`, action: "update" };
  if (running > 0)
    return {
      tone: "waiting",
      label: `Checks running (${pr.checks.length - running} of ${pr.checks.length})`,
      action: null,
    };
  if (pr.reviewDecision === "REVIEW_REQUIRED")
    return { tone: "waiting", label: "Waiting for review", action: null };
  if (["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(pr.mergeStateStatus))
    return { tone: "ready", label: "Ready to merge", action: "merge" };
  return { tone: "blocked", label: "Blocked by a repo rule", action: "open" };
}

/** owner/name of the folder's GitHub repo, for a session that doesn't know it. */
async function repoOf(folder: string, token: string | null): Promise<string | null> {
  const r = await run(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    folder,
    env(token),
    30_000,
  );
  const name = r.out.trim();
  return r.ok && REPO.test(name) ? name : null;
}

/** The latest pull request from the session's branch (open, merged or closed); null when there's none. */
export async function pullRequest(
  folder: string,
  repo: string,
  branch: string,
  token: string | null,
): Promise<PullRequest | null> {
  const full = REPO.test(repo) ? repo : await repoOf(folder, token);
  if (!full || !branch) return null;
  const [owner, name] = full.split("/");
  const found = await graphql(FIND, { owner, name, branch }, token);
  const list = ((found?.data as J | undefined)?.repository as J | undefined)?.pullRequests;
  const number = nodes(list)[0]?.number;
  if (typeof number !== "number") return null;
  return parsePullRequest(await graphql(PR_QUERY, { owner, name, number }, token));
}

const THREADS = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine comments(first:1){nodes{author{login} body url}}}}}}}`;

/** Every review thread on the pull request: file, line, reviewer, first comment, resolved and outdated. */
export async function reviewThreads(
  repo: string,
  number: number,
  token: string | null,
): Promise<ReviewThread[]> {
  const [owner, name] = repo.split("/");
  const r = await run(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      `query=${THREADS}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ],
    process.cwd(),
    env(token),
    30_000,
  );
  if (!r.ok) throw new Error(r.err.trim() || "GitHub didn't answer");
  const threads = (JSON.parse(r.out).data?.repository?.pullRequest?.reviewThreads?.nodes ??
    []) as Record<string, unknown>[];
  return threads.map((t) => {
    const c = ((t.comments as { nodes: Record<string, unknown>[] }).nodes[0] ?? {}) as Record<
      string,
      unknown
    >;
    return {
      id: String(t.id),
      path: String(t.path ?? ""),
      line: (t.line as number | null) ?? (t.originalLine as number | null) ?? null,
      author: String((c.author as { login?: string } | undefined)?.login ?? "someone"),
      body: String(c.body ?? ""),
      url: String(c.url ?? ""),
      resolved: t.isResolved === true,
      outdated: t.isOutdated === true,
    };
  });
}

/** The comments as one block for the message box: file:line, reviewer, what they said, link. */
export function commentsBlock(number: number, threads: ReviewThread[]): string {
  const items = threads.map(
    (t) =>
      `- ${t.path}${t.line ? `:${t.line}` : ""} (${t.author}): ${t.body.trim().replace(/\n+/g, " ")}\n  ${t.url}`,
  );
  return `Review comments on PR #${number}:\n${items.join("\n")}`;
}

/** Merges with the first way the repo allows: squash, then merge, then rebase. */
export async function merge(folder: string, repo: string, number: number, token: string | null) {
  const allowed = await run(
    "gh",
    ["repo", "view", repo, "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"],
    folder,
    env(token),
  );
  let how = "--squash";
  try {
    const a = JSON.parse(allowed.out) as Record<string, boolean>;
    how = a.squashMergeAllowed ? "--squash" : a.mergeCommitAllowed ? "--merge" : "--rebase";
  } catch {
    // keep squash
  }
  const r = await run(
    "gh",
    ["pr", "merge", String(number), how, "-R", repo],
    folder,
    env(token),
    120_000,
  );
  return r.ok
    ? { ok: true }
    : { ok: false, problem: r.err.trim().slice(0, 400) || "GitHub refused the merge." };
}

const UPDATE = `mutation($id:ID!,$oid:GitObjectID!,$how:PullRequestBranchUpdateMethod!){updatePullRequestBranch(input:{pullRequestId:$id,expectedHeadOid:$oid,updateMethod:$how}){pullRequest{headRefOid}}}`;

/**
 * "Branch is behind main: Update": GitHub merges the base into the branch, as its own Update branch button does,
 * or rebases it when the base only takes a straight history. The head must still be the one the panel saw, so
 * nothing pushed meanwhile is lost.
 */
export async function updateBranch(pr: PullRequest, token: string | null) {
  let problem = "";
  for (const how of ["MERGE", "REBASE"]) {
    const r = await run(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `query=${UPDATE}`,
        "-f",
        `id=${pr.id}`,
        "-f",
        `oid=${pr.headOid}`,
        "-f",
        `how=${how}`,
      ],
      process.cwd(),
      env(token),
      60_000,
    );
    if (r.ok && !r.out.includes('"errors"')) return { ok: true };
    problem = (r.err || r.out).trim();
    if (!/linear|merge commit/i.test(problem)) break;
  }
  return { ok: false, problem: problem.slice(0, 400) || "GitHub couldn't update the branch." };
}

/** "Draft: Ready for review". */
export async function markReady(repo: string, number: number, token: string | null) {
  const r = await run(
    "gh",
    ["pr", "ready", String(number), "-R", repo],
    process.cwd(),
    env(token),
    60_000,
  );
  return r.ok
    ? { ok: true }
    : { ok: false, problem: r.err.trim().slice(0, 400) || "GitHub refused." };
}

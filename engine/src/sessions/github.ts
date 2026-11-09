/**
 * A session's pull request through `gh`, with the GitHub account that reaches the repo: its number, state and
 * checks, the review threads to pull into a chat, and the merge.
 *
 * New in Forge Desktop.
 */
import { run } from "./git.js";

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
  isDraft: boolean;
  checks: { name: string; state: string }[];
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

/** The open (or latest) pull request for the folder's branch; null when there's none. */
export async function pullRequest(
  folder: string,
  token: string | null,
): Promise<PullRequest | null> {
  const r = await run(
    "gh",
    ["pr", "view", "--json", "number,title,state,url,isDraft,statusCheckRollup"],
    folder,
    env(token),
    30_000,
  );
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.out) as Record<string, unknown>;
    const rollup = Array.isArray(j.statusCheckRollup)
      ? (j.statusCheckRollup as Record<string, unknown>[])
      : [];
    return {
      number: Number(j.number),
      title: String(j.title ?? ""),
      state: String(j.state ?? ""),
      url: String(j.url ?? ""),
      isDraft: j.isDraft === true,
      checks: rollup.map((c) => ({
        name: String(c.name ?? c.context ?? "check"),
        state: String(c.conclusion || c.state || c.status || ""),
      })),
    };
  } catch {
    return null;
  }
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
  const nodes = (JSON.parse(r.out).data?.repository?.pullRequest?.reviewThreads?.nodes ??
    []) as Record<string, unknown>[];
  return nodes.map((t) => {
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

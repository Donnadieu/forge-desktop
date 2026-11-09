/**
 * Git and GitHub for sessions: each session's own folder (a git worktree on its own branch), its diff
 * against the base branch, snapshots to private refs (archive and per-turn checkpoints), and its pull
 * request through `gh` with the GitHub account that reaches the repo.
 *
 * New in Forge Desktop.
 */
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Run {
  ok: boolean;
  out: string;
  err: string;
}

export function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 120_000,
): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout), err: String(stderr) }),
    );
  });
}

const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => run("git", args, cwd, env);

/** "Add a Sessions screen to the workspace" -> "add-a-sessions-screen". */
export function slug(text: string, words = 5): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, words)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
  return s || "session";
}

/** `<prefix>/<slug>`, never a doubled prefix (`donnadieu/donnadieu/x`). */
export function branchName(prefix: string, name: string): string {
  const p = prefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  const s = slug(name);
  if (!p) return s;
  return s.startsWith(`${p}-`) || s === p
    ? `${p}/${s.slice(p.length + 1) || "session"}`
    : `${p}/${s}`;
}

/** A gh account's token, for one repo's GitHub calls (never switches gh's active account). */
export async function ghToken(login: string | null): Promise<string | null> {
  if (!login) return null;
  const r = await run("gh", ["auth", "token", "-u", login], process.cwd());
  return r.ok ? r.out.trim() : null;
}

/** The gh accounts on this Mac. */
export async function ghAccounts(): Promise<string[]> {
  const r = await run("gh", ["auth", "status", "--json", "hosts"], process.cwd());
  try {
    const hosts = JSON.parse(r.out).hosts as Record<string, { login: string }[]>;
    return (hosts["github.com"] ?? []).map((h) => h.login);
  } catch {
    return [];
  }
}

/** The first gh account that can push to the repo (null = let gh use its active one). */
export async function accountFor(repo: string): Promise<string | null> {
  for (const login of await ghAccounts()) {
    const token = await ghToken(login);
    if (!token) continue;
    const r = await run(
      "gh",
      ["api", `repos/${repo}`, "--jq", ".permissions.push"],
      process.cwd(),
      {
        ...process.env,
        GH_TOKEN: token,
      },
    );
    if (r.ok && r.out.trim() === "true") return login;
  }
  return null;
}

export interface FolderPlan {
  /** The person's own checkout, if they have one; worktrees hang off it. */
  local: string | null;
  /** Forge's clone when there is no local checkout. */
  mirror: string;
  folder: string;
  branch: string;
  base: string;
  repo: string;
  token: string | null;
}

/**
 * Makes the session's folder: fetch first, then a worktree on a new branch from `origin/<base>`, so it starts
 * from the latest remote commit even when the person's checkout is behind. Copies `.env*` files git ignores.
 */
export async function makeFolder(p: FolderPlan): Promise<{ ok: boolean; problem?: string }> {
  const env = p.token ? { ...process.env, GH_TOKEN: p.token } : process.env;
  let root = p.local;
  if (!root) {
    root = p.mirror;
    if (!existsSync(join(root, ".git"))) {
      mkdirSync(dirname(root), { recursive: true });
      const c = await run("gh", ["repo", "clone", p.repo, root], dirname(root), env, 600_000);
      if (!c.ok)
        return {
          ok: false,
          problem: `Couldn't get ${p.repo} from GitHub: ${c.err.trim().slice(0, 300)}`,
        };
    }
  }
  const f = await git(root, ["fetch", "origin", p.base], env);
  if (!f.ok)
    return { ok: false, problem: `Couldn't fetch ${p.base}: ${f.err.trim().slice(0, 300)}` };
  mkdirSync(dirname(p.folder), { recursive: true });
  const w = await git(root, ["worktree", "add", "-b", p.branch, p.folder, `origin/${p.base}`]);
  if (!w.ok) {
    if (/already (exists|checked out|used by worktree)/.test(w.err)) {
      return {
        ok: false,
        problem: `The branch ${p.branch} is already open in another folder. Pick another first message or close that session.`,
      };
    }
    return {
      ok: false,
      problem: `Couldn't make the session's folder: ${w.err.trim().slice(0, 300)}`,
    };
  }
  if (p.local) copyIgnoredEnv(p.local, p.folder);
  return { ok: true };
}

/** Copies the top folder's `.env*` files into the new folder (only ones git ignores, so nothing gets committed). */
function copyIgnoredEnv(from: string, to: string): void {
  void git(from, ["ls-files", "--others", "--ignored", "--exclude-standard", "--", ".env*"]).then(
    (r) => {
      for (const f of r.out.split("\n").filter((x) => x && !x.includes("/"))) {
        try {
          copyFileSync(join(from, f), join(to, f));
        } catch {
          // unreadable: skip it
        }
      }
    },
  );
}

/** Snapshot of the folder (HEAD, index and every file, untracked included) as a commit on a private ref. */
export async function snapshot(folder: string, ref: string): Promise<string | null> {
  const head = (await git(folder, ["rev-parse", "HEAD"])).out.trim();
  if (!head) return null;
  // Never in the middle of a merge, rebase, cherry-pick or revert (a worktree's .git is a file: ask git).
  const gitDir = (await git(folder, ["rev-parse", "--absolute-git-dir"])).out.trim();
  for (const busy of [
    "MERGE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
  ]) {
    if (gitDir && existsSync(join(gitDir, busy))) return null;
  }
  const tmp = mkdtempSync(join(tmpdir(), "forge-snap-"));
  const index = join(tmp, "index");
  try {
    const env = { ...process.env, GIT_INDEX_FILE: index };
    await git(folder, ["read-tree", head], env);
    const add = await git(folder, ["add", "-A", "."], env);
    if (!add.ok) return null;
    const tree = (await git(folder, ["write-tree"], env)).out.trim();
    // A private snapshot is never signed (the person's config may sign every commit, and a key could prompt) and
    // never pushed. Without a git identity on this Mac, commit-tree refuses: give it a placeholder only then.
    const who = await git(folder, ["var", "GIT_COMMITTER_IDENT"]);
    const anon = { GIT_AUTHOR_NAME: "Forge snapshot", GIT_AUTHOR_EMAIL: "snapshot" };
    const commit = await git(
      folder,
      ["commit-tree", "--no-gpg-sign", tree, "-p", head, "-m", `forge snapshot ${ref}`],
      who.ok
        ? undefined
        : {
            ...process.env,
            ...anon,
            GIT_COMMITTER_NAME: anon.GIT_AUTHOR_NAME,
            GIT_COMMITTER_EMAIL: anon.GIT_AUTHOR_EMAIL,
          },
    );
    const sha = commit.out.trim();
    if (!commit.ok || !sha) return null;
    await git(folder, ["update-ref", ref, sha]);
    return sha;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Puts the folder back to a snapshot: files that differ are rewritten, files added since are removed, HEAD reset. */
export async function restore(folder: string, sha: string): Promise<boolean> {
  const parent = (await git(folder, ["rev-parse", `${sha}^`])).out.trim();
  const now = await snapshot(folder, "refs/forge/before-restore");
  if (now) {
    const added = await git(folder, ["diff", "--name-only", "--diff-filter=A", sha, now]);
    for (const f of added.out.split("\n").filter(Boolean)) rmSync(join(folder, f), { force: true });
  }
  // `checkout <sha> -- .` rewrites only files that differ; an empty snapshot has nothing to check out.
  const files = (await git(folder, ["ls-tree", "-r", "--name-only", sha])).out.trim();
  if (files) {
    const co = await git(folder, ["checkout", sha, "--", "."]);
    if (!co.ok) return false;
  }
  await git(folder, ["reset", "--soft", parent]);
  await git(folder, ["reset", "--quiet"]);
  return true;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  status: "A" | "M" | "D" | "R";
}

async function mergeBase(folder: string, base: string): Promise<string> {
  const mb = await git(folder, ["merge-base", "HEAD", `origin/${base}`]);
  return mb.out.trim() || "HEAD";
}

/** Every change on the session's branch against its base, plus uncommitted and untracked files. */
export async function changes(folder: string, base: string): Promise<FileChange[]> {
  const from = await mergeBase(folder, base);
  const num = await git(folder, ["diff", "--numstat", "-M", from]);
  const st = await git(folder, ["diff", "--name-status", "-M", from]);
  const status = new Map<string, FileChange["status"]>();
  for (const l of st.out.split("\n").filter(Boolean)) {
    const [s, ...paths] = l.split("\t");
    status.set(paths[paths.length - 1], (s[0] as FileChange["status"]) ?? "M");
  }
  const out: FileChange[] = num.out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [a, r, ...p] = l.split("\t");
      const path = p
        .join("\t")
        .replace(/^.*\{.* => (.*)\}.*$/, "$1")
        .replace(/^.* => /, "");
      return {
        path,
        added: Number(a) || 0,
        removed: Number(r) || 0,
        status: status.get(path) ?? "M",
      };
    });
  const untracked = await git(folder, ["ls-files", "--others", "--exclude-standard"]);
  for (const path of untracked.out.split("\n").filter(Boolean)) {
    const wc = await run("wc", ["-l", path], folder);
    out.push({ path, added: Number(wc.out.trim().split(/\s+/)[0]) || 0, removed: 0, status: "A" });
  }
  return out;
}

/** One file's unified diff (an untracked file shows as all added). */
export async function fileDiff(folder: string, base: string, path: string): Promise<string> {
  const from = await mergeBase(folder, base);
  const tracked = await git(folder, ["ls-files", "--error-unmatch", path]);
  if (!tracked.ok) return (await git(folder, ["diff", "--no-index", "--", "/dev/null", path])).out;
  return (await git(folder, ["diff", "-M", from, "--", path])).out;
}

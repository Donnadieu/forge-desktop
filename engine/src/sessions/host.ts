/**
 * The sessions host: what the app asks for, in one place. Makes a session (its folder, branch and first chat),
 * lists them with a status derived from their chats and pull request, reads their changes, goes back to before a
 * turn, archives and restores, merges, pulls review comments, renames the branch, and the Changes panel's fixes
 * (update the branch, ready for review, push for a hand-made PR).
 *
 * New in Forge Desktop. The HTTP side is api.ts.
 */
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CardWatcher } from "./cards.js";
import { Chats, contextWindow } from "./chats.js";
import { cutTranscript, restore } from "./checkpoints.js";
import {
  accountFor,
  branches,
  branchName,
  changes,
  fileDiff,
  freeBranch,
  ghToken,
  makeFolder,
  run,
  slug,
  snapshot,
} from "./git.js";
import {
  commentsBlock,
  markReady,
  merge,
  mergeStatus,
  type PullRequest,
  pullRequest,
  reviewThreads,
  updateBranch,
} from "./github.js";
import type { SessionStore } from "./store.js";
import type { ChatRecord, SessionRecord, SessionStatus } from "./types.js";

export interface NewSession {
  workspaceId: string;
  repo: string;
  /** The person's own checkout of the repo, if any. */
  local?: string | null;
  base: string;
  /** Branch prefix; "auto" = the GitHub login that reaches the repo; "" = none. */
  prefix: string;
  message: string;
  model: string;
  effort: string;
  title?: string;
  /** A branch name the person typed for the new branch, or the existing branch to open (with `existing`). */
  branch?: string;
  existing?: boolean;
}

export interface HostOptions {
  home: string;
  command: string;
  notify: (frame: Record<string, unknown>) => void;
}

const TITLE_WORDS = 8;

export function titleFrom(message: string): string {
  const first = message.trim().split("\n")[0].replace(/\s+/g, " ");
  const words = first.split(" ").slice(0, TITLE_WORDS).join(" ");
  return words.length < first.length ? `${words}…` : words || "New session";
}

export class SessionsHost {
  readonly chats: Chats;
  readonly cards: CardWatcher;
  private prs = new Map<string, PullRequest | null>();
  private tokens = new Map<string, string | null>();

  /** The host's folder (sessions.sqlite, repos/, folders/, attachments/). */
  get home(): string {
    return this.o.home;
  }

  constructor(
    private readonly store: SessionStore,
    private readonly o: HostOptions,
  ) {
    this.chats = new Chats(store, {
      command: o.command,
      envFor: (s) => this.envFor(s),
      notify: o.notify,
      touched: (id) => this.touched(id),
    });
    this.cards = new CardWatcher(store, o.notify, (id) => this.touched(id));
  }

  private async token(login: string | null): Promise<string | null> {
    const key = login ?? "";
    if (!this.tokens.has(key)) this.tokens.set(key, await ghToken(login));
    return this.tokens.get(key) ?? null;
  }

  /** The agent's environment: the person's, minus Forge's own launch secrets, plus the repo's GitHub account. */
  async envFor(s: SessionRecord): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith("FORGE_") || k.startsWith("GIT_CONFIG_")) continue;
      env[k] = v;
    }
    const token = await this.token(s.githubLogin);
    if (token) env.GH_TOKEN = token;
    env.FORGE_SESSION_ID = s.id;
    env.FORGE_SESSION_REPO = s.repo;
    env.FORGE_SESSION_BRANCH = s.branch;
    env.FORGE_SESSION_BASE = s.base;
    return env;
  }

  status(s: SessionRecord): SessionStatus {
    if (s.archived) return "archived";
    const chats = this.store.chats(s.id);
    if (chats.some((c) => c.state === "needs_you")) return "needs_you";
    if (chats.some((c) => c.state === "working")) return "working";
    if (s.prState === "MERGED") return "merged";
    if (s.prNumber && s.prState === "OPEN") return "review";
    return "idle";
  }

  view(s: SessionRecord) {
    const chats = this.store.chats(s.id).filter((c) => !c.hidden);
    return {
      ...s,
      status: this.status(s),
      chats: chats.map((c) => ({
        ...c,
        queued: this.store.queued(c.id).length,
        queue: this.store.queued(c.id).map((q) => q.text),
        turns: this.store.turnCount(c.id),
      })),
    };
  }

  list() {
    return this.store.sessions().map((s) => this.view(s));
  }

  touched(id: string): void {
    const s = this.store.session(id);
    if (s) this.o.notify({ type: "session", session: this.view(s) });
  }

  private mirrorFor(repo: string): string {
    return join(this.o.home, "repos", repo.replace("/", "-"));
  }

  /** The branches a new session can open: the person's checkout's, else Forge's own clone's. */
  async branches(repo: string, local: string | null, base: string): Promise<string[]> {
    const root = local && existsSync(join(local, ".git")) ? local : this.mirrorFor(repo);
    return branches(root, await this.token(await accountFor(repo)), base);
  }

  private folderFor(repo: string, name: string): string {
    const base = join(this.o.home, "folders", repo.replace("/", "-"));
    let folder = join(base, name);
    for (let n = 2; existsSync(folder); n++) folder = join(base, `${name}-v${n}`);
    return folder;
  }

  async create(n: NewSession): Promise<{ ok: boolean; problem?: string; session?: unknown }> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(n.repo)) return { ok: false, problem: "Pick a repo first." };
    if (!n.message.trim()) return { ok: false, problem: "Write the first message." };
    const login = await accountFor(n.repo);
    const name = slug(n.title ?? n.message, 4);
    // "auto": the GitHub login that reaches the repo, as Conductor did (donnadieu/<slug>).
    const prefix = n.prefix === "auto" ? (login ?? "") : n.prefix;
    const local = n.local && existsSync(join(n.local, ".git")) ? n.local : null;
    const mirror = this.mirrorFor(n.repo);
    const typed = n.branch?.trim().replace(/\s+/g, "-");
    if (n.existing && !typed) return { ok: false, problem: "Pick the branch to open." };
    // A new branch never takes a name another branch has, so sessions never collide.
    const branch = n.existing
      ? (typed as string)
      : await freeBranch(local ?? mirror, typed || branchName(prefix, n.title ?? n.message));
    const folder = this.folderFor(n.repo, n.existing ? slug(branch, 6) : name);
    const made = await makeFolder({
      local,
      mirror,
      folder,
      branch,
      base: n.base,
      repo: n.repo,
      token: await this.token(login),
      existing: n.existing === true,
    });
    if (!made.ok) return made;
    const now = new Date().toISOString();
    const s: SessionRecord = {
      id: randomUUID(),
      workspaceId: n.workspaceId,
      origin: "person",
      repo: n.repo,
      folder,
      branch,
      base: n.base,
      title: n.title?.trim() || titleFrom(n.message),
      titleByHand: Boolean(n.title?.trim()),
      githubLogin: login,
      prNumber: null,
      prState: null,
      prTitle: null,
      unread: false,
      archived: false,
      archiveRef: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.putSession(s);
    const chat = this.newChat(s.id, n.model, n.effort, "Chat");
    await this.chats.send(chat.id, n.message, "steer");
    this.touched(s.id);
    return { ok: true, session: this.view(s) };
  }

  newChat(sessionId: string, model: string, effort: string, title: string): ChatRecord {
    const c: ChatRecord = {
      id: randomUUID(),
      sessionId,
      title,
      provider: "claude",
      model,
      effort,
      planMode: false,
      askBeforeChanges: false,
      providerSessionId: null,
      state: "idle",
      contextTokens: 0,
      contextWindow: contextWindow(model),
      hidden: false,
      createdAt: new Date().toISOString(),
    };
    this.store.putChat(c);
    this.touched(sessionId);
    return c;
  }

  async markRead(id: string): Promise<void> {
    const s = this.store.session(id);
    if (s?.unread) {
      this.store.putSession({ ...s, unread: false });
      this.touched(id);
    }
  }

  async changes(id: string) {
    const s = this.store.session(id);
    if (!s || s.archived || !existsSync(s.folder)) return { files: [] };
    return { files: await changes(s.folder, s.base) };
  }

  async diff(id: string, path: string) {
    const s = this.store.session(id);
    if (!s || s.archived) return { diff: "" };
    return { diff: await fileDiff(s.folder, s.base, path) };
  }

  /** The branch's pull request, refreshed from GitHub. */
  async pr(id: string) {
    const s = this.store.session(id);
    if (!s || s.archived) return { pr: null };
    const pr = await pullRequest(s.folder, s.repo, s.branch, await this.token(s.githubLogin));
    this.prs.set(id, pr);
    const next: SessionRecord = {
      ...s,
      prNumber: pr?.number ?? null,
      prState: pr?.state ?? null,
      prTitle: pr?.title ?? null,
      title: !s.titleByHand && pr?.title ? pr.title : s.title,
    };
    if (JSON.stringify(next) !== JSON.stringify(s)) {
      this.store.putSession(next);
      this.touched(id);
    }
    return { pr: pr ? { ...pr, status: mergeStatus(pr) } : null };
  }

  private busy(id: string): boolean {
    return this.store.chats(id).some((c) => c.state === "working" || c.state === "needs_you");
  }

  /** "Branch is behind main: Update", then the session's folder catches up when it has nothing unpushed. */
  async update(id: string) {
    const s = this.store.session(id);
    if (!s) return { ok: false, problem: "That session isn't there any more." };
    await this.pr(id);
    const pr = this.prs.get(id);
    if (!pr) return { ok: false, problem: "This session has no pull request." };
    const r = await updateBranch(pr, await this.token(s.githubLogin));
    if (r.ok && !this.busy(id) && existsSync(s.folder)) {
      const env = await this.envFor(s);
      if ((await run("git", ["fetch", "-q", "origin", s.branch], s.folder, env)).ok)
        await run("git", ["merge", "-q", "--ff-only", `origin/${s.branch}`], s.folder, env);
    }
    await this.pr(id);
    return r;
  }

  /** "Draft: Ready for review". */
  async ready(id: string) {
    const s = this.store.session(id);
    if (!s?.prNumber) return { ok: false, problem: "This session has no pull request." };
    const r = await markReady(s.repo, s.prNumber, await this.token(s.githubLogin));
    await this.pr(id);
    return r;
  }

  /** "Create PR manually": the branch goes to GitHub, and the page to open the pull request on comes back. */
  async publish(id: string) {
    const s = this.store.session(id);
    if (!s || !existsSync(s.folder))
      return { ok: false, problem: "That session's folder isn't there." };
    const r = await run(
      "git",
      ["push", "-q", "-u", "origin", "HEAD"],
      s.folder,
      await this.envFor(s),
    );
    if (!r.ok)
      return { ok: false, problem: r.err.trim().slice(0, 400) || "Git couldn't push the branch." };
    const path = (b: string) => b.split("/").map(encodeURIComponent).join("/");
    const url = `https://github.com/${s.repo}/compare/${path(s.base)}...${path(s.branch)}?expand=1`;
    return { ok: true, url };
  }

  /**
   * Renames the session's branch here and, when it was pushed, on GitHub too (push the new name, delete the old).
   * GitHub closes a pull request whose branch goes away and can't move it to another branch, so a session with an
   * open pull request keeps its name. A card's branch belongs to the board's agent.
   */
  async rename(id: string, name: string) {
    const s = this.store.session(id);
    if (!s) return { ok: false, problem: "That session isn't there any more." };
    if (s.origin === "card")
      return { ok: false, problem: "A card's branch belongs to the agent working it." };
    if (s.prNumber && s.prState === "OPEN")
      return { ok: false, problem: `GitHub closes PR #${s.prNumber} when its branch is renamed.` };
    if (this.busy(id)) return { ok: false, problem: "Stop the agent first." };
    const next = name.trim();
    if (
      !next ||
      /\s/.test(next) ||
      !(await run("git", ["check-ref-format", "--branch", next], s.folder)).ok
    )
      return { ok: false, problem: "That isn't a name git takes." };
    if (next === s.branch) return { ok: true };
    if ((await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${next}`], s.folder)).ok)
      return { ok: false, problem: `A branch called ${next} is already there.` };
    const env = await this.envFor(s);
    const pushed = (
      await run("git", ["ls-remote", "--exit-code", "--heads", "origin", s.branch], s.folder, env)
    ).ok;
    const moved = await run("git", ["branch", "-m", s.branch, next], s.folder);
    if (!moved.ok)
      return { ok: false, problem: moved.err.trim().slice(0, 300) || "Git couldn't rename it." };
    if (pushed) {
      const up = await run("git", ["push", "-q", "-u", "origin", next], s.folder, env);
      if (!up.ok) {
        await run("git", ["branch", "-m", next, s.branch], s.folder);
        return {
          ok: false,
          problem: up.err.trim().slice(0, 300) || "Git couldn't push the new name.",
        };
      }
      await run("git", ["push", "-q", "origin", "--delete", s.branch], s.folder, env);
    } else {
      await run("git", ["branch", "--unset-upstream"], s.folder);
    }
    this.store.putSession({ ...s, branch: next, updatedAt: new Date().toISOString() });
    this.touched(id);
    return { ok: true };
  }

  async reviewComments(id: string) {
    const s = this.store.session(id);
    if (!s?.prNumber)
      return { ok: false, problem: "This session has no pull request yet.", threads: [] };
    try {
      const threads = await reviewThreads(s.repo, s.prNumber, await this.token(s.githubLogin));
      return { ok: true, threads, number: s.prNumber };
    } catch (err) {
      return {
        ok: false,
        problem: `GitHub didn't answer: ${String(err).slice(0, 200)}`,
        threads: [],
      };
    }
  }

  block(number: number, threads: Parameters<typeof commentsBlock>[1]): string {
    return commentsBlock(number, threads);
  }

  async merge(id: string) {
    const s = this.store.session(id);
    if (!s?.prNumber) return { ok: false, problem: "This session has no pull request." };
    const r = await merge(s.folder, s.repo, s.prNumber, await this.token(s.githubLogin));
    if (r.ok) await this.pr(id);
    return r;
  }

  /** Archive: the folder's whole state goes to a private ref, the folder goes away, the chats stay. */
  async archive(id: string) {
    const s = this.store.session(id);
    if (!s || s.archived) return { ok: false, problem: "Already archived." };
    // A card's session is only hidden: its folder is the running card's own workspace.
    if (s.origin === "card") {
      this.store.putSession({ ...s, archived: true, updatedAt: new Date().toISOString() });
      this.touched(id);
      return { ok: true };
    }
    for (const c of this.store.chats(id)) {
      this.chats.stop(c.id);
      await this.chats.closeChat(c.id);
    }
    const ref = `refs/forge/archive/${s.id}`;
    const sha = existsSync(s.folder) ? await snapshot(s.folder, ref) : null;
    if (existsSync(s.folder)) {
      const r = await run("git", ["worktree", "remove", "--force", s.folder], s.folder);
      if (!r.ok) rmSync(s.folder, { recursive: true, force: true });
    }
    const next = {
      ...s,
      archived: true,
      archiveRef: sha ? ref : null,
      updatedAt: new Date().toISOString(),
    };
    this.store.putSession(next);
    this.touched(id);
    return { ok: true };
  }

  /** Brings an archived session back: its folder on its branch, then the files as they were. */
  async unarchive(id: string, local: string | null) {
    const s = this.store.session(id);
    if (!s?.archived) return { ok: false, problem: "This session isn't archived." };
    if (s.origin === "card") {
      this.store.putSession({ ...s, archived: false, updatedAt: new Date().toISOString() });
      this.touched(id);
      return { ok: true };
    }
    const root =
      local && existsSync(join(local, ".git"))
        ? local
        : join(this.o.home, "repos", s.repo.replace("/", "-"));
    const w = await run("git", ["worktree", "add", s.folder, s.branch], root);
    if (!w.ok)
      return {
        ok: false,
        problem: `Couldn't bring the folder back: ${w.err.trim().slice(0, 300)}`,
      };
    if (s.archiveRef) {
      const sha = (await run("git", ["rev-parse", s.archiveRef], root)).out.trim();
      if (sha) await restore(s.folder, sha);
    }
    this.store.putSession({ ...s, archived: false, updatedAt: new Date().toISOString() });
    this.touched(id);
    return { ok: true };
  }

  /** Goes back to before a turn: files as they were, that turn and later ones gone, the agent forgets them. */
  async revert(chatId: string, turnId: string) {
    const c = this.store.chat(chatId);
    const t = this.store.turn(turnId);
    const s = c && this.store.session(c.sessionId);
    if (!c || !t || !s) return { ok: false, problem: "That turn isn't there any more." };
    if (c.state === "working" || c.state === "needs_you")
      return { ok: false, problem: "Stop the agent first." };
    if (!t.checkpointBefore)
      return { ok: false, problem: "Forge has no snapshot from before that turn." };
    await this.chats.closeChat(chatId);
    if (!(await restore(s.folder, t.checkpointBefore)))
      return { ok: false, problem: "Git couldn't put the files back." };
    const earlier = this.store
      .turns(chatId, t.seq, 100_000)
      .filter((x) => x.userText === t.userText).length;
    const cut = c.providerSessionId
      ? cutTranscript(s.folder, c.providerSessionId, t.userText, earlier + 1)
      : null;
    this.store.dropTurnsFrom(chatId, t.seq);
    const next: ChatRecord =
      t.seq === 1 || !cut
        ? { ...c, providerSessionId: null, startSessionId: randomUUID(), contextTokens: 0 }
        : { ...c, providerSessionId: cut, startSessionId: null };
    this.store.putChat(next);
    this.o.notify({ type: "reverted", chatId, seq: t.seq });
    this.touched(s.id);
    return { ok: true };
  }
}

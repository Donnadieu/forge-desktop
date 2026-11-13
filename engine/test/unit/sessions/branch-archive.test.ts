import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshot } from "../../../src/sessions/git.js";
import { SessionsHost } from "../../../src/sessions/host.js";
import { SessionStore } from "../../../src/sessions/store.js";
import type { SessionRecord } from "../../../src/sessions/types.js";

const FAKE = join(import.meta.dirname, "../../fixtures/sessions/fake-claude.mjs");
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/** Conductor's database with one workspace (w9) of a repo at `root`, archived on Conductor's side too. */
function conductorDb(path: string, root: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE repos (id TEXT, remote_url TEXT, default_branch TEXT, name TEXT, root_path TEXT);
    CREATE TABLE workspaces (id TEXT, repository_id TEXT, workspace_path TEXT, directory_name TEXT, branch TEXT,
      intended_target_branch TEXT, pr_title TEXT, workspace_name TEXT, state TEXT);
  `);
  db.prepare(
    "INSERT INTO repos VALUES ('r1', 'git@github.com:acme/app.git', 'main', 'app', ?)",
  ).run(root);
  db.exec(
    "INSERT INTO workspaces VALUES ('w9', 'r1', '/c/app/brisbane', 'brisbane', 'omar/ops', 'main', NULL, NULL, 'archived')",
  );
  db.close();
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [
    "-C",
    cwd,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ])
    .toString()
    .trim();

// A session's folder is a worktree of a repo whose origin is a bare repo in the scratch folder.
describe("a session's branch and archive", () => {
  let dir: string;
  let store: SessionStore;
  let host: SessionsHost;
  let root: string;
  let remote: string;

  const session = (
    id: string,
    origin: SessionRecord["origin"],
    folder: string,
    branch: string,
  ): SessionRecord => {
    const now = new Date().toISOString();
    return {
      id,
      workspaceId: "w",
      origin,
      repo: "acme/app",
      folder,
      branch,
      base: "main",
      title: id,
      titleByHand: false,
      githubLogin: null,
      prNumber: null,
      prState: null,
      prTitle: null,
      unread: false,
      archived: false,
      archiveRef: null,
      createdAt: now,
      updatedAt: now,
    };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-branch-"));
    remote = join(dir, "remote.git");
    root = join(dir, "repo");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    git(root, "commit", "-q", "--allow-empty", "-m", "start");
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "-q", "-u", "origin", "main");
    store = new SessionStore(join(dir, "s.sqlite"));
    host = new SessionsHost(store, { home: dir, command: FAKE, notify: () => {} });
  });

  afterEach(async () => {
    await host.chats.closeAll();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function worktree(name: string, branch: string): string {
    const folder = join(dir, name);
    git(root, "worktree", "add", "-q", "-b", branch, folder);
    return folder;
  }

  it("archiving a card's session only hides it: the card's own folder stays", async () => {
    const folder = worktree("card", "ce-142");
    store.putSession(session("card-p-c1", "card", folder, "ce-142"));
    expect(await host.archive("card-p-c1")).toEqual({ ok: true });
    expect(existsSync(folder)).toBe(true);
    expect(store.session("card-p-c1")?.archived).toBe(true);
    expect(await host.unarchive("card-p-c1", root)).toEqual({ ok: true });
    expect(store.session("card-p-c1")?.archived).toBe(false);
  });

  it("archiving the person's session still puts the folder away and brings it back", async () => {
    const folder = worktree("mine", "omar/fix");
    store.putSession(session("s1", "person", folder, "omar/fix"));
    expect(await host.archive("s1")).toEqual({ ok: true });
    expect(existsSync(folder)).toBe(false);
    expect(await host.unarchive("s1", root)).toEqual({ ok: true });
    expect(existsSync(folder)).toBe(true);
  });

  // Omar, Nov 13: archived sessions never came back. The app sends no checkout with Unarchive, so the host must
  // find the repo the folder came from itself.
  it("unarchives a session made from the person's checkout from that checkout, with its files as they were", async () => {
    const folder = worktree("mine", "omar/back");
    writeFileSync(join(folder, "notes.txt"), "not committed yet\n");
    store.putSession({ ...session("s1", "person", folder, "omar/back"), root });
    expect(await host.archive("s1")).toEqual({ ok: true });
    expect(existsSync(folder)).toBe(false);
    expect(await host.unarchive("s1", null)).toEqual({ ok: true });
    expect(git(folder, "branch", "--show-current")).toBe("omar/back");
    expect(readFileSync(join(folder, "notes.txt"), "utf8")).toBe("not committed yet\n");
    expect(store.session("s1")?.archived).toBe(false);
  });

  it("an imported session's folder belongs to the app it came from: archiving only hides it", async () => {
    const folder = worktree("conductor-ws", "omar/imported");
    store.putSession({ ...session("conductor-w1", "import", folder, "omar/imported"), root });
    expect(await host.archive("conductor-w1")).toEqual({ ok: true });
    expect(existsSync(folder)).toBe(true);
    expect(git(root, "worktree", "list")).toContain(folder);
    expect(await host.unarchive("conductor-w1", null)).toEqual({ ok: true });
    expect(store.session("conductor-w1")?.archived).toBe(false);
  });

  it("brings back an imported session whose folder an older Forge put away, from the repo Conductor names", async () => {
    const folder = worktree("brisbane", "omar/ops");
    writeFileSync(join(folder, "draft.md"), "half done\n");
    const ref = "refs/forge/archive/conductor-w9";
    const sha = await snapshot(folder, ref);
    git(root, "worktree", "remove", "--force", folder);
    // Imported before the host kept the repo: only Conductor's own database knows it.
    store.putSession({
      ...session("conductor-w9", "import", folder, "omar/ops"),
      archived: true,
      archiveRef: sha ? ref : null,
    });
    const db = join(dir, "conductor.db");
    conductorDb(db, root);
    const h = new SessionsHost(store, {
      home: dir,
      command: FAKE,
      notify: () => {},
      conductorDb: db,
    });
    expect(await h.unarchive("conductor-w9", null)).toEqual({ ok: true });
    expect(git(folder, "branch", "--show-current")).toBe("omar/ops");
    expect(readFileSync(join(folder, "draft.md"), "utf8")).toBe("half done\n");
    await h.chats.closeAll();
  });

  it("a folder deleted by hand (still listed by git) comes back from its branch", async () => {
    const folder = worktree("gone", "omar/gone");
    rmSync(folder, { recursive: true, force: true });
    store.putSession({ ...session("s1", "person", folder, "omar/gone"), root, archived: true });
    expect(await host.unarchive("s1", null)).toEqual({ ok: true });
    expect(git(folder, "branch", "--show-current")).toBe("omar/gone");
  });

  it("says plainly when the branch is gone too, and the session stays archived to read", async () => {
    const folder = worktree("lost", "omar/lost");
    store.putSession({ ...session("s1", "person", folder, "omar/lost"), root });
    expect(await host.archive("s1")).toEqual({ ok: true });
    git(root, "branch", "-D", "omar/lost");
    const r = await host.unarchive("s1", null);
    expect(r.ok).toBe(false);
    expect(r.problem).toBe(
      "Its folder is gone and so is its branch omar/lost, so it can't come back. Its chat stays here to read.",
    );
    expect(store.session("s1")?.archived).toBe(true);
  });

  it("an archived session is never archived again", async () => {
    const folder = worktree("twice", "omar/twice");
    store.putSession({ ...session("s1", "person", folder, "omar/twice"), root });
    expect(await host.archive("s1")).toEqual({ ok: true });
    expect(await host.archive("s1")).toEqual({ ok: false, problem: "Already archived." });
  });

  it("renames a pushed branch here and on GitHub's side, and the session follows", async () => {
    const folder = worktree("mine", "omar/old-name");
    git(folder, "push", "-q", "-u", "origin", "omar/old-name");
    store.putSession(session("s1", "person", folder, "omar/old-name"));
    expect(await host.rename("s1", "omar/new-name")).toEqual({ ok: true });
    expect(git(folder, "branch", "--show-current")).toBe("omar/new-name");
    const remoteBranches = git(remote, "branch", "--format=%(refname:short)").split("\n");
    expect(remoteBranches).toContain("omar/new-name");
    expect(remoteBranches).not.toContain("omar/old-name");
    expect(git(folder, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/omar/new-name");
    expect(store.session("s1")?.branch).toBe("omar/new-name");
  });

  it("renames a branch that was never pushed only here", async () => {
    const folder = worktree("mine", "omar/local");
    store.putSession(session("s1", "person", folder, "omar/local"));
    expect(await host.rename("s1", "omar/still-local")).toEqual({ ok: true });
    expect(git(folder, "branch", "--show-current")).toBe("omar/still-local");
    expect(git(remote, "branch", "--format=%(refname:short)")).toBe("main");
  });

  it("refuses a rename that would end an open pull request, a bad name, or a card's branch", async () => {
    const folder = worktree("mine", "omar/pr");
    store.putSession({
      ...session("s1", "person", folder, "omar/pr"),
      prNumber: 7,
      prState: "OPEN",
    });
    expect((await host.rename("s1", "omar/other")).ok).toBe(false);
    store.putSession(session("s2", "person", folder, "omar/pr"));
    expect((await host.rename("s2", "bad name..")).ok).toBe(false);
    expect((await host.rename("s2", "omar/other existing")).ok).toBe(false);
    store.putSession(session("card-x", "card", folder, "omar/pr"));
    expect((await host.rename("card-x", "omar/mine")).ok).toBe(false);
    expect(git(folder, "branch", "--show-current")).toBe("omar/pr");
  });
});

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionsHost } from "../../../src/sessions/host.js";
import { SessionStore } from "../../../src/sessions/store.js";
import type { SessionRecord } from "../../../src/sessions/types.js";

const FAKE = join(import.meta.dirname, "../../fixtures/sessions/fake-claude.mjs");
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

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { branches, freeBranch, makeFolder } from "../../../src/sessions/git.js";

const g = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf-8" },
  ).trim();

describe("a new session's own folder and branch", () => {
  let dir: string;
  let local: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-new-session-"));
    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const seed = join(dir, "seed");
    execFileSync("git", ["clone", "-q", origin, seed]);
    writeFileSync(join(seed, "a.txt"), "one\n");
    g(seed, "add", ".");
    g(seed, "commit", "-q", "-m", "start");
    g(seed, "push", "-q", "origin", "HEAD:main");
    g(seed, "checkout", "-q", "-b", "feature/login");
    writeFileSync(join(seed, "b.txt"), "two\n");
    g(seed, "add", ".");
    g(seed, "commit", "-q", "-m", "login");
    g(seed, "push", "-q", "origin", "feature/login");
    local = join(dir, "local");
    execFileSync("git", ["clone", "-q", origin, local]);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plan = (folder: string, branch: string, existing = false) => ({
    local,
    mirror: join(dir, "mirror"),
    folder: join(dir, folder),
    branch,
    base: "main",
    repo: "acme/app",
    token: null,
    existing,
  });

  it("branches a new session off main into its own folder", async () => {
    expect((await makeFolder(plan("s1", "omar/fix-login"))).ok).toBe(true);
    expect(g(join(dir, "s1"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("omar/fix-login");
    expect(g(join(dir, "s1"), "rev-parse", "HEAD")).toBe(g(local, "rev-parse", "origin/main"));
  });

  it("opens an existing branch in its own folder, at that branch's latest commit", async () => {
    const r = await makeFolder(plan("s2", "feature/login", true));
    expect(r.ok).toBe(true);
    expect(g(join(dir, "s2"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/login");
    expect(g(join(dir, "s2"), "rev-parse", "HEAD")).toBe(
      g(local, "rev-parse", "origin/feature/login"),
    );
  });

  it("never reuses a branch name: two sessions with the same first message get two branches", async () => {
    expect(await freeBranch(local, "omar/fix-login")).toBe("omar/fix-login");
    await makeFolder(plan("s3", "omar/fix-login"));
    expect(await freeBranch(local, "omar/fix-login")).toBe("omar/fix-login-2");
    expect(await freeBranch(local, "feature/login")).toBe("feature/login-2");
  });

  it("lists the branches a session can open, main first", async () => {
    const list = await branches(local, null);
    expect(list[0]).toBe("main");
    expect(list).toContain("feature/login");
    expect(list).not.toContain("HEAD");
  });
});

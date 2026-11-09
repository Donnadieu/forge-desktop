import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { turnOffClaudeAttribution } from "../../../src/workspace/copy-assets.js";
import {
  checkGh,
  checkPush,
  claudeHookProblems,
  setPrePushGuard,
  withClaudeGuard,
} from "../../../src/workspace/marks-guard.js";

const ENGINE = join(import.meta.dirname, "../../..");
const quote = (s: string) => `'${s}'`;
/** The guard as the hooks run it, through tsx here instead of the compiled file. */
const GUARD = `${quote(join(ENGINE, "node_modules/.bin/tsx"))} ${quote(join(ENGINE, "src/marks-guard.ts"))}`;

let root = "";
let card = "";
let remote = "";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(message: string, who = "Omar <omar@example.com>"): void {
  const [, name, email] = /^(.*) <(.*)>$/.exec(who) ?? [];
  writeFileSync(join(card, `f${Math.random()}`), "x");
  git(card, "add", "-A");
  execFileSync(
    "git",
    [
      "-c",
      `user.name=${name}`,
      "-c",
      `user.email=${email}`,
      "commit",
      "-q",
      "--no-gpg-sign",
      "-m",
      message,
    ],
    {
      cwd: card,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
      },
    },
  );
}

beforeEach(() => {
  // A card folder under a path that names the app, like the real one.
  root = mkdtempSync(join(tmpdir(), "marks-"));
  remote = join(root, "remote.git");
  card = join(root, "Application Support", "Forge", "workspaces", "BC-1");
  mkdirSync(card, { recursive: true });
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(card, "init", "-q", "-b", "main");
  git(card, "config", "user.name", "Omar");
  git(card, "config", "user.email", "omar@example.com");
  git(card, "config", "commit.gpgsign", "false");
  git(card, "remote", "add", "origin", remote);
  commit("Start");
  git(card, "push", "-q", "origin", "main");
  git(card, "checkout", "-q", "-b", "omar/bc-1");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("push guard", () => {
  it("passes plain commits by the folder's own identity", () => {
    commit("Apply the schedule page's filters to its feeds");
    expect(checkPush(card)).toEqual([]);
  });

  it("refuses a message that names the app or carries an AI trailer", () => {
    commit("Fix feeds\n\nCo-Authored-By: Claude <claude@example.com>");
    commit("Forge signing check");
    const problems = checkPush(card);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/AI co-author line/);
    expect(problems.join("\n")).toMatch(/the word Forge/);
  });

  it("refuses a commit made under someone else's name", () => {
    commit("Fix feeds", "Gilfoyle <bot@example.com>");
    expect(checkPush(card)[0]).toMatch(/is by Gilfoyle <bot@example.com>, not omar@example.com/);
  });

  it("refuses a branch that names the app", () => {
    git(card, "checkout", "-q", "-b", "forge/BC-1");
    commit("Fix feeds");
    expect(checkPush(card)[0]).toMatch(/branch name forge\/BC-1/);
  });

  it("git's own pre-push hook stops a real push, and lets a clean one through", () => {
    setPrePushGuard(card, GUARD);
    commit("🤖 Generated with Claude Code");
    const refused = spawnSync("git", ["push", "-q", "origin", "omar/bc-1"], {
      cwd: card,
      encoding: "utf-8",
    });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/Refused: commit [0-9a-f]+'s message would show/);
    expect(git(remote, "branch", "--list", "omar/bc-1")).toBe("");

    git(card, "reset", "-q", "--hard", "HEAD~1");
    commit("Apply the filters");
    const pushed = spawnSync("git", ["push", "-q", "origin", "omar/bc-1"], {
      cwd: card,
      encoding: "utf-8",
    });
    expect(pushed.status).toBe(0);
    expect(git(remote, "branch", "--list", "omar/bc-1")).toContain("omar/bc-1");
  }, 30_000);

  it("never touches a repo's own hooks, and turning the switch off removes ours", () => {
    const hook = join(card, ".git/hooks/pre-push");
    setPrePushGuard(card, GUARD);
    expect(readFileSync(hook, "utf-8")).toContain("marks-guard");
    setPrePushGuard(card, undefined);
    expect(existsSync(hook)).toBe(false);
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    setPrePushGuard(card, GUARD);
    expect(readFileSync(hook, "utf-8")).toBe("#!/bin/sh\nexit 0\n");
    rmSync(hook);
    git(card, "config", "core.hooksPath", ".husky");
    setPrePushGuard(card, GUARD);
    expect(existsSync(join(card, ".husky/pre-push"))).toBe(false);
  });
});

describe("gh guard", () => {
  it("refuses pull request text, labels and comments that show a mark", () => {
    expect(
      checkGh(
        `gh pr create --title "Fix feeds" --body "## Summary\nGenerated with Claude Code" --label x`,
        card,
      ),
    ).toHaveLength(1);
    expect(checkGh(`gh pr edit 372 --add-label forge`, card)).toHaveLength(1);
    expect(
      checkGh(`cd '${card}' && gh pr comment 372 --body "Forge stopped this run"`, card),
    ).toHaveLength(1);
    writeFileSync(
      join(card, "body.md"),
      "## Summary\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n",
    );
    expect(checkGh("gh pr create --title Fix --body-file body.md", card)).toHaveLength(1);
  });

  it("lets plain writes and every read through, even from a folder whose path names the app", () => {
    expect(
      checkGh(`cd '${card}' && gh pr create --title "Fix feeds" --body "Card: BC-1"`, card),
    ).toEqual([]);
    expect(
      checkGh(
        `cd ${card.replace(/ /g, "\\ ")} && gh pr create --title Fix --body-file .forge/pr.md`,
        card,
      ),
    ).toEqual([]);
    expect(checkGh("gh pr view 372 --json labels # forge", card)).toEqual([]);
    expect(checkGh("gh api repos/o/r/pulls/1/comments # forge", card)).toEqual([]);
    expect(checkGh("git status", card)).toEqual([]);
  });
});

describe("Claude Code hook", () => {
  it("refuses a push of marked commits and a marked gh write; lets other commands run", () => {
    commit("Forge signing check");
    expect(
      claudeHookProblems({
        tool_name: "Bash",
        tool_input: { command: "git push -u origin HEAD" },
        cwd: card,
      }),
    ).toHaveLength(1);
    expect(
      claudeHookProblems({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: card }),
    ).toEqual([]);
    expect(claudeHookProblems({ tool_name: "Read", tool_input: {}, cwd: card })).toEqual([]);
  });

  it("the real hook exits 2 with the reason on stderr", () => {
    const input = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'gh pr create --title "Forge: fix"' },
      cwd: card,
    });
    const [bin, script] = [
      join(ENGINE, "node_modules/.bin/tsx"),
      join(ENGINE, "src/marks-guard.ts"),
    ];
    const r = spawnSync(bin, [script, "claude-hook"], { input, encoding: "utf-8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^Refused:/);
  }, 30_000);

  it("is added to the card's Claude settings with the switch on and removed with it off, keeping the rest", () => {
    const settings = withClaudeGuard(
      { hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "x" }] }] } },
      GUARD,
    );
    const pre = (settings.hooks as { PreToolUse: Array<{ matcher: string }> }).PreToolUse;
    expect(pre.map((e) => e.matcher)).toEqual(["Edit", "Bash"]);
    const again = withClaudeGuard(settings, GUARD);
    expect((again.hooks as { PreToolUse: unknown[] }).PreToolUse).toHaveLength(2);
    const off = withClaudeGuard(again, undefined);
    expect(
      (off.hooks as { PreToolUse: Array<{ matcher: string }> }).PreToolUse.map((e) => e.matcher),
    ).toEqual(["Edit"]);
    expect(withClaudeGuard({ attribution: {} }, undefined)).toEqual({ attribution: {} });

    turnOffClaudeAttribution(card, GUARD);
    const file = JSON.parse(readFileSync(join(card, ".claude/settings.local.json"), "utf-8"));
    expect(file.attribution).toEqual({ commit: "", pr: "" });
    expect(JSON.stringify(file.hooks)).toContain("marks-guard.ts' claude-hook");
    turnOffClaudeAttribution(card);
    expect(
      JSON.parse(readFileSync(join(card, ".claude/settings.local.json"), "utf-8")).hooks,
    ).toBeUndefined();
  });
});

/**
 * Every skill a WORKFLOW.md prompt names must be readable at the path the
 * prompt uses, inside a client repo's checkout, without touching the client's
 * tracked files.
 *
 * The bug this guards: a client repo's pipeline agent reported "the commit
 * skill named in the workflow is not installed here (only commit-and-push)".
 * The prompt names skills as `skills/<name>/SKILL.md`, which never existed in a
 * workspace; the Claude copy went to `.claude/commands/` (the slash-command
 * folder, so the Skill tool never listed it) and was untracked and
 * un-excluded, so the `before_run` hook's `git clean -fd` wiped it anyway. The
 * agent was left with only the client repo's own `.claude/skills/*`.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkillsManifest } from "../../../src/worker/prompt-renderer.js";
import { copySkills } from "../../../src/workspace/copy-assets.js";

const REPO_ROOT = process.cwd();
const FORGE_SKILLS = join(REPO_ROOT, "skills");
const WORKFLOWS = ["workflow/lead.md"];
const CLIENT_PULL_SKILL = "client's own pull skill";

let root: string;
let ws: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ws, stdio: "pipe" }).toString();
}

/** A client checkout with its own tracked skills, one symlinked. */
function stageClientRepo(): void {
  ws = join(root, "ws");
  mkdirSync(join(ws, ".agents", "skills", "commit-and-push"), { recursive: true });
  writeFileSync(join(ws, ".agents", "skills", "commit-and-push", "SKILL.md"), "client skill");
  mkdirSync(join(ws, ".claude", "skills", "create-cli"), { recursive: true });
  writeFileSync(join(ws, ".claude", "skills", "create-cli", "SKILL.md"), "client create-cli");
  // Same name as a Forge skill: the client's copy must win and stay untouched.
  mkdirSync(join(ws, ".claude", "skills", "pull"), { recursive: true });
  writeFileSync(join(ws, ".claude", "skills", "pull", "SKILL.md"), CLIENT_PULL_SKILL);
  symlinkSync(
    "../../.agents/skills/commit-and-push",
    join(ws, ".claude", "skills", "commit-and-push"),
  );
  mkdirSync(join(ws, ".claude", "commands"), { recursive: true });
  writeFileSync(join(ws, ".claude", "commands", "review.md"), "client command");
  git(["init", "-q"]);
  git(["add", "-A"]);
  git([
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-q",
    "--no-gpg-sign",
    "-m",
    "client",
  ]);
}

/** Every skill path a workflow prompt names: bare `skills/…` in prose, `.forge/skills/…` in the manifest. */
function namedSkillPaths(): string[] {
  const paths = new Set<string>();
  for (const workflow of WORKFLOWS) {
    const body = readFileSync(join(REPO_ROOT, workflow), "utf-8");
    for (const m of body.matchAll(/(?<![\w./-])skills\/([\w-]+)\/SKILL\.md/g)) paths.add(m[0]);
  }
  const manifest = loadSkillsManifest(FORGE_SKILLS) ?? "";
  for (const m of manifest.matchAll(/\((\.forge\/skills\/[^)]+)\)/g)) paths.add(m[1]);
  return [...paths];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-skill-paths-"));
  stageClientRepo();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("copySkills: every skill a workflow names is at the path the prompt uses", () => {
  it("resolves each skill path named by the example workflows and the manifest", () => {
    copySkills(ws, FORGE_SKILLS);

    const named = namedSkillPaths();
    // Sanity: the prompts really do use both shapes, including the ones the agent missed.
    expect(named).toContain("skills/land/SKILL.md");
    expect(named).toContain(".forge/skills/commit/SKILL.md");
    for (const path of named) {
      expect(existsSync(join(ws, path)), `${path} should exist in the workspace`).toBe(true);
    }
  });

  it("lists Forge's skills where Claude Code's Skill tool looks, beside the client's own", () => {
    copySkills(ws, FORGE_SKILLS);

    for (const name of [
      "commit",
      "land",
      "triage",
      "simplify",
      "code-review",
      "qa-plan-forge",
      "push",
    ]) {
      expect(existsSync(join(ws, ".claude", "skills", name, "SKILL.md")), name).toBe(true);
    }
    expect(existsSync(join(ws, ".claude", "skills", "commit-and-push", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ws, ".claude", "skills", "create-cli", "SKILL.md"))).toBe(true);
  });

  it("never overwrites a client skill of the same name, tracked or symlinked", () => {
    copySkills(ws, FORGE_SKILLS);

    expect(readFileSync(join(ws, ".claude", "skills", "pull", "SKILL.md"), "utf-8")).toBe(
      CLIENT_PULL_SKILL,
    );
    expect(lstatSync(join(ws, ".claude", "skills", "commit-and-push")).isSymbolicLink()).toBe(true);
    // Forge's own pull skill is still reachable at the manifest / bare paths.
    expect(readFileSync(join(ws, ".forge", "skills", "pull", "SKILL.md"), "utf-8")).toBe(
      readFileSync(join(FORGE_SKILLS, "pull", "SKILL.md"), "utf-8"),
    );
    expect(git(["status", "--porcelain"])).toBe("");
  });

  it("leaves the client's tracked tree clean and survives before_run's git clean -fd", () => {
    copySkills(ws, FORGE_SKILLS);
    expect(git(["status", "--porcelain", "--untracked-files=all"])).toBe("");

    git(["clean", "-fd"]);

    expect(existsSync(join(ws, "skills", "land", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ws, ".claude", "skills", "commit", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ws, ".forge", "skills", "commit", "SKILL.md"))).toBe(true);
  });

  it("is idempotent: a second dispatch adds no duplicate exclude lines", () => {
    copySkills(ws, FORGE_SKILLS);
    const once = readFileSync(join(ws, ".git", "info", "exclude"), "utf-8");
    copySkills(ws, FORGE_SKILLS);
    const twice = readFileSync(join(ws, ".git", "info", "exclude"), "utf-8");

    expect(twice).toBe(once);
    expect(readlinkSync(join(ws, "skills"))).toBe(join(".forge", "skills"));
  });

  it("keeps a client repo's own top-level skills/ directory", () => {
    mkdirSync(join(ws, "skills"));
    writeFileSync(join(ws, "skills", "README.md"), "client");

    copySkills(ws, FORGE_SKILLS);

    expect(lstatSync(join(ws, "skills")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(ws, "skills", "README.md"), "utf-8")).toBe("client");
    // ...and doesn't hide it from git: a new file there still shows as untracked.
    expect(git(["status", "--porcelain", "--untracked-files=all"])).toContain("skills/README.md");
  });
});

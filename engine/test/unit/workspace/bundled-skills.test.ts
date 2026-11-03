/**
 * The agent skills ship with the app (engine/skills) and are copied into each
 * card's folder, where Claude Code's Skill tool finds them, kept out of git.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copySkills } from "../../../src/workspace/copy-assets.js";

const SKILLS = join(process.cwd(), "skills");
const NAMED: Array<[string, string]> = [
  ["triage", "triage/SKILL.md"],
  ["commit", "commit/SKILL.md"],
  ["push", "push/SKILL.md"],
  ["pull", "pull/SKILL.md"],
  ["simplify", "simplify/SKILL.md"],
  ["code-review", "code-review/SKILL.md"],
  ["code-review-nuclear", "code-review/code-review-nuclear/SKILL.md"],
  ["code-review-fix", "code-review/code-review-fix/SKILL.md"],
  ["qa-plan-forge", "qa-plan-forge/SKILL.md"],
  ["land", "land/SKILL.md"],
  ["linear", "linear/SKILL.md"],
];

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function allFiles(root: string, rel = ""): string[] {
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allFiles(root, join(rel, e.name)) : [join(rel, e.name)],
  );
}

describe("the bundled agent skills", () => {
  it("has all eleven skills the plan names", () => {
    for (const [name, path] of NAMED) {
      expect(existsSync(join(SKILLS, path)), name).toBe(true);
      expect(readFileSync(join(SKILLS, path), "utf-8")).toMatch(
        new RegExp(`^---\\nname: ${name}\\n`),
      );
    }
  });

  it("says nothing about the hosted platform they came from", () => {
    for (const f of allFiles(SKILLS)) {
      const text = readFileSync(join(SKILLS, f), "utf-8");
      expect(text, f).not.toMatch(/factory|forjado|hermes|basecamp|\bsmith\b|smith-|FRG-\d+/i);
    }
  });

  it("are copied into a card's folder where Claude Code finds them, and kept out of git", () => {
    const card = mkdtempSync(join(tmpdir(), "forge-card-skills-"));
    dir = card;
    execFileSync("git", ["init", "-q"], { cwd: card });
    copySkills(card, SKILLS);
    for (const [name, path] of NAMED) {
      expect(existsSync(join(card, ".claude", "skills", path)), name).toBe(true);
      expect(existsSync(join(card, ".forge", "skills", path)), name).toBe(true);
    }
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: dir,
    }).toString();
    expect(status).toBe("");
  });
});

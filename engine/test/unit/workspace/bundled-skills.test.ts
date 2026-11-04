/**
 * The agent skills ship with the app (engine/skills) and are copied into each
 * card's folder, where Claude Code's Skill tool finds them, kept out of git.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copySkills, turnOffClaudeAttribution } from "../../../src/workspace/copy-assets.js";

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
  ["repo-assessment", "repo-assessment/SKILL.md"],
  ["harness-engineering", "harness-engineering/SKILL.md"],
  ["code-comment-style", "code-comment-style/SKILL.md"],
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
  it("has every skill the plan names, plus the repo-readiness pair", () => {
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

  it("puts the skills that ship inside code-review at the top level, where the Skill tool finds them", () => {
    const card = mkdtempSync(join(tmpdir(), "forge-card-nested-"));
    dir = card;
    execFileSync("git", ["init", "-q"], { cwd: card });
    copySkills(card, SKILLS);
    for (const name of ["code-review-nuclear", "code-review-fix"]) {
      const top = join(card, ".claude", "skills", name, "SKILL.md");
      expect(existsSync(top), name).toBe(true);
      expect(readFileSync(top, "utf-8")).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
    }
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: card,
    }).toString();
    expect(status).toBe("");
  });

  it("turns off Claude Code's commit and pull request attribution, keeping other local settings", () => {
    const card = mkdtempSync(join(tmpdir(), "forge-card-attribution-"));
    dir = card;
    execFileSync("git", ["init", "-q"], { cwd: card });
    turnOffClaudeAttribution(card);
    const file = join(card, ".claude", "settings.local.json");
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      attribution: { commit: "", pr: "" },
    });

    writeFileSync(
      file,
      JSON.stringify({ model: "x", attribution: { commit: "Co-Authored-By: Claude" } }),
    );
    turnOffClaudeAttribution(card);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      model: "x",
      attribution: { commit: "", pr: "" },
    });

    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: card,
    }).toString();
    expect(status).toBe("");
  });
});

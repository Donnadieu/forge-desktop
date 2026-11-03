/**
 * The skill overlay: a skills folder may carry `worker-overrides/<name>` variants
 * that replace the matching skill when it is copied into a card's folder.
 * Forge Desktop ships no overrides today (its linear skill already defers the
 * card's lifecycle to the workflow), but the mechanism stays covered:
 *   1. The overlay reaches both `.forge/skills/` and `.claude/skills/`.
 *   2. `worker-overrides/` is NOT itself copied as a skill subdirectory, and is
 *      left out of the skills manifest.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkillsManifest } from "../../../src/worker/prompt-renderer.js";
import { copySkills } from "../../../src/workspace/copy-assets.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/** Stage a fixture skills source with a canonical + worker-override skill. */
function stageSkillsSource(): { skillsDir: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "worker-overrides-"));
  tmpDirs.push(root);

  const skillsDir = join(root, "skills");
  mkdirSync(join(skillsDir, "worker-overrides"), { recursive: true });
  writeFileSync(
    join(skillsDir, "linear.md"),
    "---\nname: linear\ndescription: Linear API\n---\n# Canonical\nmove to Human Review",
  );
  writeFileSync(join(skillsDir, "commit.md"), "---\nname: commit\ndescription: Commit\n---\n# c");
  writeFileSync(
    join(skillsDir, "worker-overrides", "linear.md"),
    "---\nname: linear\ndescription: Linear API\n---\n# Worker\ngh pr merge --rebase then Done",
  );

  const workspace = join(root, "ws");
  mkdirSync(workspace, { recursive: true });
  return { skillsDir, workspace };
}

describe("worker skill overrides (copySkills overlay)", () => {
  it("overlays worker-overrides/linear.md onto the copied linear skill", () => {
    const { skillsDir, workspace } = stageSkillsSource();
    copySkills(workspace, skillsDir);

    const forge = readFileSync(join(workspace, ".forge", "skills", "linear.md"), "utf-8");
    const claude = readFileSync(join(workspace, ".claude", "skills", "linear.md"), "utf-8");
    for (const content of [forge, claude]) {
      expect(content).toContain("gh pr merge --rebase");
      expect(content).not.toContain("Human Review");
    }
    // Non-overridden skills are untouched.
    expect(existsSync(join(workspace, ".forge", "skills", "commit.md"))).toBe(true);
  });

  it("overlays a dir-model worker-overrides/linear/SKILL.md onto <name>/SKILL.md", () => {
    const root = mkdtempSync(join(tmpdir(), "worker-overrides-dir-"));
    tmpDirs.push(root);
    const skillsDir = join(root, "skills");
    mkdirSync(join(skillsDir, "linear"), { recursive: true });
    mkdirSync(join(skillsDir, "worker-overrides", "linear"), { recursive: true });
    writeFileSync(
      join(skillsDir, "linear", "SKILL.md"),
      "---\nname: linear\ndescription: Linear API\n---\n# Canonical\nmove to Human Review",
    );
    writeFileSync(
      join(skillsDir, "worker-overrides", "linear", "SKILL.md"),
      "---\nname: linear\ndescription: Linear API\n---\n# Worker\ngh pr merge --rebase then Done",
    );
    const workspace = join(root, "ws");
    mkdirSync(workspace, { recursive: true });
    copySkills(workspace, skillsDir);

    for (const base of [".forge/skills", ".claude/skills"]) {
      const content = readFileSync(
        join(workspace, ...base.split("/"), "linear", "SKILL.md"),
        "utf-8",
      );
      expect(content).toContain("gh pr merge --rebase");
      expect(content).not.toContain("Human Review");
    }
  });

  it("does not copy worker-overrides/ as its own skill subdirectory", () => {
    const { skillsDir, workspace } = stageSkillsSource();
    copySkills(workspace, skillsDir);
    expect(existsSync(join(workspace, ".forge", "skills", "worker-overrides"))).toBe(false);
  });

  it("excludes worker-overrides/ from the skills manifest (one linear entry)", () => {
    const { skillsDir, workspace } = stageSkillsSource();
    copySkills(workspace, skillsDir);
    const manifest = loadSkillsManifest(skillsDir) ?? "";
    expect(manifest).not.toContain("worker-overrides");
    expect(manifest.match(/\(\.forge\/skills\/linear\.md\)/g) ?? []).toHaveLength(1);
  });
});

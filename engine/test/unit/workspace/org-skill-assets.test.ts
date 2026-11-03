import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyWorkspaceAssets } from "../../../src/workspace/copy-assets.js";

let root: string;
let skillsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-org-skills-"));
  skillsDir = join(root, "skills");
  mkdirSync(join(skillsDir, "commit"), { recursive: true });
  writeFileSync(join(skillsDir, "commit", "SKILL.md"), "built-in commit skill");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function workspace(): string {
  const path = join(root, "ws");
  mkdirSync(path, { recursive: true });
  return path;
}

describe("copyWorkspaceAssets", () => {
  it("writes each org skill to both agent load paths", async () => {
    const ws = workspace();
    await copyWorkspaceAssets(ws, {
      skillsDir,
      loadOrgSkills: async () => [{ name: "no-silent-catch", content: "Never swallow an error." }],
    });

    expect(readFileSync(join(ws, ".forge/skills/org/no-silent-catch/SKILL.md"), "utf-8")).toBe(
      "Never swallow an error.",
    );
    expect(readFileSync(join(ws, ".claude/skills/org/no-silent-catch/SKILL.md"), "utf-8")).toBe(
      "Never swallow an error.",
    );
  });

  it("still copies the built-in skills alongside the org ones", async () => {
    const ws = workspace();
    await copyWorkspaceAssets(ws, {
      skillsDir,
      loadOrgSkills: async () => [{ name: "r", content: "rule" }],
    });
    expect(existsSync(join(ws, ".forge/skills/commit/SKILL.md"))).toBe(true);
  });

  it("creates no org directory at all when the feature is off", async () => {
    const ws = workspace();
    // No provider — exactly what an unflagged deploy passes.
    await copyWorkspaceAssets(ws, { skillsDir });
    expect(existsSync(join(ws, ".forge/skills/org"))).toBe(false);
    expect(existsSync(join(ws, ".claude/skills/org"))).toBe(false);

    // A provider that resolves empty (both gates open, nothing approved yet)
    // must behave identically.
    await copyWorkspaceAssets(ws, { skillsDir, loadOrgSkills: async () => [] });
    expect(existsSync(join(ws, ".forge/skills/org"))).toBe(false);
  });

  it("does not let an org skill overwrite a built-in one — org rules are namespaced", async () => {
    const ws = workspace();
    await copyWorkspaceAssets(ws, {
      skillsDir,
      loadOrgSkills: async () => [{ name: "commit", content: "org override attempt" }],
    });
    expect(readFileSync(join(ws, ".forge/skills/commit/SKILL.md"), "utf-8")).toBe(
      "built-in commit skill",
    );
    expect(readFileSync(join(ws, ".forge/skills/org/commit/SKILL.md"), "utf-8")).toBe(
      "org override attempt",
    );
  });
});

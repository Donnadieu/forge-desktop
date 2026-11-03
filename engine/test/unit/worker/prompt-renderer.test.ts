import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NormalizedIssue } from "../../../src/tracker/types.js";
import {
  buildPromptContext,
  loadSkillsManifest,
  renderPrompt,
} from "../../../src/worker/prompt-renderer.js";

const testIssue: NormalizedIssue = {
  id: "issue-1",
  identifier: "MT-42",
  title: "Fix login bug",
  description: "Users can't log in with special characters in password",
  state: "Todo",
  priority: 1,
  labels: ["bug", "auth"],
  blockedBy: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

describe("renderPrompt", () => {
  it("renders issue variables into template", () => {
    const template = "Working on **{{ issue.identifier }}**: {{ issue.title }}";
    const context = buildPromptContext(testIssue);
    const result = renderPrompt(template, context);
    expect(result).toBe("Working on **MT-42**: Fix login bug");
  });

  it("renders description", () => {
    const template = "## Task\n{{ issue.description }}";
    const context = buildPromptContext(testIssue);
    const result = renderPrompt(template, context);
    expect(result).toContain("Users can't log in");
  });

  it("renders labels array", () => {
    const template = "Labels: {% for label in issue.labels %}{{ label }} {% endfor %}";
    const context = buildPromptContext(testIssue);
    const result = renderPrompt(template, context);
    expect(result).toContain("bug");
    expect(result).toContain("auth");
  });

  it("renders attempt number", () => {
    const template = "{% if attempt %}Retry attempt #{{ attempt }}{% endif %}";
    const context = buildPromptContext(testIssue, 3);
    const result = renderPrompt(template, context);
    expect(result).toContain("Retry attempt #3");
  });

  it("handles missing optional fields gracefully", () => {
    const template = "Assignee: {{ issue.assignee | default: 'unassigned' }}";
    const context = buildPromptContext(testIssue);
    const result = renderPrompt(template, context);
    expect(result).toContain("unassigned");
  });

  it("renders the existing PR link when the tracker found one", () => {
    const template = "{% if issue.existing_pr_url %}PR: {{ issue.existing_pr_url }}{% endif %}";
    const context = buildPromptContext({
      ...testIssue,
      existingPrUrl: "https://github.com/acme/widgets/pull/213",
    });
    const result = renderPrompt(template, context);
    expect(result).toBe("PR: https://github.com/acme/widgets/pull/213");
  });

  it("omits the existing PR link when the tracker found none", () => {
    const template = "PR: {{ issue.existing_pr_url }}";
    const context = buildPromptContext(testIssue);
    const result = renderPrompt(template, context);
    expect(result).toBe("PR: ");
  });

  it("renders full WORKFLOW.md-style template", () => {
    const template = `You are an expert software engineer working on ticket **{{ issue.identifier }}**: {{ issue.title }}

## Task Description
{{ issue.description }}

## Priority
{{ issue.priority }}

## Labels
{% for label in issue.labels %}- {{ label }}
{% endfor %}`;

    const context = buildPromptContext(testIssue);
    const result = renderPrompt(template, context);
    expect(result).toContain("MT-42");
    expect(result).toContain("Fix login bug");
    expect(result).toContain("Users can't log in");
    expect(result).toContain("- bug");
    expect(result).toContain("- auth");
  });

  it("throws on unknown variables in strict mode", () => {
    const template = "{{ nonexistent_var }}";
    expect(() => renderPrompt(template, buildPromptContext(testIssue))).toThrow();
  });
});

describe("buildPromptContext", () => {
  it("maps NormalizedIssue to PromptContext", () => {
    const context = buildPromptContext(testIssue);
    expect(context.issue.id).toBe("issue-1");
    expect(context.issue.identifier).toBe("MT-42");
    expect(context.issue.title).toBe("Fix login bug");
    expect(context.issue.priority).toBe(1);
    expect(context.issue.labels).toEqual(["bug", "auth"]);
    expect(context.attempt).toBeUndefined();
  });

  it("includes attempt when provided", () => {
    const context = buildPromptContext(testIssue, 2);
    expect(context.attempt).toBe(2);
  });

  it("maps blockedBy to simplified form", () => {
    const issueWithBlockers: NormalizedIssue = {
      ...testIssue,
      blockedBy: [
        {
          id: "blocker-1",
          identifier: "MT-41",
          state: "In Progress",
        },
      ],
    };
    const context = buildPromptContext(issueWithBlockers);
    expect(context.issue.blockedBy).toEqual([
      { id: "blocker-1", identifier: "MT-41", state: "In Progress" },
    ]);
  });

  it("includes skills manifest when provided", () => {
    const manifest = "Available skills:\n- commit: Git commit";
    const context = buildPromptContext(testIssue, 1, manifest);
    expect(context.skills_manifest).toBe(manifest);
  });

  it("skills_manifest is undefined when not provided", () => {
    const context = buildPromptContext(testIssue);
    expect(context.skills_manifest).toBeUndefined();
  });
});

describe("loadSkillsManifest", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("builds manifest from skill frontmatter", () => {
    tempDir = join(tmpdir(), `forge-skills-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, "commit.md"),
      "---\nname: commit\ndescription: Create well-formed git commits\n---\n# Commit",
    );
    writeFileSync(
      join(tempDir, "push.md"),
      "---\nname: push\ndescription: Push branch and create PR\n---\n# Push",
    );

    const manifest = loadSkillsManifest(tempDir);
    expect(manifest).toContain("Available workflow skills");
    expect(manifest).toContain(
      "- commit (.forge/skills/commit.md): Create well-formed git commits",
    );
    expect(manifest).toContain("- push (.forge/skills/push.md): Push branch and create PR");
  });

  it("discovers subdirectory skills with their nested path", () => {
    tempDir = join(tmpdir(), `forge-skills-nested-${Date.now()}`);
    mkdirSync(join(tempDir, "dev-browser"), { recursive: true });
    writeFileSync(
      join(tempDir, "dev-browser", "SKILL.md"),
      "---\nname: dev-browser\ndescription: Browser automation\n---\n# Dev Browser",
    );

    const manifest = loadSkillsManifest(tempDir);
    expect(manifest).toContain(
      "- dev-browser (.forge/skills/dev-browser/SKILL.md): Browser automation",
    );
  });

  it("excludes nested non-SKILL.md files (references/assets/utilities) from the manifest", () => {
    tempDir = join(tmpdir(), `forge-skills-nested-assets-${Date.now()}`);
    mkdirSync(join(tempDir, "qa-plan", "assets"), { recursive: true });
    mkdirSync(join(tempDir, "code-review", "utilities"), { recursive: true });
    writeFileSync(
      join(tempDir, "qa-plan", "SKILL.md"),
      "---\nname: qa-plan\ndescription: QA plan\n---\n# QA",
    );
    // Supporting material that must NOT surface as its own skill.
    writeFileSync(join(tempDir, "qa-plan", "assets", "template.md"), "# template");
    writeFileSync(join(tempDir, "code-review", "utilities", "code-analyzer.md"), "# util");

    const manifest = loadSkillsManifest(tempDir);
    expect(manifest).toContain("- qa-plan (.forge/skills/qa-plan/SKILL.md): QA plan");
    expect(manifest).not.toContain("assets/template");
    expect(manifest).not.toContain("utilities/code-analyzer");
  });

  it("returns undefined for nonexistent directory", () => {
    expect(loadSkillsManifest("/nonexistent/path")).toBeUndefined();
  });

  it("returns undefined for empty directory", () => {
    tempDir = join(tmpdir(), `forge-skills-empty-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    expect(loadSkillsManifest(tempDir)).toBeUndefined();
  });

  it("uses filename as fallback when frontmatter name is missing", () => {
    tempDir = join(tmpdir(), `forge-skills-noname-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "debug.md"), "---\ndescription: Debug failures\n---\n# Debug");

    const manifest = loadSkillsManifest(tempDir);
    expect(manifest).toContain("- debug (.forge/skills/debug.md): Debug failures");
  });
});

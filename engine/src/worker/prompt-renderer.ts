import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { Liquid } from "liquidjs";
import type { NormalizedIssue } from "../tracker/types.js";
import { WORKER_OVERRIDES_DIR } from "../workspace/copy-assets.js";

const engine = new Liquid({ strictVariables: true, strictFilters: true });

export interface PromptContext {
  issue: {
    id: string;
    identifier: string;
    title: string;
    description: string;
    state: string;
    priority: number | null;
    labels: string[];
    url: string;
    assignee?: string;
    blockedBy: Array<{ id?: string; identifier?: string; state?: string }>;
    existing_pr_url: string;
  };
  attempt?: number;
  skills_manifest?: string;
}

export function renderPrompt(template: string, context: PromptContext): string {
  return engine.parseAndRenderSync(template, context);
}

export function buildPromptContext(
  issue: NormalizedIssue,
  attempt?: number,
  skillsManifest?: string,
): PromptContext {
  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      state: issue.state,
      priority: issue.priority,
      labels: issue.labels,
      url: issue.url ?? "",
      assignee: issue.assignee ?? "",
      blockedBy: issue.blockedBy.map((b) => ({
        id: b.id,
        identifier: b.identifier,
        state: b.state,
      })),
      existing_pr_url: issue.existingPrUrl ?? "",
    },
    attempt,
    skills_manifest: skillsManifest,
  };
}

/**
 * Render the first-turn prompt. A re-dispatch (attempt > 1) appends the
 * continuation context AFTER the rendered body so the byte-stable prompt
 * prefix stays identical across attempts and the provider's prefix cache
 * stays warm.
 */
export function renderFirstTurnPrompt(
  template: string,
  issue: NormalizedIssue,
  attempt: number,
  skillsManifest?: string,
): string {
  const prompt = renderPrompt(template, buildPromptContext(issue, attempt, skillsManifest));
  if (attempt <= 1) return prompt;
  return `${prompt}

---

CONTINUATION DISPATCH (attempt #${attempt})

This workspace contains work from ${attempt - 1} prior dispatch(es) that completed normally.
The issue is still in an active state — more work is needed.

CRITICAL INSTRUCTIONS:
- Read the workpad FIRST to see which plan steps are already marked complete.
- Do NOT redo completed steps or re-run validations that already passed.
- Resume from the NEXT INCOMPLETE step in the plan.
- Focus on implementation, not re-verification of prior work.`;
}

/**
 * Recursively collect skill *entrypoint* files, returning paths relative to the
 * skills root. A skill's entrypoint is its `<name>/SKILL.md` (folder-per-command
 * model, e.g. `commit/SKILL.md`, `dev-browser/SKILL.md`) or a legacy top-level
 * flat `<name>.md`. Nested non-`SKILL.md` markdown that lives *inside* a skill
 * (its `references/`, `assets/`, `examples/`, `utilities/`, `README.md`) is
 * supporting material, not a skill, so it is deliberately excluded — otherwise
 * the manifest advertises dozens of doc fragments as if they were runnable skills.
 */
function collectSkillFiles(skillsDir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // worker-overrides/ holds variants overlaid onto top-level skills at copy
      // time (see copy-assets.ts); it is not a separate skill to advertise.
      if (!prefix && entry.name === WORKER_OVERRIDES_DIR) continue;
      found.push(...collectSkillFiles(join(skillsDir, entry.name), rel));
    } else if (entry.name === "SKILL.md" || (prefix === "" && entry.name.endsWith(".md"))) {
      found.push(rel);
    }
  }
  return found;
}

/**
 * Load a skills manifest from a directory of skill markdown files.
 * Returns a compact index listing each skill's name, relative path, and
 * description. Descends into subdirectories so `<dir>/SKILL.md` skills are
 * discoverable, not just top-level `*.md` files.
 *
 * Name/description come from the *source* skill's frontmatter, while the body the
 * agent later reads may be a worker-overrides variant overlaid at copy time. This
 * is fine only because each override shares its canonical skill's frontmatter
 * verbatim; if an override ever changes name/description, the manifest would
 * describe the canonical while the agent reads the variant.
 */
export function loadSkillsManifest(skillsDir: string): string | undefined {
  if (!existsSync(skillsDir)) return undefined;

  const files = collectSkillFiles(skillsDir).sort();
  if (files.length === 0) return undefined;

  const entries: string[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(skillsDir, file), "utf-8");
      const { data } = matter(content);
      const name = (data.name as string) || file.replace(/\/?SKILL\.md$/, "").replace(/\.md$/, "");
      const desc = (data.description as string) || "";
      entries.push(`- ${name} (.forge/skills/${file}): ${desc}`);
    } catch {
      // Skip files that can't be parsed
    }
  }

  if (entries.length === 0) return undefined;

  return [
    "Available workflow skills (read the listed path for full instructions):",
    ...entries,
  ].join("\n");
}

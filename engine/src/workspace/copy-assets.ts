import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { configureWorkspaceGitIdentity } from "./git-identity.js";

/**
 * One org-owned skill, reduced to what the workspace layer needs to write it to
 * disk. Deliberately structural rather than the `org_skills` row type: the
 * workspace layer is Layer 1 infrastructure and must not depend on `db/`, so the
 * caller (see `pipeline/org-skills-loader.ts`) narrows the row down to this.
 */
export interface OrgSkillFile {
  name: string;
  content: string;
}

/**
 * Skills that ship a worker-specific override. The canonical skill (e.g.
 * `.agents/skills/linear/SKILL.md`, which carries the human-operated workflow's
 * `Human Review` lifecycle) is preserved verbatim, but unattended factory/Smith
 * workers — whose lifecycle is owned by WORKFLOW.md (merge `--rebase` → `Done`,
 * never stop at review) — receive the variant from
 * `.agents/skills/worker-overrides/<name>/SKILL.md` overlaid on top. Without this,
 * a worker that dutifully follows the canonical `linear` skill moves its finished
 * ticket to `In Review` and halts, stalling the build.
 */
export const WORKER_OVERRIDES_DIR = "worker-overrides";

/** Everything a freshly-prepared workspace is populated with before the agent runs. */
export interface WorkspaceAssetSources {
  skillsDir?: string;
  templatesDir?: string;
  /** See `WorkspaceConfig.loadOrgSkills` — absent ⇒ built-in skills only. */
  loadOrgSkills?: () => Promise<OrgSkillFile[]>;
}

/**
 * Populate a workspace with the assets the agent reads: the built-in skills,
 * the org's own skills overlaid on top of them, and the Smith templates. Also
 * gives the workspace its env-configured commit identity (see
 * `git-identity.ts`; a no-op when the operator set none).
 */
export async function copyWorkspaceAssets(
  workspacePath: string,
  sources: WorkspaceAssetSources,
): Promise<void> {
  if (sources.skillsDir) copySkills(workspacePath, sources.skillsDir);

  // The provider returns an empty list whenever either feature gate is closed,
  // so this is a no-op for an unflagged deploy.
  const orgSkills = sources.loadOrgSkills ? await sources.loadOrgSkills() : [];
  copyOrgSkills(workspacePath, orgSkills);

  if (sources.templatesDir) copyTemplates(workspacePath, sources.templatesDir);

  configureWorkspaceGitIdentity(workspacePath);
}

/**
 * Copy skill files from the configured skills directory into the workspace, so
 * every path a WORKFLOW.md prompt names a skill by resolves:
 *
 *   - `.forge/skills/<name>/SKILL.md` — the path the skills manifest
 *     (`worker/prompt-renderer.ts`) advertises.
 *   - `skills/<name>/SKILL.md` — the bare path WORKFLOW.md prose uses ("open
 *     and follow `skills/land/SKILL.md`"). A top-level `skills` symlink to
 *     `.forge/skills`, created only when the client repo has no `skills` of
 *     its own.
 *   - `.claude/skills/<name>/SKILL.md` — where Claude Code's Skill tool looks.
 *     (A previous version wrote `.claude/commands/`, the slash-command folder,
 *     so the agent only ever saw the client repo's own skills.) A name the
 *     client repo already has there is left alone, never overwritten: it may
 *     be a tracked file or a symlink into the client's tracked tree.
 *
 * Every path written here is added to the checkout's local `.git/info/exclude`,
 * so the `before_run` hook's `git clean -fd` keeps it and an agent's
 * `git add -A` never commits it into the client repo.
 *
 * Recursively copies .md files from subdirectories (e.g. frontend-design/SKILL.md),
 * then overlays the worker variants (see {@link WORKER_OVERRIDES_DIR}).
 */
export function copySkills(workspacePath: string, skillsDir: string): void {
  if (!existsSync(skillsDir)) return;

  const forgeDir = join(workspacePath, ".forge", "skills");
  mkdirSync(forgeDir, { recursive: true });
  const claudeDir = join(workspacePath, ".claude", "skills");
  const clientOwned = clientOwnedClaudeSkills(workspacePath);
  mkdirSync(claudeDir, { recursive: true });

  // Copy every skill except worker-overrides/, then overlay the worker variants
  // (mirroring each override's relative path) on top of the matching skill.
  const mirrored: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === WORKER_OVERRIDES_DIR) continue;
    const destDirs = [forgeDir];
    if (!clientOwned.has(entry.name)) {
      destDirs.push(claudeDir);
      mirrored.push(entry.name);
    }
    copyMarkdownEntry(skillsDir, entry.name, entry.isDirectory(), destDirs, WORKER_OVERRIDES_DIR);
  }
  const overridesDir = join(skillsDir, WORKER_OVERRIDES_DIR);
  if (existsSync(overridesDir)) {
    for (const entry of readdirSync(overridesDir, { withFileTypes: true })) {
      const destDirs = clientOwned.has(entry.name) ? [forgeDir] : [forgeDir, claudeDir];
      copyMarkdownEntry(overridesDir, entry.name, entry.isDirectory(), destDirs);
    }
  }

  // Only ever our own symlink: a client repo's real `skills/` stays untouched
  // and un-excluded, so new files an agent adds there are still committed.
  const skillsLink = join(workspacePath, "skills");
  const linkTarget = join(".forge", "skills");
  if (!pathExists(skillsLink)) symlinkSync(linkTarget, skillsLink);
  const ownLink = lstatSync(skillsLink).isSymbolicLink() && readlinkSync(skillsLink) === linkTarget;

  excludeFromGit(workspacePath, [
    "/.forge/",
    ...(ownLink ? ["/skills"] : []),
    ...mirrored.map((name) => `/.claude/skills/${name}`),
  ]);
}

/**
 * Copy approved org skills into the workspace so the agent can load them.
 * Each skill is written to `.forge/skills/org/<name>/SKILL.md` and mirrored
 * to `.claude/skills/org/<name>/SKILL.md` (see {@link copySkills} for why
 * `.claude/skills/`, not `.claude/commands/`).
 */
export function copyOrgSkills(workspacePath: string, skills: OrgSkillFile[]): void {
  if (skills.length === 0) return;

  const forgeDir = join(workspacePath, ".forge", "skills", "org");
  const claudeDir = join(workspacePath, ".claude", "skills", "org");
  mkdirSync(forgeDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });

  for (const skill of skills) {
    const skillDir = join(forgeDir, skill.name);
    const claudeSkillDir = join(claudeDir, skill.name);
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(claudeSkillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), skill.content);
    writeFileSync(join(claudeSkillDir, "SKILL.md"), skill.content);
  }
  excludeFromGit(workspacePath, ["/.forge/", "/.claude/skills/org"]);
}

/** Copy one top-level skills entry (a skill dir or a flat `.md`) into each of `destDirs`. */
function copyMarkdownEntry(
  srcDir: string,
  name: string,
  isDirectory: boolean,
  destDirs: string[],
  skipDirName?: string,
): void {
  if (isDirectory) {
    const subDirs = destDirs.map((dest) => {
      const sub = join(dest, name);
      mkdirSync(sub, { recursive: true });
      return sub;
    });
    copyMarkdownTree(join(srcDir, name), subDirs, skipDirName);
  } else if (name.endsWith(".md")) {
    for (const dest of destDirs) copyFileSync(join(srcDir, name), join(dest, name));
  }
}

/**
 * Names under the client repo's `.claude/skills/` that belong to the client:
 * tracked in its git index, or a symlink (ConstructEase links each skill to
 * its tracked `.agents/skills/<name>`, so writing through one would edit the
 * client's own files). Forge's previous copies are untracked plain dirs, so
 * they stay refreshable.
 */
function clientOwnedClaudeSkills(workspacePath: string): Set<string> {
  const owned = new Set<string>();
  const claudeDir = join(workspacePath, ".claude", "skills");
  if (existsSync(claudeDir)) {
    for (const entry of readdirSync(claudeDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) owned.add(entry.name);
    }
  }
  const tracked = gitOutput(workspacePath, ["ls-files", "-z", "--", ".claude/skills"]);
  for (const path of tracked?.split("\0") ?? []) {
    const name = path.split("/")[2];
    if (name) owned.add(name);
  }
  return owned;
}

/**
 * Append `patterns` to the checkout's local `.git/info/exclude` (never the
 * client's committed `.gitignore`), skipping any already listed so repeated
 * dispatches don't pile up duplicates. A no-op outside a git checkout.
 */
function excludeFromGit(workspacePath: string, patterns: readonly string[]): void {
  const rel = gitOutput(workspacePath, ["rev-parse", "--git-path", "info/exclude"])?.trim();
  if (!rel) return;
  const excludePath = resolve(workspacePath, rel);
  mkdirSync(join(excludePath, ".."), { recursive: true });
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = patterns.filter((p) => !present.has(p));
  if (missing.length === 0) return;
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(excludePath, `${sep}${missing.join("\n")}\n`);
}

/** `git <args>` stdout in `cwd`, or `undefined` when it isn't a git checkout (or git fails). */
function gitOutput(cwd: string, args: string[]): string | undefined {
  if (!existsSync(join(cwd, ".git"))) return undefined;
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return undefined;
  }
}

/** True if `path` exists, including a dangling symlink (which `existsSync` reports as absent). */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively copy every `.md` file under `srcDir` into each of `destDirs`,
 * preserving the subdirectory structure (so `<name>/SKILL.md` lands at
 * `<dest>/<name>/SKILL.md`). A directory named `skipDirName`, if given, is not
 * descended into.
 */
function copyMarkdownTree(srcDir: string, destDirs: string[], skipDirName?: string): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === skipDirName) continue;
    const srcPath = join(srcDir, entry.name);
    if (entry.isDirectory()) {
      const subDirs = destDirs.map((dest) => {
        const sub = join(dest, entry.name);
        mkdirSync(sub, { recursive: true });
        return sub;
      });
      copyMarkdownTree(srcPath, subDirs, skipDirName);
    } else if (entry.name.endsWith(".md")) {
      for (const dest of destDirs) copyFileSync(srcPath, join(dest, entry.name));
    }
  }
}

/**
 * Copy Smith template files into the workspace so one-shot workers can
 * start from the battle-tested Dockerfile, nginx.conf, and start.sh instead
 * of writing them from scratch.
 */
export function copyTemplates(workspacePath: string, templatesDir: string): void {
  if (!existsSync(templatesDir)) return;

  const targetDir = join(workspacePath, ".forge", "templates", "forgesmith");
  mkdirSync(targetDir, { recursive: true });

  const entries = readdirSync(templatesDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(templatesDir, entry.name);
    if (entry.isDirectory()) {
      // Skip nested directories (web-dist, ui, etc.) — only copy infra files
      continue;
    }
    copyFileSync(srcPath, join(targetDir, entry.name));
  }
}

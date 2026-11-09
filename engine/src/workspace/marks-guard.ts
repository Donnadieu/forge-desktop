import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findMarks, marksRefusal } from "../tracker/marks.js";

/**
 * "Keep Forge invisible", enforced where the agent's work leaves the Mac. Prompts alone can be ignored, so with
 * the switch on each card's folder gets two guards, both running `marks-guard.js` (src/marks-guard.ts):
 *   - Claude Code's PreToolUse hook (the card's `.claude/settings.local.json`): before a `git push` or a `gh`
 *     write runs. Claude Code's shell resets PATH, so a wrapper `gh`/`git` on PATH would be skipped.
 *   - git's own `pre-push` hook (`.git/hooks`), for any agent, when the repo doesn't route hooks elsewhere.
 * Both refuse with a plain reason the agent reads and acts on. New in Forge Desktop.
 */

/** Marks the hook entries and the pre-push file as ours, so turning the switch off removes exactly them. */
const OURS = "marks-guard";

type HookEntry = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };

/** `settings` with our PreToolUse entry set to `command` (or removed when undefined); other hooks are kept. */
export function withClaudeGuard(
  settings: Record<string, unknown>,
  command: string | undefined,
): Record<string, unknown> {
  const hooks = (
    settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}
  ) as Record<string, unknown>;
  const pre = (Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []) as HookEntry[];
  const kept = pre.filter((e) => !e.hooks?.some((h) => h.command?.includes(OURS)));
  if (command)
    kept.push({ matcher: "Bash", hooks: [{ type: "command", command: `${command} claude-hook` }] });
  const next = { ...settings };
  const rest = { ...hooks };
  if (kept.length > 0) rest.PreToolUse = kept;
  else delete rest.PreToolUse;
  if (Object.keys(rest).length > 0) next.hooks = rest;
  else delete next.hooks;
  return next;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Writes (or removes) our `pre-push` hook. Left alone when the repo sends its hooks elsewhere
 * (`core.hooksPath`, e.g. husky: a file there could end up committed) or already has a pre-push of its own.
 */
export function setPrePushGuard(workspacePath: string, command: string | undefined): void {
  if (git(workspacePath, ["config", "--get", "core.hooksPath"])) return;
  const dir = git(workspacePath, ["rev-parse", "--git-path", "hooks"]);
  if (!dir) return;
  const file = resolve(workspacePath, dir, "pre-push");
  const existing = existsSync(file) ? readFileSync(file, "utf-8") : null;
  if (existing !== null && !existing.includes(OURS)) return;
  if (!command) {
    if (existing !== null) rmSync(file);
    return;
  }
  writeFileSync(file, `#!/bin/sh\n# ${OURS}: what others see\nexec ${command} pre-push "$@"\n`);
  chmodSync(file, 0o755);
}

const ZERO = /^0+$/;

/** Problems with commits about to be pushed: a mark in a message or branch, or someone else's name on it. */
export function checkPush(
  cwd: string,
  updates: Array<{ localSha: string; remoteRef: string; remoteSha: string }> = [],
): string[] {
  const ranges =
    updates.length > 0
      ? updates
          .filter((u) => !ZERO.test(u.localSha))
          .map((u) => ({
            args: ZERO.test(u.remoteSha)
              ? [u.localSha, "--not", "--remotes"]
              : [`${u.remoteSha}..${u.localSha}`],
            ref: u.remoteRef,
          }))
      : [
          {
            args: ["HEAD", "--not", "--remotes"],
            ref: git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]) ?? "",
          },
        ];
  const expected = git(cwd, ["config", "--get", "user.email"])?.toLowerCase();
  const problems: string[] = [];
  for (const r of ranges) {
    const branch = r.ref.replace(/^refs\/heads\//, "");
    const inName = findMarks(branch);
    if (inName.length > 0) problems.push(marksRefusal(`the branch name ${branch}`, inName));
    const log = git(cwd, ["log", "--format=%h%x1f%an%x1f%ae%x1f%ce%x1f%B%x1e", ...r.args]) ?? "";
    for (const entry of log.split("\x1e")) {
      const [sha, name, email, committer, message] = entry.replace(/^\s+/, "").split("\x1f");
      if (!sha) continue;
      const found = findMarks(message);
      if (found.length > 0) problems.push(marksRefusal(`commit ${sha}'s message`, found));
      for (const who of [email, committer]) {
        if (expected && who && who.toLowerCase() !== expected) {
          problems.push(
            `Refused: commit ${sha} is by ${name} <${who}>, not ${expected}. Commit only as this folder's git identity.`,
          );
          break;
        }
      }
    }
  }
  return problems;
}

/** `gh` commands that only read: everything else that can write is checked. */
const GH_READS =
  /^(?:pr|issue)\s+(?:view|list|diff|checks|status|checkout)\b|^(?:repo|run|workflow|auth|release)\s+(?:view|list|clone|watch|status|download)\b/;

/** Folders that name the app on this Mac (the card's own folder and Forge's), cut before the text is read. */
function withoutLocalPaths(text: string, cwd: string): string {
  let out = text;
  for (let p = cwd; p.length > 1 && p.includes("/"); p = dirname(p)) {
    for (const form of [p, p.replace(/ /g, "\\ ")]) out = out.split(form).join(" ");
    if (p.split("/").length <= 3) break;
  }
  // The agent's own scratch folder inside the card, never shown to anyone.
  return out.replace(/(?:\.\/)?\.forge\/[^\s'"`]*/g, " ");
}

/** Problems with a `gh` write in a shell command: its title, body, labels, fields and any body file. */
export function checkGh(command: string, cwd: string): string[] {
  const at = command.search(/\bgh\s+(?:pr|issue|api|label|release|repo|gist)\b/);
  if (at < 0) return [];
  const tail = command.slice(at + 2).trim();
  if (
    GH_READS.test(tail) ||
    (/^api\b/.test(tail) && !/\s(?:-f|-F|--field|--raw-field|--input|-X|--method)\b/.test(tail))
  )
    return [];
  let text = withoutLocalPaths(tail, cwd);
  const files = [
    ...tail.matchAll(/(?:--body-file|--input|(?<!\S)-F)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g),
  ];
  for (const f of files) {
    const path = f[1] ?? f[2] ?? f[3];
    if (!path || path === "-" || path.includes("=")) continue;
    try {
      text += `\n${readFileSync(resolve(cwd, path), "utf-8")}`;
    } catch {
      // not a file (an api field `-F key=value` is in the text already)
    }
  }
  const found = findMarks(text);
  return found.length > 0 ? [marksRefusal("this pull request or issue text", found)] : [];
}

/** Claude Code's PreToolUse input → the refusal to give back (empty = let it run). */
export function claudeHookProblems(input: {
  tool_name?: string;
  tool_input?: { command?: string };
  cwd?: string;
}): string[] {
  const command = input.tool_input?.command ?? "";
  const cwd = input.cwd ?? process.cwd();
  if (input.tool_name !== "Bash" || !command) return [];
  const problems = checkGh(command, cwd);
  if (/\bgit\b[^\n;&|]*\bpush\b/.test(command)) problems.push(...checkPush(cwd));
  return problems;
}

/** The guard command for this engine: its own Node and the compiled `marks-guard.js` next to `src/index`. */
export function guardCommand(entryDir: string): string {
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const script = existsSync(join(entryDir, "marks-guard.js"))
    ? join(entryDir, "marks-guard.js")
    : join(entryDir, "marks-guard.ts");
  return `${quote(process.execPath)} ${quote(script)}`;
}

/**
 * Checkpoints: the folder is snapshotted before and after every turn (private refs under refs/forge/), each
 * turn shows what it changed, and the person can go back to before a turn: the files come back exactly, that
 * turn and every later one leave the chat, and Claude Code forgets them (its transcript is cut there and the
 * chat resumes the cut copy).
 *
 * New in Forge Desktop.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { restore, run, snapshot } from "./git.js";

export { snapshot };

export async function changesBetween(folder: string, from: string, to: string) {
  const r = await run("git", ["diff", "--numstat", from, to], folder);
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const l of r.out.split("\n").filter(Boolean)) {
    const [a, d] = l.split("\t");
    added += Number(a) || 0;
    removed += Number(d) || 0;
    files += 1;
  }
  return { added, removed, files };
}

/** Claude Code keeps a chat's transcript under ~/.claude/projects/<folder with every other character a dash>/. */
export function transcriptPath(
  folder: string,
  sessionId: string,
  claudeHome = join(homedir(), ".claude"),
): string {
  return join(claudeHome, "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

function userText(line: Record<string, unknown>): string | null {
  if (line.type !== "user") return null;
  const m = line.message as { content?: unknown } | undefined;
  if (typeof m?.content === "string") return m.content;
  if (Array.isArray(m?.content)) {
    const blocks = m.content as Record<string, unknown>[];
    if (blocks.some((b) => b.type === "tool_result")) return null;
    return blocks.map((b) => (typeof b.text === "string" ? b.text : "")).join("");
  }
  return null;
}

/**
 * Copies the transcript up to (not including) the `occurrence`-th message with this text, under a new session
 * id, so resuming it forgets everything from that message on. Returns the new id, or null when it can't.
 */
export function cutTranscript(
  folder: string,
  sessionId: string,
  text: string,
  occurrence: number,
): string | null {
  const path = transcriptPath(folder, sessionId);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  let seen = 0;
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    try {
      if (userText(JSON.parse(lines[i])) === text && ++seen === occurrence) {
        cut = i;
        break;
      }
    } catch {
      // a broken line: keep going
    }
  }
  if (cut < 0) return null;
  const id = randomUUID();
  const kept = lines.slice(0, cut).map((l) => {
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      if (o.sessionId === sessionId) o.sessionId = id;
      return JSON.stringify(o);
    } catch {
      return l;
    }
  });
  writeFileSync(transcriptPath(folder, id), kept.length ? `${kept.join("\n")}\n` : "");
  return id;
}

export { restore };

#!/usr/bin/env node
/**
 * The "Keep Forge invisible" guard, run inside a card's folder (workspace/marks-guard.ts installs it):
 *
 *   marks-guard.js claude-hook   Claude Code's PreToolUse hook: the tool call arrives as JSON on stdin; exit 2
 *                                with the reason on stderr refuses it, and the agent reads that reason
 *   marks-guard.js pre-push      git's pre-push hook: `<local ref> <local sha> <remote ref> <remote sha>` lines
 *                                on stdin; exit 1 refuses the push
 *
 * New in Forge Desktop.
 */
import { readFileSync } from "node:fs";
import { checkPush, claudeHookProblems } from "./workspace/marks-guard.js";

function stdin(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function main(mode: string | undefined): number {
  if (mode === "claude-hook") {
    let input: Parameters<typeof claudeHookProblems>[0] = {};
    try {
      input = JSON.parse(stdin());
    } catch {
      return 0;
    }
    const problems = claudeHookProblems(input);
    if (problems.length === 0) return 0;
    process.stderr.write(`${problems.join("\n")}\n`);
    return 2;
  }
  if (mode === "pre-push") {
    const updates = stdin()
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length === 4)
      .map(([, localSha, remoteRef, remoteSha]) => ({ localSha, remoteRef, remoteSha }));
    const problems = checkPush(process.cwd(), updates);
    if (problems.length === 0) return 0;
    process.stderr.write(`${problems.join("\n")}\n`);
    return 1;
  }
  process.stderr.write("usage: marks-guard claude-hook|pre-push\n");
  return 64;
}

process.exit(main(process.argv[2]));

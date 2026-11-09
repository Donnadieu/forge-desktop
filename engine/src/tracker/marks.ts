/**
 * What others see. With "Keep Forge invisible" on (the workflow's `marks.invisible`), nothing a person outside
 * this Mac can read (commits, branches, pull requests, card comments) may name the app or an AI. `findMarks`
 * is the one check every guard uses: the agents' `git push` and `gh` (marks-guard.ts) and the tracker tools
 * (mcp/). New in Forge Desktop.
 */

/** Sent to GitHub, Basecamp and Linear instead of the app's name. */
export const PLAIN_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

/** The app's own name and the usual AI signatures, each with the plain words a refusal names it by. */
const MARKS: Array<{ pattern: RegExp; what: string }> = [
  // A whole word: "forged" and "forgery" pass, "forge-desktop" and ".forge/" don't.
  { pattern: /\bforge\b/i, what: "the word Forge" },
  {
    pattern: /generated (?:with|by)\b[^\n]{0,40}\b(?:claude|codex|kimi|ai|gpt|openai)\b/i,
    what: 'a "Generated with" line',
  },
  {
    pattern:
      /co-authored-by:[^\n]*(?:claude|codex|kimi|anthropic|openai|moonshot|copilot|\[bot\])/i,
    what: "an AI co-author line",
  },
  { pattern: /🤖/u, what: "the robot emoji" },
];

/** Each mark found in `text`, with the words around it, e.g. `the word Forge ("…Forge Workpad…")`. */
export function findMarks(text: string | null | undefined): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const { pattern, what } of MARKS) {
    const m = pattern.exec(text);
    if (!m) continue;
    const start = Math.max(0, m.index - 20);
    const around = text
      .slice(start, m.index + m[0].length + 20)
      .replace(/\s+/g, " ")
      .trim();
    found.push(`${what} ("${around}")`);
  }
  return found;
}

/** The refusal an agent reads: what was found, and what to do instead. */
export function marksRefusal(where: string, found: string[]): string {
  return (
    `Refused: ${where} would show ${found.join(" and ")}. This workspace keeps its work looking like the ` +
    "person's own: write it again without naming the tool, AI or agents, then retry."
  );
}

/** The workflow's `marks` block, as the engine uses it. */
export interface MarksSettings {
  invisible: boolean;
  /** The label pull requests get; empty = none. */
  prLabel: string;
  /** Put before the card's id in branch names (`omar/` → `omar/bc-123`); empty = the tracker's own name. */
  branchPrefix: string;
}

/** The `marks` block with its defaults: Forge's `forge` label stays unless the workspace is invisible. */
export function resolveMarks(
  raw: { invisible?: boolean; pr_label?: string; branch_prefix?: string } = {},
): MarksSettings {
  const invisible = raw.invisible ?? false;
  return {
    invisible,
    prLabel: (raw.pr_label ?? (invisible ? "" : "forge")).trim(),
    branchPrefix: (raw.branch_prefix ?? "").trim(),
  };
}

/**
 * The note put after the lead's instructions: the pull request label to add, and with the switch on, the rule
 * that nothing others see names the tool. Config-constant, so the prompt prefix stays byte-stable.
 */
export function marksNote(m: MarksSettings): string {
  const lines = ["", "## What others see", ""];
  lines.push(
    m.prLabel
      ? `- Pull request label: \`${m.prLabel}\`. Add it to the pull request (create the label if it is missing).`
      : "- Pull request label: none. Do not add a label of your own to the pull request.",
  );
  if (m.invisible) {
    lines.push(
      "- Everything others can read must look like the person's own work: commits, branch names, pull request",
      "  titles, bodies, comments and labels, review replies, and card comments. Never name the tool running you,",
      '  an AI, a model or agents there. No "Generated with" lines, no co-author lines, no robot emoji.',
      "- Commit only as the git identity this folder is set up with.",
      "- Card notes: head the workpad `## Workpad` and the triage notes `## Triage notes`. An older card's",
      "  workpad headed with the tool's name: reuse it and change its heading to `## Workpad` on your next update.",
      "- Pushes, pull request text and card comments that break this are refused; write them again plainly.",
    );
  }
  return `${lines.join("\n")}\n`;
}

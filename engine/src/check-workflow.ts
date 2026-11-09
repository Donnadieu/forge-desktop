#!/usr/bin/env node
/**
 * `check-workflow.js [file]`: checks a workflow file (or stdin) the way the engine will read it, and prints one
 * JSON line, `{"problems":[{"line":N,"message":"…"}]}` (empty list = fine). Workflow Studio's "Edit workflow
 * file" runs it before saving. New in Forge Desktop.
 */
import { readFileSync } from "node:fs";
import matter from "gray-matter";
import { checkWorkflowText, type WorkflowProblem } from "./config/workflow-check.js";
import { renderPrompt } from "./worker/prompt-renderer.js";

/** The instructions' {{ … }} parts must fill from a card, or every run of the file fails at dispatch. */
function templateProblems(text: string): WorkflowProblem[] {
  const body = matter(text, { delimiters: "---" }).content;
  const offset = text.length - body.length;
  try {
    renderPrompt(body, {
      issue: {
        id: "1",
        identifier: "CARD-1",
        title: "A card",
        description: "",
        state: "Todo",
        priority: null,
        labels: [],
        url: "",
        assignee: "",
        blockedBy: [],
        existing_pr_url: "",
      },
      attempt: 1,
    });
    return [];
  } catch (err) {
    const e = err as { token?: { getPosition?: () => number[] }; message?: string };
    const before = text.slice(0, offset).split("\n").length - 1;
    const at = e.token?.getPosition?.()[0];
    const line = at ? before + at : before + 1;
    const reason = (e.message ?? "").split(",")[0];
    return [
      { line, message: `The instructions use {{ … }} in a way a card can't fill: ${reason}.` },
    ];
  }
}

export function checkWorkflow(text: string): WorkflowProblem[] {
  const problems = checkWorkflowText(text);
  return problems.length > 0 ? problems : templateProblems(text);
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isDirectExecution) {
  const text = readFileSync(process.argv[2] ?? 0, "utf-8");
  process.stdout.write(`${JSON.stringify({ problems: checkWorkflow(text) })}\n`);
}

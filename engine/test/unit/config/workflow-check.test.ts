import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/check-workflow.js";
import { checkWorkflowText } from "../../../src/config/workflow-check.js";

const LEAD = readFileSync(join(import.meta.dirname, "../../../workflow/lead.md"), "utf-8");

/** A file shaped like the one the app writes. */
const FILE = `---
tracker:
  kind: basecamp
  project_slug: "46658058"
  active_states: ["Todo", "In Progress"]
workspace:
  root: "/tmp/cards"
  base_branch: "main"
agent:
  kind: claude
  max_concurrent_agents: 4
  max_turns: 20
marks:
  invisible: true
  branch_prefix: "omar/"
polling:
  interval_ms: 30000
---
${LEAD}`;

const lineOf = (text: string, needle: string) =>
  text.split("\n").findIndex((l) => l.includes(needle)) + 1;

describe("checking a hand-edited workflow file", () => {
  it("passes the file the app writes, with the real lead instructions", () => {
    expect(checkWorkflow(FILE)).toEqual([]);
  });

  it("names a setting it doesn't know, on its line, with the one meant", () => {
    const text = FILE.replace("  max_concurrent_agents: 4", "  max_agents: 4");
    expect(checkWorkflowText(text)).toEqual([
      {
        line: lineOf(text, "max_agents"),
        message: "max_agents isn't a setting Forge knows. Did you mean max_concurrent_agents?",
      },
    ]);
  });

  it("finds an unknown key deeper in, and an unknown top-level group", () => {
    const text = FILE.replace("  branch_prefix:", "  branch_prefx:").replace("polling:", "poling:");
    const problems = checkWorkflowText(text);
    expect(problems.map((p) => p.line)).toEqual([
      lineOf(text, "branch_prefx"),
      lineOf(text, "poling"),
    ]);
    expect(problems[0].message).toContain("Did you mean branch_prefix?");
    expect(problems[1].message).toContain("Did you mean polling?");
  });

  it("points at a tab instead of a YAML error", () => {
    const text = FILE.replace("  max_turns: 20", "\tmax_turns: 20");
    expect(checkWorkflowText(text)).toEqual([
      {
        line: lineOf(text, "max_turns"),
        message: "This line is indented with a tab. The settings block needs spaces.",
      },
    ]);
  });

  it("says when the settings can't be read, and roughly where", () => {
    const text = FILE.replace(
      '  active_states: ["Todo", "In Progress"]',
      '  active_states: ["Todo", "In Progress"',
    );
    const [p] = checkWorkflowText(text);
    expect(p.message).toMatch(/^The settings can't be read here: /);
    expect(p.line).toBeGreaterThanOrEqual(lineOf(text, "active_states"));
  });

  it("says when a value is the wrong kind, or a needed setting is missing", () => {
    const text = FILE.replace("  max_concurrent_agents: 4", '  max_concurrent_agents: "four"');
    expect(checkWorkflowText(text)[0]).toEqual({
      line: lineOf(text, "max_concurrent_agents"),
      message: "agent.max_concurrent_agents should be a number, not text.",
    });
    expect(checkWorkflowText(FILE.replace('  project_slug: "46658058"\n', ""))[0].message).toBe(
      "tracker.project_slug is missing. The engine needs it.",
    );
  });

  it("refuses a branch prefix git can't use", () => {
    const text = FILE.replace('branch_prefix: "omar/"', 'branch_prefix: "omar bc/"');
    expect(checkWorkflowText(text)[0].message).toMatch(/branch prefix may only hold/);
  });

  it("needs the settings block and some instructions", () => {
    expect(checkWorkflowText("hello")[0].message).toMatch(/must start with its settings/);
    expect(checkWorkflowText("---\ntracker:\n  kind: linear\n")[0].message).toMatch(
      /no closing ---/,
    );
    expect(
      checkWorkflowText(`${FILE.slice(0, FILE.indexOf("---\n", 4) + 4)}\n`).at(-1)?.message,
    ).toBe("The instructions after the settings are empty.");
  });

  it("catches {{ … }} a card can't fill, on its line", () => {
    const text = `${FILE}\nThe card's owner: {{ issue.owner }}\n`;
    expect(checkWorkflow(text)).toEqual([
      {
        line: lineOf(text, "issue.owner"),
        message: expect.stringMatching(
          /^The instructions use \{\{ … \}\} in a way a card can't fill/,
        ),
      },
    ]);
  });
});

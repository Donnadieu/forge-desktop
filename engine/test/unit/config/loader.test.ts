import { describe, expect, it } from "vitest";
import { parseWorkflowContent } from "../../../src/config/loader.js";

describe("parseWorkflowContent", () => {
  it("parses YAML frontmatter and markdown body", () => {
    const content = `---
tracker:
  kind: linear
  project_slug: forge-dev
  active_states: [Todo, "In Progress"]
agent:
  kind: claude
  max_turns: 10
---

You are an expert engineer working on **{{ issue.identifier }}**

## Task
{{ issue.description }}
`;
    const result = parseWorkflowContent(content);
    expect(result.config.tracker).toEqual({
      kind: "linear",
      project_slug: "forge-dev",
      active_states: ["Todo", "In Progress"],
    });
    expect(result.config.agent).toEqual({ kind: "claude", max_turns: 10 });
    expect(result.promptTemplate).toContain("{{ issue.identifier }}");
    expect(result.promptTemplate).toContain("{{ issue.description }}");
  });

  it("handles content without frontmatter", () => {
    const content = "Just a prompt template with no config";
    const result = parseWorkflowContent(content);
    expect(result.config).toEqual({});
    expect(result.promptTemplate).toBe("Just a prompt template with no config");
  });

  it("handles empty content", () => {
    const content = "";
    const result = parseWorkflowContent(content);
    expect(result.config).toEqual({});
    expect(result.promptTemplate).toBe("");
  });
});

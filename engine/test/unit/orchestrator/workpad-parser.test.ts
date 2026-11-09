import { describe, expect, it } from "vitest";
import { findWorkpadComment, parseWorkpad } from "../../../src/orchestrator/workpad-parser.js";

const SAMPLE_WORKPAD = `## Forge Workpad

\`\`\`text
devbox-01:/home/dev/forge-workspaces/MT-32@7bdde33bc
\`\`\`

### Plan

- [x] 1. Set up project structure
  - [x] 1.1 Initialize Next.js
  - [x] 1.2 Add Prisma
- [ ] 2. Implement auth
  - [x] 2.1 Add login page
  - [ ] 2.2 Add session middleware

### Acceptance Criteria

- [x] User can log in
- [ ] Session persists across refresh
- [ ] Error messages shown on invalid credentials

### Validation

- [x] targeted tests: \`npm test\`
- [ ] manual check: login flow works end-to-end
- [ ] manual check: session cookie is set

### Notes

- 2026-04-15: Started implementation
- 2026-04-15: Login page complete, moving to middleware

### Confusions

- Unclear which auth provider to use — docs reference both NextAuth and custom JWT
- Session storage strategy not specified in ticket
`;

describe("findWorkpadComment", () => {
  it("returns the comment body containing workpad header", () => {
    const comments = [
      { body: "Some other comment" },
      { body: SAMPLE_WORKPAD },
      { body: "Another comment" },
    ];
    expect(findWorkpadComment(comments)).toBe(SAMPLE_WORKPAD);
  });

  it("returns null when no workpad comment exists", () => {
    const comments = [{ body: "Just a regular comment" }, { body: "No workpad here" }];
    expect(findWorkpadComment(comments)).toBeNull();
  });

  it("returns null for empty comment list", () => {
    expect(findWorkpadComment([])).toBeNull();
  });
});

describe("parseWorkpad", () => {
  it("returns null for content without workpad header", () => {
    expect(parseWorkpad("Just some text")).toBeNull();
  });

  it("parses plan items with completion status", () => {
    const result = parseWorkpad(SAMPLE_WORKPAD);
    expect(result).not.toBeNull();
    expect(result!.planItems).toEqual([
      { text: "1. Set up project structure", completed: true },
      { text: "1.1 Initialize Next.js", completed: true },
      { text: "1.2 Add Prisma", completed: true },
      { text: "2. Implement auth", completed: false },
      { text: "2.1 Add login page", completed: true },
      { text: "2.2 Add session middleware", completed: false },
    ]);
  });

  it("parses acceptance criteria", () => {
    const result = parseWorkpad(SAMPLE_WORKPAD)!;
    expect(result.acceptanceCriteria).toEqual([
      { text: "User can log in", completed: true },
      { text: "Session persists across refresh", completed: false },
      { text: "Error messages shown on invalid credentials", completed: false },
    ]);
  });

  it("parses validation steps", () => {
    const result = parseWorkpad(SAMPLE_WORKPAD)!;
    expect(result.validationSteps).toEqual([
      { text: "targeted tests: `npm test`", completed: true },
      { text: "manual check: login flow works end-to-end", completed: false },
      { text: "manual check: session cookie is set", completed: false },
    ]);
  });

  it("parses confusions", () => {
    const result = parseWorkpad(SAMPLE_WORKPAD)!;
    expect(result.confusions).toEqual([
      "Unclear which auth provider to use — docs reference both NextAuth and custom JWT",
      "Session storage strategy not specified in ticket",
    ]);
  });

  it("parses notes", () => {
    const result = parseWorkpad(SAMPLE_WORKPAD)!;
    expect(result.notes).toEqual([
      "2026-04-15: Started implementation",
      "2026-04-15: Login page complete, moving to middleware",
    ]);
  });

  it("handles workpad with missing sections", () => {
    const minimal = `## Forge Workpad

### Plan

- [x] Done task

### Acceptance Criteria

- [x] Works
`;
    const result = parseWorkpad(minimal)!;
    expect(result.planItems).toHaveLength(1);
    expect(result.acceptanceCriteria).toHaveLength(1);
    expect(result.validationSteps).toHaveLength(0);
    expect(result.confusions).toHaveLength(0);
    expect(result.notes).toHaveLength(0);
  });

  it("handles uppercase X in checkboxes", () => {
    const body = `## Forge Workpad

### Plan

- [X] Task with uppercase X
- [ ] Incomplete task
`;
    const result = parseWorkpad(body)!;
    expect(result.planItems[0]).toEqual({ text: "Task with uppercase X", completed: true });
    expect(result.planItems[1]).toEqual({ text: "Incomplete task", completed: false });
  });
});

describe("the workpad heading", () => {
  it("finds the new `## Workpad` and the older `## Forge Workpad` (cards in flight keep working)", () => {
    const fresh = SAMPLE_WORKPAD.replace("## Forge Workpad", "## Workpad");
    expect(findWorkpadComment([{ body: "hi" }, { body: fresh }])).toBe(fresh);
    expect(findWorkpadComment([{ body: SAMPLE_WORKPAD }])).toBe(SAMPLE_WORKPAD);
    expect(parseWorkpad(fresh)?.planItems).toEqual(parseWorkpad(SAMPLE_WORKPAD)?.planItems);
    expect(findWorkpadComment([{ body: "We should add a ## Workpad later" }])).toBeNull();
  });
});

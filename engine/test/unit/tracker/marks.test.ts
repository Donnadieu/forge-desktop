import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { callBasecamp } from "../../../src/mcp/basecamp-api-server.js";
import { buildMcpServers } from "../../../src/mcp/config.js";
import { callGitHub } from "../../../src/mcp/github-graphql-server.js";
import { executeGraphQL } from "../../../src/mcp/linear-graphql-server.js";
import { findMarks, marksNote, resolveMarks } from "../../../src/tracker/marks.js";
import { HelperWatch } from "../../../src/worker/helper-wait.js";

const ENGINE = join(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(join(ENGINE, p), "utf-8");

describe("what others see: the marks", () => {
  it("finds the app's name and AI signatures, and lets ordinary words through", () => {
    expect(findMarks("## Forge Workpad")).toHaveLength(1);
    expect(
      findMarks("omars-mbp:/Users/o/Library/Application Support/Forge/workspaces/BC-1@abc"),
    ).toHaveLength(1);
    expect(findMarks("label forge")).toHaveLength(1);
    expect(
      findMarks("🤖 Generated with [Claude Code](https://claude.com/claude-code)"),
    ).toHaveLength(2);
    expect(findMarks("Co-Authored-By: Claude <claude@example.com>")).toHaveLength(1);
    expect(findMarks("reject forged actor ids; forgery is caught; forget it")).toEqual([]);
    expect(findMarks("Co-authored-by: Omar Donnadieu <o@example.com>")).toEqual([]);
    expect(findMarks("## Workpad\n\n```text\nBC-10471774790@ed25199\n```")).toEqual([]);
  });

  it("keeps the forge label by default and drops it when the workspace is invisible", () => {
    expect(resolveMarks({})).toEqual({ invisible: false, prLabel: "forge", branchPrefix: "" });
    expect(resolveMarks({ invisible: true })).toEqual({
      invisible: true,
      prLabel: "",
      branchPrefix: "",
    });
    expect(
      resolveMarks({ invisible: true, pr_label: "omar", branch_prefix: "omar/" }).prLabel,
    ).toBe("omar");
    expect(marksNote(resolveMarks({}))).toContain("Pull request label: `forge`");
  });

  it("the invisible note tells agents the rules without naming the app itself", () => {
    const note = marksNote(resolveMarks({ invisible: true }));
    expect(findMarks(note)).toEqual([]);
    expect(note).toContain("Pull request label: none");
    expect(note).toContain("## Workpad");
  });

  it("the lead's instructions never ask for the forge label or a folder path in the workpad", () => {
    const lead = read("workflow/lead.md");
    expect(lead).not.toMatch(/label `forge`|`forge` label/);
    expect(lead).not.toMatch(/<host(name)?>:/);
    const template = lead.slice(lead.indexOf("## Workpad template"));
    expect(findMarks(template)).toEqual([]);
  });

  it("the card note headings the agents are told to write carry no mark", () => {
    for (const file of [
      "skills/triage/SKILL.md",
      "skills/simplify/SKILL.md",
      "skills/linear/SKILL.md",
    ]) {
      const text = read(file);
      expect(text).not.toContain("## Forge ");
    }
    expect(read("workflow/basecamp.md")).toContain("<h1>Workpad</h1>");
    expect(read("workflow/github.md")).toContain("starts with `## Workpad`");
  });

  it("the engine's own card comment names no product", () => {
    const watch = new HelperWatch();
    expect(findMarks(watch.limitMessage(60 * 60_000))).toEqual([]);
  });
});

describe("what others see: tracker writes are refused when invisible", () => {
  const ok = vi.fn(async () => new Response("{}", { status: 201 }));

  it("Basecamp: a comment with a mark never leaves; reads and clean writes do", async () => {
    const opts = { endpoint: "https://x", accountId: "1", token: async () => "t", invisible: true };
    const fetchImpl = ok as unknown as typeof fetch;
    const bad = await callBasecamp(
      {
        method: "POST",
        path: "/buckets/1/recordings/2/comments.json",
        body: { content: "<h1>Forge Workpad</h1>" },
      },
      opts,
      fetchImpl,
    );
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/^Refused: this card write would show the word Forge/);
    expect(ok).not.toHaveBeenCalled();
    const good = await callBasecamp(
      {
        method: "POST",
        path: "/buckets/1/recordings/2/comments.json",
        body: { content: "<h1>Workpad</h1>" },
      },
      opts,
      fetchImpl,
    );
    expect(good.success).toBe(true);
    const visible = await callBasecamp(
      {
        method: "POST",
        path: "/buckets/1/recordings/2/comments.json",
        body: { content: "<h1>Forge Workpad</h1>" },
      },
      { ...opts, invisible: false },
      fetchImpl,
    );
    expect(visible.success).toBe(true);
  });

  it("GitHub: a mutation with a mark is refused, a query is not", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: {} }), { status: 200 }),
    );
    const opts = { endpoint: "https://x", token: async () => "t", invisible: true };
    const bad = await callGitHub(
      {
        query:
          'mutation($b: String!) { addComment(input: {subjectId: "I_1", body: $b}) { clientMutationId } }',
        variables: { b: "## Forge Workpad" },
      },
      opts,
      fetchImpl as unknown as typeof fetch,
    );
    expect(bad.success).toBe(false);
    const read = await callGitHub(
      { query: "query { viewer { login } } # forge" },
      opts,
      fetchImpl as unknown as typeof fetch,
    );
    expect(read.success).toBe(true);
  });

  it("Linear: a mutation with a mark is refused before any request", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await executeGraphQL(
      'mutation($b: String!) { commentCreate(input: {issueId: "1", body: $b}) { success } }',
      { b: "🤖 Generated with Claude Code" },
      "key",
      "https://x",
      true,
    );
    expect(r.success).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("each tracker tool is told the workspace is invisible", () => {
    for (const kind of ["linear", "basecamp", "github"]) {
      const servers = buildMcpServers(kind, { accountId: "1" }, { invisible: true }) as Record<
        string,
        { env: Record<string, string> }
      >;
      for (const s of Object.values(servers)) expect(s.env.MARKS_INVISIBLE).toBe("1");
      const plain = buildMcpServers(kind, { accountId: "1" }) as Record<
        string,
        { env: Record<string, string> }
      >;
      for (const s of Object.values(plain)) expect(s.env.MARKS_INVISIBLE).toBeUndefined();
    }
  });
});

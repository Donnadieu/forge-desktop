import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeStatus, parsePullRequest } from "../../../src/sessions/github.js";

// Real answers from GitHub to PR_QUERY, recorded Nov 12 2026 from open, merged and closed pull requests on
// rails/rails, vercel/next.js, facebook/react, microsoft/vscode and Donnadieu/forge-desktop.
const dir = join(__dirname, "../../fixtures/github/pr-states");
const pr = (name: string) => {
  const p = parsePullRequest(JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")));
  if (!p) throw new Error(`${name} didn't parse`);
  return p;
};

describe("a pull request from GitHub", () => {
  it("reads what merging it depends on", () => {
    const p = pr("conflicts");
    expect(p.mergeable).toBe("CONFLICTING");
    expect(p.mergeStateStatus).toBe("DIRTY");
    expect(p.unresolved).toBe(14);
    expect(Object.values(p.threadsByPath).reduce((a, b) => a + b, 0)).toBe(14);
    expect(p.checks.find((c) => c.state === "FAILURE")?.required).toBe(true);
    expect(p.id).not.toBe("");
    expect(p.headOid).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reads a check still running as running, not as its missing conclusion", () => {
    expect(pr("checks-running").checks.some((c) => c.state === "IN_PROGRESS")).toBe(true);
  });

  it("is null when GitHub has no such pull request", () => {
    expect(parsePullRequest({ data: { repository: { pullRequest: null } } })).toBeNull();
    expect(parsePullRequest({})).toBeNull();
  });
});

describe("the one merge status", () => {
  const cases: [string, string, string | null, string][] = [
    ["clean", "ready", "merge", "Ready to merge"],
    ["merged", "merged", null, "Merged"],
    ["closed", "closed", null, "Closed"],
    ["unknown", "checking", null, "Checking with GitHub…"],
    ["draft", "waiting", "ready_for_review", "Draft"],
    ["draft-unstable", "waiting", "ready_for_review", "Draft"],
    ["conflicts", "blocked", "resolve", "Conflicts with main"],
    ["checks-failing", "failing", "view_checks", "Checks failing (9 of 100)"],
    ["changes-requested", "blocked", "pull_comments", "Changes requested"],
    ["clean-with-comments", "blocked", "pull_comments", "1 review comment"],
    ["behind", "blocked", "update", "Branch is behind main"],
    ["checks-running", "waiting", null, "Checks running (40 of 52)"],
    ["review-required", "waiting", null, "Waiting for review"],
  ];
  for (const [name, tone, action, label] of cases) {
    it(`${name}: ${label}`, () => {
      const s = mergeStatus(pr(name));
      expect([s.tone, s.action, s.label]).toEqual([tone, action, label]);
    });
  }

  it("names who asked for changes when GitHub says", () => {
    const p = { ...pr("changes-requested"), changesRequestedBy: ["erika-k"] };
    expect(mergeStatus(p).label).toBe("Changes requested by @erika-k");
  });

  it("only required checks block when the repo marks some required", () => {
    const p = pr("clean");
    const optional = {
      ...p,
      checks: [...p.checks, { name: "lint", state: "FAILURE", url: "", required: false }],
    };
    expect(mergeStatus(optional).action).toBe("merge");
    const required = {
      ...p,
      checks: [...p.checks, { name: "lint", state: "FAILURE", url: "", required: true }],
    };
    expect(mergeStatus(required).action).toBe("view_checks");
  });

  it("a repo with no required checks counts every failing one", () => {
    const p = pr("review-required");
    const failing = {
      ...p,
      checks: [{ name: "test", state: "FAILURE", url: "", required: false }],
    };
    expect(mergeStatus(failing).action).toBe("view_checks");
  });

  it("says the base's own name", () => {
    expect(mergeStatus({ ...pr("behind"), base: "develop" }).label).toBe(
      "Branch is behind develop",
    );
  });

  it("a rule GitHub doesn't explain sends the person to GitHub", () => {
    const p = { ...pr("clean"), mergeStateStatus: "BLOCKED", reviewDecision: "APPROVED" };
    expect([mergeStatus(p).label, mergeStatus(p).action]).toEqual([
      "Blocked by a repo rule",
      "open",
    ]);
  });
});

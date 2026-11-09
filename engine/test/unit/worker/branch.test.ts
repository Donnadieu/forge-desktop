import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMarks } from "../../../src/tracker/marks.js";
import { gitHasBranch, issueBranch } from "../../../src/worker/branch.js";

const none = () => false;

describe("the card's branch", () => {
  it("is the prefix plus the card's id when Workflow Studio sets a prefix", () => {
    const b = issueBranch(
      { identifier: "BC-10471774790", branchName: "basecamp/bc-10471774790" },
      "omar/",
      none,
    );
    expect(b).toBe("omar/bc-10471774790");
    expect(findMarks(b)).toEqual([]);
    expect(issueBranch({ identifier: "app#12", branchName: "github/app-12" }, "omar/", none)).toBe(
      "omar/app-12",
    );
  });

  it("is the tracker's own name without a prefix, and never forge/ for a new card", () => {
    expect(issueBranch({ identifier: "BC-1", branchName: "basecamp/bc-1" }, "", none)).toBe(
      "basecamp/bc-1",
    );
    expect(issueBranch({ identifier: "FRG-7" }, "", none)).toBe("frg-7");
  });

  it("keeps the branch a card in flight already has, so its pull request isn't stranded", () => {
    const has = (n: string) => n === "basecamp/bc-1";
    expect(issueBranch({ identifier: "BC-1", branchName: "basecamp/bc-1" }, "omar/", has)).toBe(
      "basecamp/bc-1",
    );
    const old = (n: string) => n === "forge/FRG-7";
    expect(issueBranch({ identifier: "FRG-7" }, "", old)).toBe("forge/FRG-7");
    const both = (n: string) => n === "omar/bc-1" || n === "basecamp/bc-1";
    expect(issueBranch({ identifier: "BC-1", branchName: "basecamp/bc-1" }, "omar/", both)).toBe(
      "omar/bc-1",
    );
  });
});

describe("gitHasBranch", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("sees local branches", () => {
    dir = mkdtempSync(join(tmpdir(), "branch-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git(
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "--no-gpg-sign",
      "-m",
      "x",
    );
    git("branch", "basecamp/bc-1");
    const has = gitHasBranch(dir);
    expect(has("basecamp/bc-1")).toBe(true);
    expect(has("omar/bc-1")).toBe(false);
  });
});

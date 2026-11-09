import { execFileSync } from "node:child_process";
import type { NormalizedIssue } from "../tracker/types.js";

/**
 * The card's branch. With a prefix set in Workflow Studio it is the prefix plus the card's id
 * (`omar/` → `omar/bc-10471774790`); without one, the tracker's own name (Linear's, `basecamp/bc-…`,
 * `github/<repo>-<n>`), else the plain id. A card already in flight keeps the branch it was started on,
 * so turning on a prefix never strands an open pull request. New in Forge Desktop.
 */
export function issueBranch(
  issue: Pick<NormalizedIssue, "identifier" | "branchName">,
  prefix: string,
  hasBranch: (name: string) => boolean,
): string {
  const id = issue.identifier
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const wanted = prefix ? `${prefix}${id}` : (issue.branchName ?? id);
  if (hasBranch(wanted)) return wanted;
  // Names earlier versions gave this card: the tracker's own, and the old fallback.
  const earlier = [issue.branchName, `forge/${issue.identifier}`].filter(
    (b): b is string => !!b && b !== wanted,
  );
  return earlier.find(hasBranch) ?? wanted;
}

/** True when the card's checkout has `name` as a local branch or on origin. */
export function gitHasBranch(workspacePath: string): (name: string) => boolean {
  return (name) =>
    [`refs/heads/${name}`, `refs/remotes/origin/${name}`].some((ref) => {
      try {
        execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], {
          cwd: workspacePath,
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    });
}

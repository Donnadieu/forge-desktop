/**
 * Heuristic mapping from a free-text error message to the `issue_type` enum
 * used by `build_failures.issue_type_check` and mirrored in
 * `build_tickets.issue_type`. The CHECK constraint (migration 0015) only
 * accepts the values produced here, so both writers must use the same rules.
 */

export type InferredIssueType =
  | "docker_failure"
  | "test_failure"
  | "lint_failure"
  | "dependency_failure"
  | "runtime_failure";

export function inferIssueType(errorMessage: string | null | undefined): InferredIssueType | null {
  if (!errorMessage) return null;
  if (/docker|container|image/i.test(errorMessage)) return "docker_failure";
  if (/test|assert|expect/i.test(errorMessage)) return "test_failure";
  if (/lint|eslint|biome/i.test(errorMessage)) return "lint_failure";
  if (/dependency|module not found|cannot find/i.test(errorMessage)) return "dependency_failure";
  return "runtime_failure";
}

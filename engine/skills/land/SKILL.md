---
name: land
description: Land a PR by monitoring conflicts, resolving them, waiting for checks, and squash-merging when green.
---

# Land

## Goals

- Ensure the PR is conflict-free with main.
- Keep CI green and fix failures when they occur.
- Squash-merge the PR once checks pass.
- Do not yield until the PR is merged; keep the watcher loop running unless blocked.

## Preconditions

- `gh` CLI is authenticated.
- You are on the PR branch with a clean working tree.

## Steps

1. Locate the PR for the current branch.
2. Confirm tests pass locally before any push.
3. If the working tree has uncommitted changes, commit with the `commit` skill
   and push with the `push` skill before proceeding.
4. Check mergeability and conflicts against main.
5. If conflicts exist, use the `pull` skill to fetch/merge `origin/main` and
   resolve conflicts, then use the `push` skill to publish the updated branch.
6. Ensure review comments (if present) are acknowledged and any required
   fixes are handled before merging.
7. Watch checks until complete.
8. If checks fail, pull logs, fix the issue, commit with the `commit` skill,
   push with the `push` skill, and re-run checks.
9. When all checks are green and review feedback is addressed, squash-merge
   using the PR title/body for the merge subject/body.
10. **Context guard:** Before implementing review feedback, confirm it does not
    conflict with the task context. If it conflicts, respond inline with a
    justification.
11. **Pushback template:** When disagreeing with review feedback, reply inline
    with: acknowledge + rationale + offer alternative.
12. **Ambiguity gate:** When ambiguity blocks progress, use the clarification
    flow (assign PR to current GH user, mention them, wait for response). Do not
    implement until ambiguity is resolved.
    - If you are confident you know better than the reviewer, you may proceed
      without asking the user, but reply inline with your rationale.
13. **Per-comment mode:** For each review comment, choose one of: accept,
    clarify, or push back. Reply inline (or in the issue thread for review
    comments) stating the mode before changing code.
14. **Reply before change:** Always respond with intended action before pushing
    code changes (inline for review comments, issue thread for review comments).

## Commands

```bash
# Ensure branch and PR context
branch=$(git branch --show-current)
pr_number=$(gh pr view --json number -q .number)
pr_title=$(gh pr view --json title -q .title)
pr_body=$(gh pr view --json body -q .body)

# Check mergeability and conflicts
mergeable=$(gh pr view --json mergeable -q .mergeable)

if [ "$mergeable" = "CONFLICTING" ]; then
  # Run the pull skill to handle fetch + merge + conflict resolution.
  # Then run the push skill to publish the updated branch.
  :
fi

# Watch checks until they complete
if ! gh pr checks --watch; then
  gh pr checks
  # Identify failing run and inspect logs:
  # gh run list --branch "$branch"
  # gh run view <run-id> --log
  exit 1
fi

# Squash-merge
gh pr merge --squash --subject "$pr_title" --body "$pr_body"
```

## Failure Handling

- If checks fail, pull details with `gh pr checks` and `gh run view --log`,
  then fix locally, commit, push, and re-run the watch.
- Use judgment to identify flaky failures. If a failure is a flake (e.g., a
  timeout on only one platform), you may proceed without fixing it.
- If mergeability is `UNKNOWN`, wait and re-check.
- Do not merge while review comments are outstanding.
- Do not enable auto-merge; use explicit merge after checks pass.

## Review Handling

- Human review comments are blocking and must be addressed before merging.
- If multiple reviewers comment in the same thread, respond to each comment
  before closing the thread.
- Fetch review comments via `gh api` and reply with a response.
- Use review comment endpoints to find inline feedback:
  ```bash
  # List PR review comments
  gh api repos/{owner}/{repo}/pulls/<pr_number>/comments

  # PR issue comments (top-level discussion)
  gh api repos/{owner}/{repo}/issues/<pr_number>/comments
  ```

## Scope + PR Metadata

- The PR title and description should reflect the full scope of the change,
  not just the most recent fix.
- If review feedback expands scope, decide whether to include it now or defer.
- Correctness issues raised in reviews should be addressed with validation
  (test, log, or reasoning) before closing.
- Prefer a single consolidated "review addressed" comment after a batch of
  fixes instead of many small updates.

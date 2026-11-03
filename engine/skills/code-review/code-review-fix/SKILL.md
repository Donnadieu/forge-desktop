---
name: code-review-fix
description: Address the findings from a code-review on your own branch — auto-fix every CRITICAL and HIGH finding, then triage each MEDIUM and LOW individually and fix only the ones that warrant it. Leaves changes uncommitted.
allowed-tools: Task, Read, Write, Bash, Glob, Edit, LS, Grep
---

# Code Review Fix Command

Address the findings from a `/code-review` on **your own** branch: auto-fix
everything CRITICAL and HIGH, then triage each MEDIUM and LOW individually and
fix only the ones that warrant it.

## Usage

```
/code-review-fix
```

This command will:

1. Find the latest review for the current branch
2. Fix every CRITICAL and HIGH finding
3. Triage each MEDIUM and LOW one by one, fixing only those worth addressing
4. Format changed files and leave everything uncommitted for your review

## Instructions

### 0. Locate the latest review

```bash
#!/bin/bash
set -e

current_branch=$(git branch --show-current)
[ -z "$current_branch" ] && { echo "❌ Not on a branch. Checkout a feature branch."; exit 1; }

safe_branch_name=$(echo "$current_branch" | tr '/' '-')

# /code-review increments filenames (-review.md, -review-1.md, ...). Pick the newest.
review_file=$(ls -t tmp/code-reviews/${safe_branch_name}-review*.md 2>/dev/null | head -1)
if [ -z "$review_file" ]; then
  echo "❌ No code review found for $current_branch. Run /code-review first."
  exit 1
fi

echo "✅ Using review: $review_file"
```

### 1. Read and bucket the findings

Read the review file. Group findings into:

- **Must-fix**: everything under CRITICAL and HIGH.
- **Triage**: everything under MEDIUM and LOW (including the "Suggestions"
  section).

If there are zero findings in any bucket, say so and skip that step. If the
whole review is clean, report that and stop.

### 2. Fix all CRITICAL and HIGH findings

Address every must-fix finding directly. No per-item confirmation. For each one:

1. Read the affected file(s) fully to understand the real state, not just the
   review's summary.
2. Apply the smallest correct fix, following project conventions in `CLAUDE.md`
   and any `.claude/skills/*` that apply.
3. Add or update tests when the finding is about coverage or a bug a test would
   have caught.

If a must-fix finding turns out to be a false positive on closer inspection, do
**not** force a change. Note it and move on (see step 4 reporting).

### 3. Triage each MEDIUM and LOW finding individually

Go through these **one at a time**. For each, decide whether it's worth
addressing in this PR. Address it when:

- It's a real correctness, clarity, or maintainability win, **and**
- The fix is proportionate (not a refactor that balloons the diff or invites
  scope creep).

Skip it when it's a judgment call the author already made deliberately,
speculative ("might want to…"), or out of scope for this change. Use guard
clauses, self-documenting variables, and the other preferences in `CLAUDE.md`
when you do make a change.

Apply the fixes you decided to keep. Record a one-line verdict for each finding
either way.

### 4. Format and report

Run the project's formatter on the files you touched (for this repo:
`pnpm format <changed-files>` from the repo root, per `CLAUDE.md`). Then show:

```
✅ Code review fixes applied

Fixed (CRITICAL/HIGH): {n}
  - {file:line} — {what changed}

Triaged (MEDIUM/LOW): {n}
  Addressed:
    - {file:line} — {what changed}
  Skipped:
    - {finding} — {one-line reason}

Changed files:
{git status --short}
```

Leave everything uncommitted.

### 5. Suggested next steps

```
Next:
1. Review the diff: git diff
2. Run the relevant tests (RSpec for backend, Vitest for frontend)
3. Commit when satisfied, or revert with: git checkout .
4. Re-run /code-review to confirm the findings are resolved
```

## Notes

- **Your branch, not someone else's.** This command _changes code_. To review a
  teammate's PR and draft comments instead, use `/code-review-comment`.
- **Minimal, in-style changes.** Match the surrounding code; don't introduce new
  patterns or fix unrelated pre-existing issues.
- **Triage is the point.** The value here is not blindly applying every MEDIUM
  and LOW. Skipping a weak finding with a clear reason is a valid outcome.
- Requires an existing review (`/code-review` first) so changes are grounded in
  a real analysis, not guesses.

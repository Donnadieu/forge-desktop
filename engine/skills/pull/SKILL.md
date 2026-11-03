---
name: pull
description: Pull latest origin/main into the current branch and resolve merge conflicts.
---

# Pull

## Workflow

1. Verify git status is clean or commit/stash changes before merging.
2. Ensure rerere is enabled locally:
   - `git config rerere.enabled true`
   - `git config rerere.autoupdate true`
3. Confirm remotes and branches:
   - Ensure the `origin` remote exists.
   - Ensure the current branch is the one to receive the merge.
4. Fetch latest refs:
   - `git fetch origin`
5. Sync the remote feature branch first:
   - `git pull --ff-only origin $(git branch --show-current)`
   - This pulls branch updates made remotely before merging `origin/main`.
6. Merge in order:
   - Prefer `git -c merge.conflictstyle=zdiff3 merge origin/main` for clearer
     conflict context.
7. If conflicts appear, resolve them (see guidance below), then:
   - `git add <files>`
   - `git commit` (or `git merge --continue` if the merge is paused)
8. Verify with project checks (tests, lint, build).
9. Summarize the merge:
   - Call out the most challenging conflicts and how they were resolved.
   - Note any assumptions or follow-ups.

## Conflict Resolution Guidance

- **Inspect context before editing:**
  - Use `git status` to list conflicted files.
  - Use `git diff` or `git diff --merge` to see conflict hunks.
  - With `merge.conflictstyle=zdiff3`, conflict markers include:
    `<<<<<<<` ours, `|||||||` base, `=======` split, `>>>>>>>` theirs.
  - Summarize intent of both sides before choosing a resolution.

- **Prefer minimal, intention-preserving edits:**
  - Keep behavior consistent with the branch's purpose.
  - Avoid accidental deletions or silent behavior changes.

- **Resolve one file at a time** and rerun tests after each logical batch.

- **Use `ours/theirs` only** when certain one side should win entirely.

- **For generated files:** Resolve source conflicts first, then regenerate.

- **For import conflicts:** Accept both sides temporarily, then run lint/type
  checks to remove unused imports.

- **After resolving:** Ensure no conflict markers remain: `git diff --check`

## When To Ask The User

Ask only when:

- The correct resolution depends on product intent not inferable from code.
- The conflict crosses a user-visible API surface where choosing wrong could
  break consumers.
- Two mutually exclusive designs with equivalent merit and no clear signal.
- The merge introduces data loss or irreversible side effects.

Otherwise, proceed with the merge, explain the decision briefly, and leave
a clear, reviewable commit history.

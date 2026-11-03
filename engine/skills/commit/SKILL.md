---
name: commit
description: Commit current changes
---

## Behavior

Follow these steps in order:

### Step 1: Check Repository State

- [ ] Run `git status`, `git diff --cached`, `git diff`, and
      `git log --oneline -5` in parallel
- [ ] Review all changes and determine if this is a simple or complex change
- [ ] If there are no changes to commit, report "Nothing to commit" and exit

### Step 2: Draft Commit Message

- [ ] Write title (50 chars max, imperative mood)
- [ ] Write body following style guidelines below
- [ ] In interactive mode: Display with "**First pass:**" label
- [ ] In automated mode: Keep it concise (no "First pass"/"Second pass" iterations)

### Step 3: Simplify Message (Interactive Mode Only)

Skip this step if `COMMIT_AUTO_MODE=true`.

- [ ] Remove redundant/unnecessary details
- [ ] Check for repeated information across paragraphs
- [ ] Display simplified version with "**Second pass (simplified):**" label

### Step 4: Get Confirmation and Commit

**Automated mode** (`COMMIT_AUTO_MODE=true`):
- [ ] Stage all relevant files with `git add`
- [ ] Commit immediately using HEREDOC format (do NOT ask for confirmation)
- [ ] If the commit fails on signing, check `git config user.signingkey`. Unset
      means signing isn't set up here: retry with `--no-gpg-sign`. Set means a
      real blocker: do NOT retry unsigned; report it in the workpad/handoff

**Interactive mode** (default):
- [ ] Ask: "Proceed with this commit message?"
- [ ] If confirmed: stage files with `git add` and commit using HEREDOC format
- [ ] Run `git status` to verify success

### Step 5: Push (Automated Mode)

If `COMMIT_AUTO_MODE=true`:
- [ ] Push to origin: `git push -u origin <branch>`

## Commit Message Style

**Structure:**

- Title: 50 characters max, imperative mood (e.g., "Add", "Fix", "Refactor")
- Body: Lines wrapped at 72 characters, explain what and why (not how)

**Content Structure:**

**Complex changes:**

1. Describe the problem or current state that motivated the change
2. Explain what was changed to solve it
3. State the benefits achieved
4. Mention testing coverage briefly if significant (interactive mode only)

**Simple changes:** State what changed in one sentence, then briefly explain why
in one sentence. Prefer brevity over completeness when the change is
self-explanatory.

**Writing Guidelines:**

- Use complete sentences with explicit subjects ("This commit adds..." not
  "Add...")
- Write in active voice with clear actors performing actions
- Prefer concise, direct explanations over detailed descriptions
- Ask "Is this detail necessary for understanding the change?" before including
  it
- Use backticks for technical terms and code values
- Clear description of benefits when they aren't obvious from the change

**Avoid:**

- Implementation details visible in the diff
- Line/test/file count mentions ("reduced from 34 to 3 lines")
- Subjective terms without value ("modernize", "enhanced", "comprehensive",
  "systematic")
- Repeating the same information across multiple paragraphs
- Over-explaining benefits that are obvious from the change itself
- References to previous commits unless directly relevant

Keep it professional, factual, and focused on meaningful changes.

**Example:**

Good:

```
Limit file size for image uploads

Large image uploads were failing because of server timeouts. This
commit adds validation to reject files over 5MB and displays an
error message to users when uploads fail.
```

Bad:

```
Improve file upload functionality with enhanced validation

The existing file upload system had issues with large files causing
failures. This commit implements comprehensive validation that checks
file size limits, adds error handling for oversized files, creates
user-friendly error messages, and improves the overall upload
experience by providing better feedback to users.
```

## Key Requirements

- NEVER update git config
- NEVER use interactive git commands (-i flag)
- Use HEREDOC format for commit messages to ensure proper formatting:

```bash
git commit -m "$(cat <<'EOF'
Title here

Body here wrapped at 72 characters.
EOF
)"
```

- Only commit staged/modified files, never create empty commits
- If pre-commit hooks modify files, amend the commit to include them
- Do NOT push unless explicitly requested (or in automated mode)
- Never include any co-author trailers, AI attribution, or references to Claude
  Code in commit messages unless explicitly asked to do so
- Write commit messages as if they were written entirely by the human developer
- Only use `--no-gpg-sign` when no signing key is configured (`git config
  user.signingkey` is empty); a configured key that fails is a blocker to report

## Automated Mode

When `COMMIT_AUTO_MODE=true` is set (as Forge sets it for agents):

1. **No confirmation prompt** - commits automatically
2. **No co-author line** - no "Co-Authored-By: Claude" or similar
3. **Auto-push** - pushes to origin after committing
4. **Concise messages** - skips the two-pass refinement

Example in automated mode:

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add user validation endpoint

This commit adds a new `/api/validate` endpoint that checks user
credentials before allowing access to protected resources. The
endpoint returns a 401 status for invalid tokens.
EOF
)"
git push -u origin feature-name
```

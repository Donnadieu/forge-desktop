---
name: code-review-nuclear
description: A strict superset of code-review — runs the same 4 behavioral agents PLUS a 5th structural (Thermo-Nuclear) maintainability/drift agent over the current branch, then merges behavioral (B-) and structural (T-) findings into one deduped review at tmp/code-reviews/<branch>-nuclear-review.md. Use for the deepest review when you also want abstraction/duplication/drift caught, not just bugs.
allowed-tools: Task, TaskOutput, Read, Write, Bash, Glob, TodoWrite
---

# Code Review Nuclear Command

Perform a comprehensive code review across **two complementary lenses** using
parallel specialized agents:

- **Behavioral (4 agents)** — correctness, security, tests, and architecture
  (the same lanes as `/code-review`).
- **Structural (1 agent)** — a Thermo-Nuclear maintainability / abstraction /
  drift review, decomposed into the same severity buckets.

Findings from both lenses are merged into a single report. This is a strict
superset of `/code-review`; the plain `/code-review` command is unaffected.

## Usage

```
/code-review-nuclear
```

This command will:

1. Fetch latest changes from main branch
2. Rebase current branch onto main
3. Generate git diff against main (includes uncommitted and new files)
4. Save diff to `tmp/git-diffs/[branch-name]-diff.txt` (incrementing if exists)
5. Launch **5 parallel specialized agents** for deep analysis (4 behavioral + 1 structural)
6. Merge behavioral (`B-`) and structural (`T-`) findings into one unified review
7. Save review to `tmp/code-reviews/[branch-name]-nuclear-review.md` (incrementing
   if exists)

## Instructions

### 0. Automated Git Workflow

Execute the automated git workflow to prepare the diff:

```bash
#!/bin/bash
set -e

echo "🔍 Preparing nuclear code review..."

# Get current branch name
current_branch=$(git branch --show-current)
if [ -z "$current_branch" ]; then
  echo "❌ Not on a branch. Please checkout a feature branch."
  exit 1
fi

# Sanitize branch name for file system (replace slashes with dashes)
safe_branch_name=$(echo "$current_branch" | tr '/' '-')

echo "  Current branch: $current_branch"

# Always use main as the base branch
base_branch="main"

# Check if main exists
if ! git show-ref --verify --quiet refs/heads/$base_branch; then
  if git show-ref --verify --quiet refs/heads/master; then
    base_branch="master"
    echo "  Using master as base branch"
  else
    echo "❌ Neither main nor master branch found."
    exit 1
  fi
fi

echo "  Base branch: $base_branch"
echo ""

# Stash uncommitted changes if any (including untracked files)
stash_created=false
if ! git diff-index --quiet HEAD -- || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "📦 Stashing uncommitted changes (including new files)..."
  git stash push -u -m "code-review-temp-stash-$(date +%s)"
  stash_created=true
fi

# Fetch latest from remote
echo "✅ Fetching latest changes from origin/$base_branch..."
git fetch origin $base_branch

# Checkout and update main branch
echo "✅ Checking out $base_branch..."
git checkout $base_branch

echo "✅ Updating $base_branch with latest from origin..."
git pull origin $base_branch --ff-only || {
  echo "❌ Could not fast-forward $base_branch. Please resolve manually."
  exit 1
}

# Switch back to feature branch
echo "✅ Switching back to $current_branch..."
git checkout $current_branch

# Restore stashed changes if we created a stash
if [ "$stash_created" = true ]; then
  echo "📦 Restoring uncommitted changes..."
  git stash pop
fi

# Rebase current branch onto main
echo "✅ Rebasing $current_branch onto $base_branch..."
if ! git rebase $base_branch; then
  echo ""
  echo "❌ Rebase conflicts detected!"
  echo "Please resolve conflicts and then run /code-review-nuclear again."
  echo ""
  echo "To resolve:"
  echo "  1. Fix conflicts in the files listed above"
  echo "  2. git add <resolved-files>"
  echo "  3. git rebase --continue"
  echo "  4. Run /code-review-nuclear again"
  exit 1
fi

# Create directories (absolute paths so the final message links resolve;
# tmp/ is gitignored, so it never shows in the editor's changes panel)
repo_root=$(git rev-parse --show-toplevel)
mkdir -p "$repo_root/tmp/git-diffs"
mkdir -p "$repo_root/tmp/code-reviews"

# Find next available filename for diff
diff_counter=0
diff_file="$repo_root/tmp/git-diffs/${safe_branch_name}-diff.txt"
while [ -f "$diff_file" ]; do
  diff_counter=$((diff_counter + 1))
  diff_file="$repo_root/tmp/git-diffs/${safe_branch_name}-diff-${diff_counter}.txt"
done

# Find next available filename for review (note: -nuclear-review, never collides with /code-review)
review_counter=0
review_file="$repo_root/tmp/code-reviews/${safe_branch_name}-nuclear-review.md"
while [ -f "$review_file" ]; do
  review_counter=$((review_counter + 1))
  review_file="$repo_root/tmp/code-reviews/${safe_branch_name}-nuclear-review-${review_counter}.md"
done

# Generate diff against main (includes uncommitted and new files)
echo "✅ Generating diff against $base_branch..."
git diff $base_branch HEAD -- . ':(exclude).claude/**' > "$diff_file"

# If there are uncommitted changes, append them
if ! git diff-index --quiet HEAD -- || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "  Including uncommitted and new files..."
  git diff HEAD -- . ':(exclude).claude/**' >> "$diff_file"
  git ls-files --others --exclude-standard -- . ':(exclude).claude/**' | while read file; do
    echo "diff --git a/$file b/$file" >> "$diff_file"
    echo "new file" >> "$diff_file"
    echo "--- /dev/null" >> "$diff_file"
    echo "+++ b/$file" >> "$diff_file"
    cat "$file" | sed 's/^/+/' >> "$diff_file"
  done
fi

# Count changes
lines_changed=$(wc -l < "$diff_file" | tr -d ' ')
files_changed=$(git diff $base_branch HEAD --name-only -- . ':(exclude).claude/**' | wc -l | tr -d ' ')

echo ""
echo "📊 Diff generated:"
echo "   Files changed: $files_changed"
echo "   Lines in diff: $lines_changed"
echo "   Saved to: $diff_file"
echo "   Review will be saved to: $review_file"
echo ""

if [ "$lines_changed" -eq 0 ]; then
  echo "⚠️  No changes detected. Nothing to review."
  exit 0
fi

echo "SUCCESS:$diff_file:$review_file"
```

### 1. Discover Project Context

Before launching agents, gather project context:

1. Read `CLAUDE.md` for project-wide standards
2. Check for skill files in `.claude/skills/` that provide language-specific patterns
3. Detect project type from config files (package.json, pyproject.toml, Gemfile, go.mod, Cargo.toml, etc.)

### 2. Launch Parallel Specialized Agents

Launch **5 agents in parallel** using a single message with multiple Task tool
calls. All agents run in the background simultaneously.

**IMPORTANT**: You MUST launch all 5 agents (4 behavioral + 1 structural) in a
SINGLE message with multiple Task tool calls to ensure they run in parallel.

Agents 1–4 are the behavioral lenses (their findings will be prefixed `B-`).
Agent 5 is the structural lens (its findings will be prefixed `T-`).

#### Agent 1: Application Code Agent

```yaml
Task:
  description: "Review application source code"
  subagent_type: "general-purpose"
  run_in_background: true
  prompt: |
    You are a senior software engineer doing a deep-dive code review of application source code.

    ## Project Discovery
    First, understand the project:
    1. Read `CLAUDE.md` if it exists for project standards
    2. Check `.claude/skills/` for language-specific skill files (e.g., `backend/SKILL.md`, `frontend/SKILL.md`)
    3. Detect project type from config files:
       - `package.json` → Node.js/TypeScript
       - `pyproject.toml` or `requirements.txt` → Python
       - `Gemfile` → Ruby
       - `go.mod` → Go
       - `Cargo.toml` → Rust
       - `pom.xml` or `build.gradle` → Java/Kotlin
       - `composer.json` → PHP

    ## Your Focus
    Review application source code (controllers, services, handlers, etc.):
    - API endpoints and route handlers
    - Business logic and services
    - Data serialization/validation
    - Request/response handling

    Read the diff at `{diff_file}` to understand what changed.

    ## Utility Agents Available
    You can delegate to specialized agents using the Task tool when needed:

    - **file-analyzer** (`subagent_type: "file-analyzer"`): Use when encountering large files (>500 lines) or verbose output
    - **code-analyzer** (`subagent_type: "code-analyzer"`): Use for deep bug hunting, tracing logic flow, or investigating suspicious patterns
    - **test-runner** (`subagent_type: "test-runner"`): Use to run relevant tests and verify changes don't break functionality

    ## Review Criteria (Language-Agnostic)

    1. **Framework Patterns**
       - Proper use of framework idioms and conventions
       - Correct HTTP status codes and response formats
       - Proper request validation and sanitization
       - Follow patterns from skill files if available

    2. **Error Handling**
       - Are all failure modes covered?
       - Are errors logged with sufficient context?
       - Are user-facing error messages appropriate?
       - Are exceptions handled at the right level?

    3. **Security**
       - Input validation and sanitization
       - Authorization checks
       - Secure handling of credentials/tokens
       - Injection prevention (SQL, command, etc.)

    4. **Edge Cases & Bugs**
       - Null/nil/undefined safety
       - Boundary conditions
       - What happens if external services fail?

    5. **Code Quality**
       - Single responsibility
       - Method/function size and complexity
       - DRY violations
       - Consistent code style per project config

    ## Output Format
    Return a structured report with severity levels (CRITICAL/HIGH/MEDIUM/LOW) for each file and a summary of issue counts.
```

#### Agent 2: Infrastructure & Data Agent

```yaml
Task:
  description: "Review infrastructure and data layer"
  subagent_type: "general-purpose"
  run_in_background: true
  prompt: |
    You are a senior infrastructure engineer doing a deep-dive code review.

    ## Project Discovery
    First, understand the project:
    1. Read `CLAUDE.md` if it exists for project standards
    2. Check `.claude/skills/` for relevant skill files
    3. Detect infrastructure patterns from files present

    ## Your Focus
    Review infrastructure, data layer, and DevOps:
    - Database models/schemas/migrations
    - Background jobs/workers/queues
    - Configuration files
    - CI/CD pipelines (`.github/workflows/`, `.gitlab-ci.yml`, etc.)
    - Docker/container configuration
    - Infrastructure as code (Terraform, CloudFormation, etc.)
    - Environment configuration

    Read the diff at `{diff_file}` to understand what changed.

    ## Utility Agents Available
    You can delegate to specialized agents using the Task tool when needed:

    - **file-analyzer** (`subagent_type: "file-analyzer"`): Use when encountering large config files or verbose output
    - **code-analyzer** (`subagent_type: "code-analyzer"`): Use for deep analysis of job/worker logic, race conditions, or data flow
    - **test-runner** (`subagent_type: "test-runner"`): Use to run infrastructure/integration tests
    - **parallel-worker** (`subagent_type: "parallel-worker"`): Use when you need to analyze many files in parallel

    ## Review Criteria

    1. **Database/Data Layer**
       - Schema design and normalization
       - Index usage and query performance (N+1 patterns)
       - Migration safety and rollback capability
       - Data validation at the persistence layer

    2. **Background Jobs/Workers**
       - Error handling and retries
       - Idempotency
       - Queue configuration
       - Failure handling and dead letter queues

    3. **Configuration**
       - Secrets management (no hardcoded secrets)
       - Environment-specific configuration
       - Feature flags and toggles

    4. **CI/CD**
       - Pipeline security
       - Test coverage requirements
       - Deployment safety

    5. **Infrastructure**
       - Resource sizing and limits
       - Health checks and monitoring
       - Scaling configuration

    ## Output Format
    Return a structured report with severity levels for each area and a summary.
```

#### Agent 3: Tests & Quality Agent

```yaml
Task:
  description: "Review tests and code quality"
  subagent_type: "general-purpose"
  run_in_background: true
  prompt: |
    You are a senior QA engineer and code quality specialist doing a deep-dive review.

    ## Project Discovery
    First, understand the project:
    1. Read `CLAUDE.md` if it exists for testing standards
    2. Check `.claude/skills/` for testing-related skill files
    3. Detect test framework from config files:
       - Jest/Vitest/Mocha (JavaScript/TypeScript)
       - pytest/unittest (Python)
       - RSpec/Minitest (Ruby)
       - go test (Go)
       - cargo test (Rust)
       - JUnit/TestNG (Java)

    ## Your Focus
    Review test files and code quality tooling:
    - Unit tests
    - Integration tests
    - E2E tests
    - Test utilities and fixtures
    - Linting/formatting configuration
    - Type checking configuration

    Read the diff at `{diff_file}` to understand what changed.

    ## Utility Agents Available
    You can delegate to specialized agents using the Task tool when needed:

    - **file-analyzer** (`subagent_type: "file-analyzer"`): Use when encountering large test files or verbose test output
    - **code-analyzer** (`subagent_type: "code-analyzer"`): Use for analyzing test coverage gaps or tracing tested code paths
    - **test-runner** (`subagent_type: "test-runner"`): Use to actually run tests and verify they pass
    - **parallel-worker** (`subagent_type: "parallel-worker"`): Use when you need to analyze many test files in parallel

    ## Review Criteria

    1. **Test Coverage**
       - Are new code paths tested?
       - Are edge cases covered?
       - Are error paths tested?
       - Is the test-to-code ratio reasonable?

    2. **Test Quality**
       - Clear test names that describe behavior
       - Proper test isolation (no shared state)
       - Appropriate use of mocks/stubs
       - No flaky tests (race conditions, timing issues)

    3. **Test Organization**
       - Proper test file structure
       - Reusable fixtures and helpers
       - Test data management

    4. **Assertions**
       - Meaningful assertions (not just "no error")
       - Proper error message verification
       - Boundary condition testing

    5. **Code Quality Tooling**
       - Linting rules appropriate
       - Type coverage (if applicable)
       - Formatting consistency

    ## Output Format
    Return a structured report with severity levels for each area and a summary.
```

#### Agent 4: Architecture Agent

```yaml
Task:
  description: "Architecture review"
  subagent_type: "general-purpose"
  run_in_background: true
  prompt: |
    You are a principal software architect doing an architectural review.

    ## Project Discovery
    First, understand the project:
    1. Read `CLAUDE.md` for architectural context
    2. Check `.claude/skills/` for architecture-related documentation
    3. Identify the overall system architecture from the codebase structure

    Read the diff at `{diff_file}` to understand the full scope of changes.

    ## Utility Agents Available
    You can delegate to specialized agents using the Task tool when needed:

    - **file-analyzer** (`subagent_type: "file-analyzer"`): Use to summarize large files or complex modules before analyzing their architectural role
    - **code-analyzer** (`subagent_type: "code-analyzer"`): Use for deep analysis of specific concerns - race conditions, security vulnerabilities, data flow tracing across files
    - **parallel-worker** (`subagent_type: "parallel-worker"`): Use when you need to analyze multiple architectural layers simultaneously

    ## Your Focus
    Review the ARCHITECTURE and DESIGN, not line-by-line code:

    1. **Data Flow Analysis**
       - Trace complete flows from user action to data persistence and back
       - Are there gaps in the flow?
       - Is data transformed correctly at each boundary?

    2. **State Machine Correctness**
       - If there are status/state fields, are all transitions valid?
       - Can the system get stuck in invalid states?
       - Are state transitions atomic?

    3. **Concurrency & Race Conditions**
       - What if multiple operations happen simultaneously?
       - What if connections drop mid-operation?
       - Are shared resources properly synchronized?

    4. **Error Recovery**
       - How does the system recover from failures?
       - Are there orphaned states?
       - Is there proper cleanup on failure?

    5. **API Contract**
       - Are contracts between components clear and consistent?
       - Are breaking changes handled properly?
       - Is versioning appropriate?

    6. **Security Architecture**
       - Authentication flows
       - Authorization model
       - Token/session handling
       - Data protection

    7. **Scalability Concerns**
       - Will this work at scale?
       - Are there bottlenecks?
       - Is caching used appropriately?

    ## Output Format
    Return a structured report with:
    - Data flow diagram (text-based)
    - State machine analysis (if applicable)
    - List of race conditions with risk levels
    - Security assessment
    - Recommendations prioritized by importance
```

#### Agent 5: Structural / Thermo-Nuclear Agent

```yaml
Task:
  description: "Structural maintainability review (Thermo-Nuclear)"
  subagent_type: "general-purpose"
  run_in_background: true
  prompt: |
    You are a principal engineer doing a STRUCTURAL / maintainability review — the opposite lens from
    bug hunting. You care about abstraction quality, drift, spaghetti growth, duplication, and whether
    this change left the codebase cleaner or messier. This lane runs the project's Thermo-Nuclear review
    and returns it as severity-bucketed findings.

    ## Execute the two Thermo-Nuclear skills, in order
    These skills ship next to this skill (`disable-model-invocation: true`, so you must read the SKILL.md
    directly — do not rely on auto-invocation).

    1. Read and follow the Thermo-Nuclear review skill to perform the deep maintainability/structural
       review against the diff at `{diff_file}`. Resolve its path in this order and read the first that
       exists (the Read tool needs an absolute path — run `echo $HOME` or
       `ls "$HOME/.claude/skills/thermo-nuclear-code-quality-review/SKILL.md"` to resolve `~` if needed):
         a. `.forge/skills/code-review/thermo-nuclear-code-quality-review/SKILL.md`  (Forge workspace)
         b. `.agents/skills/code-review/thermo-nuclear-code-quality-review/SKILL.md` (Forge repo checkout)
         c. `$HOME/.claude/skills/thermo-nuclear-code-quality-review/SKILL.md`       (user-global install)
       Apply its full standard: be ambitious about structural simplification, actively hunt for
       "code-judo" moves (restructurings that delete whole categories of complexity), and flag
       file-size explosions, scattered special-case branches, duplicated logic, and boundary/type problems.
    2. Then read and follow the decompose skill, resolving its path the same way:
         a. `.forge/skills/code-review/thermo-nuclear-code-quality-review-decompose/SKILL.md`  (Forge workspace)
         b. `.agents/skills/code-review/thermo-nuclear-code-quality-review-decompose/SKILL.md` (Forge repo checkout)
         c. `$HOME/.claude/skills/thermo-nuclear-code-quality-review-decompose/SKILL.md`       (user-global install)
       Use it to DECOMPOSE that review into Critical/High/Medium/Low findings using its
       maintainability-calibrated severity rubric, preserving every finding losslessly.

    If NO location resolves, do not silently approximate the standard — say so explicitly at the top
    of your output (e.g. "⚠️ Thermo-Nuclear SKILL.md not found at either path; applied inline standard")
    so the orchestrator and user know the canonical skill did not run.

    ## Critical instruction — do NOT restrict yourself to changed files
    The most valuable structural findings often live in UNCHANGED consumer files. Example: a status enum
    written as `5` in the feature but mapped as `6` in an untouched audit-label map elsewhere — a shipped
    defect caused by missing a canonical source of truth. Trace each new value/concept into every file
    that reads it, changed or not. Read full source as needed (use the file-analyzer / code-analyzer
    utility agents for large files).

    ## Output Format (so the orchestrator can merge you)
    Return your findings already bucketed by severity, with each finding carrying:
    - a `T-` prefixed ID (T-C1, T-H1, T-M1, T-L1, …),
    - the `file:line`,
    - the structural diagnosis (why it's a problem),
    - the **Remedy / code-judo move** the review proposed (never collapse this to "refactor this").

    Also return, as their own sections:
    - **Canonical / Code-Judo Recommendation** — the single unifying restructuring (if any) and which
      T- findings it resolves.
    - **What's Good** — structural strengths worth keeping.
    - A **self-audit** line confirming finding-count parity (every source finding became exactly one row).
```

### 3. Wait for All Agents to Complete

Use TaskOutput to retrieve results from all **5** agents (Agents 1–4 behavioral,
Agent 5 structural). Wait for each to complete.

> **Unattended runs:** launch the agents with `run_in_background: false` (still all
> in one message, so they run in parallel). Background agents report back only on
> a later turn; if the session ends first, their findings are lost and no review
> file is written. Write the review file before starting any fixes.

### 4. Merge Findings into a Unified Review

Combine the two lanes into one report. **Do not run the lanes' findings through
each other** — keep the lenses distinct, then merge by severity.

**Prefixing & dedup (reuse the dedup-before-synthesis rule from the
`parallel-pr-review` skill — `.forge/skills/code-review/parallel-pr-review/SKILL.md`,
`.agents/skills/code-review/parallel-pr-review/SKILL.md`, or
`$HOME/.claude/skills/parallel-pr-review/SKILL.md`, first that exists):**

1. Prefix every behavioral finding (Agents 1–4) with `B-` and every structural
   finding (Agent 5) with `T-`. Keep lane identity visible on each finding.
2. Before writing the totals, **collapse overlaps**: when a behavioral and a
   structural finding describe the same issue at the same `file:line`/concept,
   keep ONE canonical entry (with the stronger evidence), tag it `[both lanes]`
   citing both IDs, and **count it once**. List these in the Cross-Reference
   section.
3. Preserve the structural lane's **Canonical / Code-Judo Recommendation** as its
   own top-level section — do not shred it across individual rows.

Use this template:

```markdown
# Code Review (Nuclear): [Feature Name]

## Comprehensive Review — Behavioral + Structural Lanes

Two complementary lenses over the same diff:

**Behavioral (`B-`)** — correctness, security, tests, design:
- Application Code Agent · Infrastructure & Data Agent · Tests & Quality Agent · Architecture Agent

**Structural (`T-`)** — maintainability, abstraction, drift (Thermo-Nuclear):
- Structural / Thermo-Nuclear Agent

Findings are prefixed `B-` / `T-`. Issues both lanes raised appear once, marked `[both lanes]`, counted once.

---

## Executive Summary

| Lane                 | Critical | High  | Medium | Low   |
| -------------------- | -------- | ----- | ------ | ----- |
| Behavioral (B)       | X        | X     | X      | X     |
| Structural (T)       | X        | X     | X      | X     |
| **Total (deduped)**  | **X**    | **X** | **X**  | **X** |

---

## Canonical / Code-Judo Recommendation

[From the structural lane: the single unifying restructuring, and which T-/B- findings it resolves.]

---

## CRITICAL (Must Fix Before Merge)

[All `B-` and `T-` CRITICAL findings, each tagged with its lane and file:line. `[both lanes]` where overlapping.]

---

## HIGH Priority Issues

[All HIGH findings, both lanes.]

---

## MEDIUM Priority Issues

[All MEDIUM findings, both lanes.]

---

## Suggestions (LOW Priority)

[All LOW findings, both lanes.]

---

## Cross-Reference (Overlaps)

Issues both lanes independently raised (counted once above):

- **[B-x / T-y]** <issue> — _behavioral angle:_ … _structural angle:_ …

---

## What's Good

[Merge positive findings from both lanes.]

---

## Architecture Diagram

[Include any diagrams from the Architecture agent.]

---

## Summary Checklists

### Must Fix Before Merge
- [ ] B-… / T-…

### Should Fix
- [ ] …

### Nice to Have
- [ ] …
```

### 5. Write Review Output

Write the merged review to the review file:

```yaml
Write:
  file_path: "{review_file}"
  content: "{merged_review}"
```

### 6. Inform User

```
✅ Nuclear code review complete (behavioral + structural)!

📄 Diff saved to: [{diff_file}]({diff_file})
📄 Review saved to: [{review_file}]({review_file})

## Results Summary

| Lane | Critical | High | Medium | Low |
|------|----------|------|--------|-----|
| Behavioral (B) | X | X | X | X |
| Structural (T) | X | X | X | X |
| **Total (deduped)** | **X** | **X** | **X** | **X** |

## Top Critical Issues
1. [B-/T- Issue 1]
2. [B-/T- Issue 2]
3. [B-/T- Issue 3]

Next steps:
1. Review the detailed feedback in {review_file}
2. Address critical issues (both lanes) before requesting PR approval
3. Consider the Canonical / Code-Judo Recommendation — it often resolves several findings at once
4. Discuss architectural and structural concerns with your team
```

## Tips

- **Two lenses, one report**: behavioral agents catch bugs/coverage; the
  structural agent catches drift, duplication, and missed simplifications the
  bug lens skips. They are complementary — neither subsumes the other.
- **Parallel execution**: all 5 agents run simultaneously, so the structural lane
  adds depth without adding wall-clock time.
- **Dedup before totals**: overlapping findings are counted once and marked
  `[both lanes]`, so the summary isn't inflated.
- **Canonical move first**: the structural lane's unifying recommendation is the
  highest-leverage item — it frequently dissolves multiple findings.
- **Incremental file naming**: saves to `…-nuclear-review.md` (incrementing), and
  never collides with a plain `/code-review` run.

## Agent Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                      Nuclear Code Review Orchestrator                          │
│                  (merge B- behavioral + T- structural, dedup)                  │
├─────────────┬──────────────┬────────────┬───────────────┬────────────────────┤
│ Application │Infrastructure│  Tests &   │ Architecture  │  Structural /        │
│ Code Agent  │ & Data Agent │  Quality   │    Agent      │  Thermo-Nuclear      │
│   (B-)      │    (B-)      │   (B-)     │    (B-)       │    Agent (T-)        │
├─────────────┼──────────────┼────────────┼───────────────┼────────────────────┤
│ - Endpoints │ - Database   │ - Unit     │ - Data flow   │ - Abstraction qual. │
│ - Services  │ - Migrations │ - Integ    │ - State mach. │ - Drift / dup logic │
│ - Handlers  │ - Jobs/Queue │ - E2E      │ - Races       │ - Spaghetti growth  │
│ - Validation│ - CI/CD      │ - Fixtures │ - Security    │ - File-size / layers│
│ - Errors    │ - Config     │ - Coverage │ - Scalability │ - Code-judo moves   │
├─────────────┴──────────────┴────────────┴───────────────┴────────────────────┤
│                       Utility Agents (Delegatable)                            │
│   file-analyzer · code-analyzer · test-runner · parallel-worker               │
└──────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                          ┌──────────────────────────┐
                          │  Merged Final Review      │
                          │  (B- + T-, deduped)       │
                          └──────────────────────────┘
```

The behavioral lane (Agents 1–4) is identical to `/code-review`. The structural
lane (Agent 5) runs the `thermo-nuclear-code-quality-review` and
`thermo-nuclear-code-quality-review-decompose` skills and returns severity-bucketed
`T-` findings, which the orchestrator merges with the behavioral `B-` findings.

### Skill / Lane Integration

| Source | Lane | Purpose |
|--------|------|---------|
| `.claude/skills/*/SKILL.md`, `CLAUDE.md` | All | Project standards & language-specific patterns |
| `code-review/thermo-nuclear-code-quality-review/SKILL.md` (ships in repo) | Structural (T-) | The maintainability review standard |
| `code-review/thermo-nuclear-code-quality-review-decompose/SKILL.md` (ships in repo) | Structural (T-) | Decomposes that review into severity buckets |
| `code-review/parallel-pr-review/SKILL.md` (ships in repo) | Orchestrator | Dedup-before-synthesis merge rule |

## Note on Review Quality

`/code-review-nuclear` is a strict superset of `/code-review`: it keeps all four
behavioral lenses and adds a structural one. The behavioral lenses answer "does
this work and is it safe?"; the structural lens answers "did this leave the
codebase cleaner or messier, and was there a dramatically simpler way?" Merging
both — with overlaps deduped and the canonical code-judo move surfaced — catches
issues that neither lens finds alone (e.g. a shipped enum-drift defect that bug
hunting misses because the broken file was never in the diff).

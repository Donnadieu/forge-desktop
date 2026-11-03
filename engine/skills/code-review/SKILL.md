---
name: code-review
description: Deep multi-agent code review of the current branch vs main — launches 4 parallel specialized agents (application, infrastructure/data, tests, architecture), rebases onto main, generates the diff, and writes a severity-bucketed review to tmp/code-reviews/. Use to review your own branch before requesting approval.
allowed-tools: Task, TaskOutput, Read, Write, Bash, Glob, TodoWrite
---

# Code Review Command

Perform comprehensive code review using parallel specialized agents for deep
analysis. Language-agnostic - auto-detects project type and references skill
files for language-specific patterns.

## Usage

```
/code-review
```

This command will:

1. Fetch latest changes from main branch
2. Rebase current branch onto main
3. Generate git diff against main (includes uncommitted and new files)
4. Save diff to `tmp/git-diffs/[branch-name]-diff.txt` (incrementing if exists)
5. Launch 4 parallel specialized agents for deep analysis
6. Orchestrate findings into comprehensive review
7. Save review to `tmp/code-reviews/[branch-name]-review.md` (incrementing if
   exists)

## Instructions

### 0. Automated Git Workflow

Execute the automated git workflow to prepare the diff:

```bash
#!/bin/bash
set -e

echo "🔍 Preparing code review..."

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
  echo "Please resolve conflicts and then run /code-review again."
  echo ""
  echo "To resolve:"
  echo "  1. Fix conflicts in the files listed above"
  echo "  2. git add <resolved-files>"
  echo "  3. git rebase --continue"
  echo "  4. Run /code-review again"
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

# Find next available filename for review
review_counter=0
review_file="$repo_root/tmp/code-reviews/${safe_branch_name}-review.md"
while [ -f "$review_file" ]; do
  review_counter=$((review_counter + 1))
  review_file="$repo_root/tmp/code-reviews/${safe_branch_name}-review-${review_counter}.md"
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

Launch **4 agents in parallel** using a single message with multiple Task tool
calls. All agents run in the background simultaneously.

**IMPORTANT**: You MUST launch all 4 agents in a SINGLE message with multiple
Task tool calls to ensure they run in parallel.

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

### 3. Wait for All Agents to Complete

Use TaskOutput to retrieve results from all 4 agents. Wait for each to complete.

> **Unattended runs:** launch the agents with `run_in_background: false` (still all
> in one message, so they run in parallel). Background agents report back only on
> a later turn; if the session ends first, their findings are lost and no review
> file is written. Write the review file before starting any fixes.

### 4. Orchestrate Findings into Final Review

After all agents complete, compile their findings into a comprehensive review:

```markdown
# Code Review: [Feature Name]

## Comprehensive Review by Parallel Agent Analysis

This review was conducted by 4 specialized agents:

- **Application Code Agent**: Source code, API endpoints, business logic
- **Infrastructure & Data Agent**: Database, jobs, config, CI/CD
- **Tests & Quality Agent**: Test coverage, test quality, tooling
- **Architecture Agent**: System design, data flow, race conditions

---

## Executive Summary

| Category         | Critical | High  | Medium | Low   |
| ---------------- | -------- | ----- | ------ | ----- |
| Application Code | X        | X     | X      | X     |
| Infrastructure   | X        | X     | X      | X     |
| Tests & Quality  | X        | X     | X      | X     |
| Architecture     | X        | X     | X      | X     |
| **Total**        | **X**    | **X** | **X**  | **X** |

---

## CRITICAL Issues (Must Fix Before Merge)

[Consolidate all CRITICAL findings from all agents]

---

## HIGH Priority Issues

[Consolidate all HIGH findings]

---

## MEDIUM Priority Issues

[Consolidate all MEDIUM findings]

---

## Suggestions (LOW Priority)

[Consolidate suggestions]

---

## What's Good

[Consolidate positive findings from all agents]

---

## Architecture Diagram

[Include any diagrams from Architecture agent]

---

## Summary Checklists

### Must Fix Before Merge

- [ ] Issue 1
- [ ] Issue 2

### Should Fix

- [ ] Issue 1
- [ ] Issue 2

### Nice to Have

- [ ] Issue 1
- [ ] Issue 2
```

### 5. Write Review Output

Write the orchestrated review to the review file:

```yaml
Write:
  file_path: "{review_file}"
  content: "{orchestrated_review}"
```

### 6. Inform User

```
✅ Comprehensive parallel-agent code review complete!

📄 Diff saved to: [{diff_file}]({diff_file})
📄 Review saved to: [{review_file}]({review_file})

## Results Summary

| Category | Critical | High | Medium | Low |
|----------|----------|------|--------|-----|
| Application Code | X | X | X | X |
| Infrastructure | X | X | X | X |
| Tests & Quality | X | X | X | X |
| Architecture | X | X | X | X |
| **Total** | **X** | **X** | **X** | **X** |

## Top Critical Issues
1. [Issue 1]
2. [Issue 2]
3. [Issue 3]

Next steps:
1. Review the detailed feedback in {review_file}
2. Address critical issues before requesting PR approval
3. Consider high/medium priority issues
4. Discuss architectural concerns with your team
```

## Tips

- **Parallel execution**: All 4 agents run simultaneously, reducing total review
  time
- **Language-agnostic**: Agents auto-detect project type and reference skill files
- **Deep analysis**: Each agent focuses on a specific domain, enabling thorough
  review
- **Architecture review**: Catches systemic issues that line-by-line review
  misses
- **Rebase strategy**: Uses `git rebase` to keep clean linear history with main
- **Incremental file naming**: Automatically creates `-diff-1.txt`,
  `-diff-2.txt`, etc. to avoid overwriting previous reviews

## Agent Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Code Review Orchestrator                  │
├─────────────┬─────────────┬─────────────┬──────────────────┤
│ Application │Infrastructure│  Tests &   │   Architecture   │
│ Code Agent  │ & Data Agent │  Quality   │      Agent       │
│             │              │   Agent    │                  │
├─────────────┼─────────────┼────────────┼──────────────────┤
│ - Endpoints │ - Database   │ - Unit     │ - Data flow      │
│ - Services  │ - Migrations │ - Integ    │ - State machine  │
│ - Handlers  │ - Jobs/Queue │ - E2E      │ - Race conditions│
│ - Validation│ - CI/CD      │ - Fixtures │ - Security       │
│ - Errors    │ - Config     │ - Coverage │ - Scalability    │
│             │ - Docker     │ - Linting  │ - API contracts  │
├─────────────┴─────────────┴────────────┴──────────────────┤
│                    Utility Agents (Delegatable)             │
├─────────────┬─────────────┬────────────┬──────────────────┤
│   file-     │   code-     │   test-    │    parallel-     │
│   analyzer  │   analyzer  │   runner   │    worker        │
│  (summarize │  (deep bug  │  (run tests│  (parallelize    │
│   large     │   hunting,  │   & analyze│   multi-file     │
│   files)    │   trace     │   results) │   analysis)      │
│             │   logic)    │            │                  │
└─────────────┴─────────────┴────────────┴──────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  Orchestrated   │
                    │  Final Review   │
                    └─────────────────┘
```

### Skill File Integration

Agents automatically discover and use skill files for language-specific patterns:

| Skill File Location | Used By | Purpose |
|---------------------|---------|---------|
| `.claude/skills/backend/SKILL.md` | Application, Infrastructure | Backend-specific patterns |
| `.claude/skills/frontend/SKILL.md` | Application, Tests | Frontend-specific patterns |
| `.claude/skills/*/SKILL.md` | All agents | Domain-specific guidance |
| `CLAUDE.md` | All agents | Project-wide standards |

### Utility Agents

The 4 review agents can delegate to these specialized utility agents when needed:

| Agent | When to Use | How to Invoke |
|-------|-------------|---------------|
| `file-analyzer` | Large files (>500 lines), verbose logs, need summary first | `Task` with `subagent_type: "file-analyzer"` |
| `code-analyzer` | Deep bug hunting, trace logic across files, security analysis | `Task` with `subagent_type: "code-analyzer"` |
| `test-runner` | Verify changes don't break tests, run specific test files | `Task` with `subagent_type: "test-runner"` |
| `parallel-worker` | Analyze many files in parallel, coordinate sub-tasks | `Task` with `subagent_type: "parallel-worker"` |

## Note on Review Quality

This command provides a principal engineer-level review using:

- **Parallel specialized agents**: 4 agents with domain expertise run
  simultaneously
- **Language-agnostic design**: Auto-detects project type from config files
- **Skill file integration**: References `.claude/skills/` for language-specific patterns
- **Composable agent architecture**: Review agents can delegate to utility agents
  (file-analyzer, code-analyzer, test-runner, parallel-worker) for specialized tasks
- **Deep analysis**: Each agent thoroughly reviews its domain (not surface-level
  scanning)
- **Architecture review**: Dedicated agent for systemic issues, race conditions,
  and design
- **Socratic method**: Collaborative, question-based feedback
- **Prioritized findings**: Issues categorized by severity for actionable
  results

The parallel approach catches significantly more issues than single-pass review,
especially architectural and cross-cutting concerns.

### Composable Agent Benefits

The review agents can dynamically delegate to utility agents when they encounter:

| Scenario | Utility Agent | Benefit |
|----------|---------------|---------|
| Large file (>500 lines) | `file-analyzer` | Summarizes first, reducing context |
| Suspicious code pattern | `code-analyzer` | Deep bug hunting with structured output |
| Need to verify tests pass | `test-runner` | Runs tests and analyzes results |
| Many files to analyze | `parallel-worker` | Parallelizes sub-analysis |

This composability allows review agents to handle complex scenarios without
bloating the main review with excessive detail.

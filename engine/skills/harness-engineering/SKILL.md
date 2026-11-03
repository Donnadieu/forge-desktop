---
name: harness-engineering
description: Make a repository agent-legible — generate AGENTS.md, docs/, and
  architecture tests so any coding agent can work in this repo without
  external context.
---

# Harness Engineering

Make this repository self-describing for coding agents. Generate the
agent-legible scaffolding that enables any future agent (Claude Code, Codex,
Kimi) to understand and work in this codebase without external context.

## Prerequisites

Before starting, read these files in the repo (if they exist):

- `prd.md` or any PRD/spec file — for product context, user journeys, non-goals
- `plan.json` or any technical plan — for stack, architecture, data model
- The directory structure — `ls -R` or equivalent to understand what exists
- `package.json` / `pyproject.toml` / equivalent — for stack confirmation
- Any existing config files (tsconfig, eslint, biome, etc.)

## Two Modes: Scaffold, or Harden an Existing Repo

This skill runs in two situations and the deliverable differs:

- **A repo Forge just built.** The scaffolding below is authored as part of the
  build, alongside the code it describes.
- **A repo that already exists** (an import, or an app being brought up to
  standard). Here the deliverable is a **single repo-hardening PR** — one review,
  one merge — that adds the same scaffolding to a codebase nobody wrote it for.

The hardening PR is deliberately one PR and deliberately additive. It installs
the *guards*; it does not pay down the debt they find. Every violation the
structural lint grandfathers is a backlog ticket, not a silent exemption, and the
PR body says so.

### Running it (from a Forge card)

The card that sent you here lists the **guardrails the owner chose** after a
repo assessment (the `repo-assessment` skill). Build exactly those, plus the agent
docs below, in **one additive pull request**:

1. **Read first.** Re-read the repo (the assessment on the card is a summary, not
   a substitute). Detect the stack from its own manifests; a stack you cannot
   prove is a **stated skip** with a reason in the PR body, never a guess.
2. **Stock formatter + linter** for the stack. Format the whole tree in its own
   commit BEFORE recording any baseline (formatting changes line counts).
3. **Custom rules** in one script in the repo's own language (e.g.
   `tools/lint/<repo>-lint.*`): each rule = a function + an id + a one-line WHY +
   a `FIX:` line an agent can follow verbatim. Run it on the current code first:
   tune false alarms, list real hits.
4. **Ratchet.** Existing violations go into a baseline file (`{rule|file: count}`)
   whose counts may only go down; a second check fails CI when the baseline grew
   compared with the base branch.
5. **Enforce in three places:** a tracked pre-commit hook (`.githooks/` +
   `git config core.hooksPath .githooks`, or the repo's existing hook tool), one
   local command that runs everything (`make check` or a package script), and CI
   running the same on every pull request.
6. **Prove it blocks:** for each custom rule, a canary (a small file that breaks
   the rule) must make the check fail with its FIX line; keep a `--prove` mode or
   a test that does this so the proof stays in CI.
7. **Agent docs** (below), pointing at the commands from steps 2 to 6.

The PR installs the guards; it does not pay down the debt they find. Every
grandfathered violation is listed in the PR body as follow-up work.

## Files to Generate

<!--
  Each artifact heading below carries a machine-readable `<!-- artifact:<key> -->`
  marker. These keys are bound to `src/pipeline/harness-contract.ts` (the single
  source of truth) by `test/unit/pipeline/harness-contract.test.ts`, which fails
  if this skill mandates an artifact the contract omits, or vice versa. When you
  add or remove a mandated artifact here, update the contract in the same change.
-->

### 1. AGENTS.md (repo root) <!-- artifact:agents-md -->

~80-120 lines. Table of contents for agent navigation. NOT an encyclopedia.

```markdown
# <Project Name>

<2-3 sentence overview from PRD>

## Stack

<language> / <framework> / <database> / <styling>

## Quick Commands

  <package manager> install    # Install dependencies
  <package manager> run dev    # Start dev server
  <package manager> run build  # Production build
  <package manager> run test   # Run tests
  <package manager> run lint   # Lint code

## Directory Structure

  <root>
  ├── src/           # Application source
  ├── test/          # Tests
  ├── docs/          # Architecture and design docs
  ├── <other dirs>   # Whatever the plan specifies

## Key Docs

- [Architecture](docs/ARCHITECTURE.md) — layer rules, dependency directions
- [Design](docs/DESIGN.md) — component patterns, style conventions
- [Product Sense](docs/PRODUCT_SENSE.md) — user journeys, non-goals
- [Quality Score](docs/QUALITY_SCORE.md) — per-domain grading

## Conventions

- <package manager> is <pnpm/npm/yarn>
- Test runner is <vitest/jest/pytest>
- Deploy target is <where it deploys>
- Use design system components, never raw HTML for interactive elements
- Max 400 lines per file
- All commits must be signed

## Required Skills

Load these before performing the matching action:
- `commit`: before every git commit
- `push`: before every git push
```

Adapt this template to the actual stack. Remove sections that don't apply.
Add sections specific to this project's conventions.

**Folder-local guides (recommended, not required).** For any subsystem folder with
non-obvious, load-bearing conventions — the DB/migrations directory, API routes, a
component library, a code-generation step — drop a short local `AGENTS.md` naming that
folder's invariants and the test that guards them, plus a sibling `CLAUDE.md` (see below).
Keep them terse: a warning before the edit, not a copy of the root docs.

### 1b. CLAUDE.md (repo root) <!-- artifact:claude-md -->

A one-line pointer so Claude Code — and any tool that reads `CLAUDE.md` — loads the same
context as `AGENTS.md`, with no second copy to keep in sync. The whole file is:

    @AGENTS.md

`@AGENTS.md` is an include directive; it pulls in `AGENTS.md` verbatim. Do not duplicate the
content. Put the same one-line `CLAUDE.md` beside every folder-local `AGENTS.md` too.

### 2. docs/ARCHITECTURE.md <!-- artifact:docs-architecture -->

Generate from the technical plan's architecture section. Include:

- **Layer diagram** — ASCII diagram showing module layers and dependency
  directions (based on plan.architecture.pattern and plan.directoryStructure)
- **Module inventory** — table with module, layer, responsibility, allowed deps
- **Dependency rules** — numbered list of import constraints
- **Extension points** — how to add new modules/layers

For a typical full-stack app:

```
Layer 0 (Foundation): types, config, utilities — no upward imports
Layer 1 (Data): repositories, database access — imports Layer 0
Layer 2 (Business): services, domain logic — imports Layers 0-1
Layer 3 (API): routes, controllers — imports Layers 0-2
Layer 4 (UI): components, pages — imports Layers 0-3 (via API calls)
```

Adapt the layers to match the plan's actual architecture. If the plan uses
a different pattern (MVC, hexagonal, etc.), document that instead.

### 3. docs/DESIGN.md <!-- artifact:docs-design -->

Generate from the plan's designSystem section. Include:

- **Component library** — which one (shadcn, MUI, etc.) and how to use it
- **Color tokens** — primary, secondary, accent, destructive, muted with
  actual hex values from plan.designSystem.colorPalette
- **Typography** — heading, body, mono fonts with actual font names
- **Spacing and radius** — from plan.designSystem.borderRadius
- **Rules** — "NEVER use raw HTML for interactive elements", "NEVER use raw
  color classes", "ALWAYS use design system components"

### 4. docs/PRODUCT_SENSE.md <!-- artifact:docs-product-sense -->

Generate from the PRD. Include:

- **Core user journeys** — 3-5 primary flows from prd.userStories
- **Non-goals** — what NOT to build, from prd.nonGoals
- **Success metrics** — from prd.successMetrics
- **Key constraints** — from prd.technicalConsiderations

### 4b. docs/INDEX.md (knowledge-base map) <!-- artifact:docs-index -->

A single table-of-contents for the whole `docs/` tree — the map, not the
encyclopedia. Link every doc from here (design-docs, product-specs, references,
generated, exec-plans, quality, runbooks). `AGENTS.md` points here as the entry
point. This is what makes progressive disclosure work: an agent starts small and
follows pointers. Always link, at minimum: `design-docs/core-beliefs.md`,
`design-docs/002-golden-principles.md`, `ARCHITECTURE.md`, `DESIGN.md`,
`PRODUCT_SENSE.md`, `QUALITY_SCORE.md`, `RELIABILITY.md`, `SECURITY.md`, and
`exec-plans/`.

### 4c. docs/references/index.md (dependency references) <!-- artifact:docs-references -->

A curated table of the project's load-bearing dependencies: role in the project,
how agents should use it *the way this repo does*, and a canonical docs/llms.txt
link. Do NOT paste upstream manuals — capture only repo-specific conventions.
Prefer boring, stable, well-represented libraries (easier for agents to model).

### 4d. docs/product-specs/index.md (user journeys) <!-- artifact:docs-product-specs -->

Core user journeys and product intent, complementing the technical spec. Says
*what the user is trying to do and why*, so agents can reason about product
tradeoffs, not just endpoints. Include non-goals.

### 4e. docs/generated/db-schema.md (generated, if there's a database) <!-- artifact:docs-schema -->

A human-readable map of every table, generated from the ORM schema by a script
(e.g. `scripts/generate-db-schema-docs.ts` + a `db:docs` package script). Use
runtime introspection, not source parsing, and emit **byte-stable** output (no
timestamps) so drift can be detected by regenerating and diffing. Header must say
"generated — do not hand-edit".

### 4e-bis. docs/generated/api-reference.md (generated, if there is an HTTP surface) <!-- artifact:docs-api-reference -->

The route-level twin of the schema doc: method, path, and handler file for every
endpoint, generated by a script that reads the framework's own route declarations
(Next.js app-router `route.ts` exports; `app.get("/…")`-style registrations for
Express/Hono/Fastify). Byte-stable, header says "generated — do not hand-edit".
It is a map for navigation, not a specification — schemas and examples belong in
an OpenAPI document. Skip when the project exposes no HTTP surface.

### 4f. docs/exec-plans/ (first-class plans) <!-- artifact:docs-exec-plans -->

`active/` and `completed/` directories plus a `README.md` documenting the
active→completed lifecycle, and a `tech-debt-tracker.md` (file-anchored,
grouped by severity). Plans are versioned artifacts with progress + decision
logs, not throwaway.

### 5. docs/QUALITY_SCORE.md <!-- artifact:docs-quality-score -->

Generate a per-domain grading table:

```markdown
# Quality Score

| Domain | Layer | Score | Gaps |
|--------|-------|-------|------|
| Auth | Data + API | 0/10 | Not yet implemented |
| Product CRUD | Data + API + UI | 0/10 | Not yet implemented |
| Design System | UI | 0/10 | Not yet configured |
| Architecture Tests | Infra | 0/10 | Not yet created |

Updated: <date>
```

Score each domain from the plan at 0/10 initially (nothing built yet).
Agents will update scores as they implement features.

### 6. test/architecture/ (stack-appropriate) <!-- artifact:architecture-tests -->

Generate architecture tests that enforce the rules in ARCHITECTURE.md.
Include agent-readable "FIX: ..." instructions in every assertion.

**For TypeScript/Node.js (Vitest):**

`test/architecture/boundaries.test.ts`:
- Scan src/ for cross-module imports
- Validate against allowed dependency map from ARCHITECTURE.md
- Violation message: "FIX: Move the import to an allowed module or update
  ARCHITECTURE.md if this dependency is intentional."

`test/architecture/file-size.test.ts`:
- No source file exceeds 400 lines
- Violation message: "FIX: Extract logic into a separate file within the
  same module."

`test/architecture/conventions.test.ts`:
- No console.log/error/warn in library code
- Barrel index.ts files contain only re-exports and small creation helpers
- Violation message: "FIX: Use the project's logger instead of console."
  or "FIX: Move logic to a dedicated file and keep index.ts as barrel."

**For Python (pytest):**

`test/architecture/test_boundaries.py`:
- Scan for import statements
- Validate against allowed dependency map
- Same violation pattern with descriptive error messages

Adapt the test framework and patterns to match the actual stack.
If the project uses Jest instead of Vitest, generate Jest-compatible tests.

### 7. Golden principles (docs/design-docs/002-golden-principles.md) <!-- artifact:golden-principles -->

Distinct from core beliefs (the *why*), golden principles are opinionated,
**mechanical** rules (the *what you must not violate*). Each principle names the
test that enforces it, so it fails a PR rather than relying on review. Examples:
parse-don't-guess at boundaries, prefer shared utilities over hand-rolled
helpers, structured logging only, file-size cap, barrels hold only re-exports.
A rule without a passing enforcing test is a gap to flag, not a suggestion.

### 7b. docs/design-docs/core-beliefs.md <!-- artifact:core-beliefs -->

Distinct from golden principles (the mechanical *what*), core beliefs are the
agent-first operating *why* — a short set of principles that explain the
judgment calls golden principles can't fully mechanize. ~40-80 lines. Write
THIS repo's actual beliefs, inferred from its real conventions — do not copy
the examples below verbatim.

```markdown
# Core Beliefs

Why this repo is built and maintained the way it is. Golden principles
(docs/design-docs/002-golden-principles.md) are the mechanical rules this
doc explains the reasoning behind.

## Agents are first-class readers of this codebase

Every doc, every comment, every file layout choice optimizes for a coding
agent with no prior context being able to work here safely — not just for
a human skimming once.

## Prefer boring, stable dependencies an agent can fully model

A library with surprising runtime behavior or sparse documentation costs
more in agent-hours than its feature saves. When a boring option exists,
take it.

## Context is scarce — point, don't duplicate

Knowledge lives in exactly one file. Every other reference is a link.
Duplication isn't redundancy, it's a drift source: the two copies will
disagree the day one of them changes and the other doesn't.

## Enforce invariants, don't micromanage implementation

Tests and lints should gate outcomes (a layer boundary respected, a file
under its size cap) not prescribe a specific way of writing the code that
respects them. Agents need room to solve problems; they don't need room to
violate invariants.

## A violation an agent can't see isn't actually enforced

Every rule in this repo has a test, a lint, or a CI check that fails
loudly with a `FIX:` instruction. A rule that only lives in a human's head
(or a code review comment) will eventually be violated by an agent who
never saw it.
```

### 7c. docs/RELIABILITY.md <!-- artifact:reliability -->

Platform-specific reliability requirements and how they're mechanically
enforced. ~40-100 lines. Adapt the metrics to the actual deployment target —
a desktop app and a web service have different failure modes.

```markdown
# Reliability

## Targets

<For a web service:>
- Uptime target: <e.g. 99.9%>
- Error budget: <e.g. <0.1% 5xx rate over 7d>
- p95 latency budget: <e.g. <500ms for API routes>

<For a desktop/native app:>
- Startup time budget: <e.g. <2s cold start>
- Crash-free session rate: <e.g. >99.5%>
- Update-mechanism safety: updates must verify signature/checksum before
  swapping in a new binary; a failed verification must fall back to the
  current working version, never leave the app in a half-updated state

## Enforcement

| Requirement | Enforced by |
|---|---|
| <metric> | <test/CI check/monitor — name it, or mark NOT YET ENFORCED> |

A requirement with no enforcement is a gap to flag, not a target to assume
is met. Do not invent a monitoring dashboard that doesn't exist — write
"NOT YET ENFORCED" rather than a placeholder link.

## Failure modes considered

List the ways THIS system actually fails today (crash reports, incident
history, known fragile integrations) and what, if anything, catches each
one before it reaches a user.
```

### 7d. docs/SECURITY.md <!-- artifact:security -->

Security invariants and how they're mechanically enforced. ~40-120 lines.
This doc must answer, concretely and for THIS repo: where does untrusted
content meet tool-execution privilege, and what stops a self-approval loop
(an agent approving, merging, or executing its own escalation)? A generic
answer ("be careful") is not acceptable — name the actual boundary and the
actual control.

```markdown
# Security

## Secrets handling

- Secrets are never logged (name the logger config or redaction rule that
  enforces this, or mark NOT YET ENFORCED)
- Secrets are never passed as CLI arguments (process lists, shell history,
  and `ps` output leak them) — passed via env/file/stdin instead
- Secret-bearing files are permission-hardened at rest (e.g. `chmod 600`,
  not world-readable)

## Sandbox / permission boundaries

<If applicable: what directories/resources are the app or its agents
confined to, and what enforces the boundary (OS sandbox, folder-lock,
container, capability check)?>

## Trust boundaries for agent/tool-execution surfaces

<If this repo runs an agent, a tool-calling LLM, or executes
model-generated code:>
- Where does untrusted content (model output, scraped web content, a
  third-party API response) first reach something with execution or
  approval privilege (shell exec, file write, merge/deploy action, a
  "yes" to a permission prompt)?
- What specifically prevents a self-approval loop — the same actor that
  produced the untrusted content also being the one that approves it for
  execution? Name the human-in-the-loop gate, the separate-principal
  check, or the allow-list that breaks the loop. If nothing currently
  does, say so as a finding, not a TODO.

## Known findings / open items

Track real, current findings here (or link to the tracker) rather than
asserting a clean bill of health the code doesn't back up.
```

### 8. Knowledge-base enforcement test <!-- artifact:knowledge-base-test -->

`test/architecture/knowledge-base.test.ts` (pure-fs, no DB) keeps the docs
legible over time. Assert: every relative doc link resolves; the design-docs
index agrees with disk both ways; the generated schema doc has a section per
table; no doc is orphaned (unreachable from an index). Same `FIX: …` violation
style as the other architecture tests.

### 8b. Structural lint with a baseline ratchet <!-- artifact:structural-lint -->

The mechanical golden principles, enforced by a script rather than by review:
file-size cap, no raw console in library code, barrels hold only re-exports,
and **dependency-direction enforcement**: parse (TypeScript/JS) or
pattern-match (any other stack's import/require/use syntax) each file's
imports and fail any edge that crosses a direction ARCHITECTURE.md's layer
diagram marks as disallowed. Same `FIX: …` convention as the other rule
categories, e.g. `FIX: Layer 1 (data) imported Layer 3 (API) — move the
shared logic down to Layer 0/1, or document the exception in
ARCHITECTURE.md.` When the stack can't be introspected reliably (no clean
import syntax to parse, or no documented layer diagram to check against),
this is a **stated skip** with a reason recorded in the PR body — the same
convention the rest of this skill uses for anything it won't guess at. Never
ship a dependency-direction rule that pattern-matches loosely enough to
false-positive; an unreliable rule gets disabled, same as an unratcheted lint.

The ratchet is the part that makes it survivable on an existing repo. A lint
dropped onto a mature codebase reports hundreds of violations, so it gets
disabled on day two. Instead:

- seed `.hardening/structural-lint-baseline.json` from the repo exactly as it
  stands — that debt is **grandfathered** and never reported again;
- the recorded counts are a **ceiling**: a violation in a file with no baseline
  entry fails, and one more violation in an already-dirty file fails;
- the baseline may only **shrink**. `--update` lowers or drops entries whose debt
  was paid down and can never add one or raise a count. CI additionally compares
  the baseline against the base branch, because the obvious way to defeat a
  ratchet is to edit the ratchet.

Ship it as a dependency-free script (`scripts/structural-lint.mjs`) so it travels
with the repo, with `--init` (seed once), `--update` (shrink), and a bare check
that exits non-zero.

### 8c. Drift guard (regenerate ⇒ diff ⇒ fail) <!-- artifact:drift-guard -->

`.github/workflows/hardening-drift-guard.yml` — on every pull request, regenerate
every generated doc and fail if the working tree changed, then run the structural
lint. This is the only check that proves a generated doc is *current*: asserting
that `db-schema.md` exists, or that it has a section per table, says nothing about
whether it matches today's schema. Regenerate-and-diff does.

Pair it with the gardening cron below. The guard detects; the gardener repairs.
Shipping only one of the two is how generated docs rot.

### 8c-alt. Sensitive-area doc-touch gate (lighter alternative for authored docs)

This is informational guidance for whoever applies the skill by hand, not a mandated/contract-bound
artifact (no marker, so it stays out of the harness-contract binding test).

8c's regenerate-and-diff only works when the doc is mechanically derivable from a schema or
route table. Many judgment-call docs (`docs/SECURITY.md`, `docs/RELIABILITY.md`,
`docs/design-docs/core-beliefs.md` — prose a human writes once by reading the real code, not
something any script could regenerate) have nothing to regenerate, so 8c doesn't apply to them
and they rot silently: a PR changes the sandboxed area, security fix, or retry semantics the doc
describes, and nobody touches the doc, because nothing forces it.

The lighter-weight alternative: a static **code-area → doc mapping** plus a **fail-on-touch-
without-doc** gate, run in CI/`make check` against the PR's diff. No regeneration, no AST
introspection — just "if file X changed, at least one of its mapped docs must have changed too,
or the PR must say explicitly why not."

- A small table: `{ sensitive_source_file: [doc_files_that_describe_it] }`. Keep it hand-curated
  and short — an area with no entry is invisible to the check, so add one whenever a new area
  gets its own doc section.
- The check diffs the PR against the base branch; if a mapped source changed and none of its
  docs did, fail with a `FIX:` message naming exactly which doc(s) to touch.
- An escape hatch for genuine false positives: a marker in the commit message (e.g.
  `[skip-doc-drift]` with a one-line reason) treats a real hit as a stated skip instead of a
  hard failure — never a silent one.
- Optionally, a best-effort (non-failing) scan of the watched docs for "still open" / "known
  gap" / "todo" phrasing, printed as a nudge to re-verify a finding is still true — useful but
  never authoritative, so it never blocks a PR on its own.

Reach for this instead of a full 8c regenerate-and-diff guard when the doc is **authored, not
generated** — there's no schema to regenerate against, only a human's prose that needs a
reminder to stay in sync with the code it describes. Reach for 8c instead when the doc genuinely
is derivable from a schema/route table/config; regenerate-and-diff is the stronger proof there,
and this gate would just be a weaker substitute for it.

Worked example: `tools/doc-drift-check.py` in `Donnadieu/one` (the "One" Mac app, a repo with no
schema/route surface to regenerate against) implements exactly this pattern — a
`SENSITIVE_AREAS` dict mapping sandbox/updater/secrets/browser-guard source files to
`docs/SECURITY.md` / `docs/RELIABILITY.md` / `docs/design-docs/core-beliefs.md`, wired into
`make check` as `make docdrift`, with a `[skip-doc-drift]` commit-message escape hatch and a
best-effort stale-phrase scan. It was added after three security fixes landed across three
releases while `docs/SECURITY.md` kept describing them as open, caught only by a manual
harness-engineering pass — exactly the failure mode this gate exists to catch mechanically.

### 9. Doc-gardening automation (the GC) <!-- artifact:doc-gardening -->

A recurring "garbage collector" that pays documentation debt down continuously:

- `scripts/doc-gardening.ts` with `--check` (report; exit non-zero on hard
  findings — broken links, index drift, stale generated docs) and `--fix`
  (regenerate mechanical docs, leave judgment calls for a human).
- `.github/workflows/doc-gardening.yml` — weekly cron + `workflow_dispatch` that
  runs `--fix` and opens a small automergeable PR when the tree changes.
- `skills/doc-gardening/SKILL.md` — the on-demand, agent-facing entry point.

The scheduled run does four mechanical passes: regenerate the generated docs,
repair links whose target merely moved (rewrite only when the basename resolves
to exactly one file — one candidate means a rename, not a guess), re-grade the
scorecard, and shrink the structural-lint baseline to the debt that actually
remains.

### 10. Pattern-drift garbage collection <!-- artifact:pattern-drift-gc -->

Doc-gardening (artifact 9) keeps the docs current. This is the broader,
code-pattern twin: a recurring job that re-runs the structural lint (artifact
8b) against the **whole repo**, not just new changes, diffs the result
against the current baseline, and for any area that newly shrank (debt paid
down elsewhere makes a tighter rule affordable) or newly violates, opens a
small, scoped PR fixing just that area.

- `scripts/pattern-drift-scan.*` (match the repo's own script language —
  `.mjs`/`.ts` for Node, `.py` for Python, etc.): runs the structural lint in
  full-repo mode, compares against `.hardening/structural-lint-baseline.json`,
  and for each newly-tightenable or newly-violating file, stages a scoped fix
  (or an issue, if the fix isn't mechanical) rather than a repo-wide rewrite.
- `.github/workflows/pattern-drift-scan.yml` — a recurring cron (weekly is a
  reasonable default) plus `workflow_dispatch`, running the scan and, when it
  finds something, opening a PR.
- **Default to flagging for human review, not auto-merge.** OpenAI's internal
  version auto-merges low-risk pattern-drift PRs at their scale and review
  capacity; a typical single-maintainer repo does not have that review
  bandwidth margin, so the default here is a PR that waits for a human.
  Auto-merge is an **opt-in** (`--auto-merge` on the script, or an explicit
  flag in the workflow file) a repo can enable once it trusts the scan's
  precision on its own codebase — never the shipped default.
- Keep this distinct from doc-gardening: doc-gardening repairs *documentation*
  staleness (links, generated docs, the scorecard); pattern-drift GC repairs
  *code*-pattern staleness (the structural lint's rule categories). A repo
  may have one without the other — don't merge the two scripts into one just
  because they're both "a GC cron."

## What NOT to Generate

- Do NOT create docs that duplicate existing README.md content
- Do NOT create generic boilerplate — everything must reference THIS
  project's actual stack, architecture, and design system
- Keep each doc lean — a map, not an encyclopedia. Generate the indexes and
  design docs above, but do not pad them; an empty section is worse than a
  pointer. Skip `references/`, `product-specs/`, or `generated/` entirely if the
  project has nothing real to put there yet.
- Do NOT create architecture tests for stacks you're not sure about —
  skip rather than generate incorrect tests
- Do NOT include placeholder text like "TODO" or "TBD" — use real values
  from the plan, or omit the section
- EXPORT SAFETY: these files are committed to the repository and may be shared or
  published — write about THIS application only. Never reference the platform that
  generated the repo: no internal product names, hostnames, infrastructure slugs, or
  environment-variable prefixes belonging to the generator. Describe what the code does,
  not how it was built.

## Verification

After generating all files, verify:

1. AGENTS.md references actual files that exist in docs/
2. ARCHITECTURE.md dependency rules match the plan's directory structure
3. DESIGN.md uses real values from the plan (not placeholder colors/fonts)
4. QUALITY_SCORE.md has a row for each major domain in the plan
5. Architecture tests pass against the current (scaffolded) codebase
6. No file contains "TODO", "TBD", or placeholder text

Run the architecture tests to confirm they pass:

```bash
# TypeScript
<package manager> run test -- test/architecture/

# Python
pytest test/architecture/
```

If tests fail on the scaffolded code, fix the test or the scaffold —
the tests must be green on day one.

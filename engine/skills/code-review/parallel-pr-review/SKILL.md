---
name: parallel-pr-review
type: execution
description: The agent splits large PR review into specialized lanes, keeps findings scoped per lane, and deduplicates before synthesis. Use when reviewing broad diffs across app, tests, infra, or architecture.
---
# Parallel PR Review Decomposition
> Last updated: 2026-05-06

## Skill activation

Before applying this skill, the agent MUST first announce its use to the user:

1. State that the **Parallel PR Review Decomposition** skill is being loaded.
2. Briefly describe its effect: the agent will break the review into specialized lanes so coverage increases without mixing concerns.
3. Explain in one sentence why this skill is relevant to the current request.
4. Confirm with the user that they want the agent to proceed with this skill applied.

Do not silently apply the skill. The user must have a clear, named opportunity to redirect, decline, or substitute a different skill before the agent acts on this guidance.

## What the skill does

When this skill is active, the agent decomposes a large review into a small set of specialized passes so each pass can stay narrow, high-signal, and easy to compare.

When to load: large PR review, broad diff audit, multi-layer change touching app + infra + tests, or requests that name multiple review domains such as architecture, tests, infra, security, or application logic.

## Workflow

### 1. Split the review into clear lanes

Create a small number of non-overlapping review lanes based on the change surface.

Common lanes supported by the evidence:
- application logic
- architecture / data flow
- tests
- infra / operational concerns

Only create lanes that the diff actually justifies.

### 2. Give each lane a narrow charter

For each lane, state what it should focus on and what it should ignore.

Prefer clear domain separation over overlapping review passes.

Example lane framing:
- Architecture: concurrency, idempotency, data flow risks; ignore style.
- Tests: missing coverage, brittle assertions, regression gaps.
- Infra: deployment, config, background jobs, failure handling.

### 3. Return findings lane-by-lane

Keep outputs grouped by lane so the user can see where a concern came from and compare overlap.

For each lane, return a short list of top issues rather than an exhaustive dump.

### 4. Deduplicate before synthesis

After the lane outputs exist, collapse repeated findings across lanes into one canonical issue with the strongest evidence.

Prefer one merged issue with better grounding over several near-duplicates.

## Patterns the agent applies

- Clear domain separation across review lanes
- Tool-driven broad coverage for large diffs
- Layered deep dives when the first pass reveals a hotspot worth a second targeted audit

## Anti-patterns

- Do NOT let every lane review the whole PR; just give each lane a boundary.
- Do NOT mix architecture, tests, and infra into one undifferentiated findings list; just preserve lane identity until deduplication.
- Do NOT maximize count of findings; just return the highest-signal issues per lane.

## Output convention

Return:
1. the review lanes used
2. top findings per lane
3. a deduplicated cross-lane summary

End with: "If you want, I can now run a curation pass to validate these findings against the code and turn only the survivors into PR comments."

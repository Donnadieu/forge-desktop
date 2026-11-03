---
name: triage
description: Spike, investigate, and plan a Backlog ticket WITHOUT implementing it. Use when a ticket is in the `Triage` status — read the code, reproduce/confirm the problem or map the feature surface, and produce an execution-ready plan (hierarchical checklist, acceptance criteria, validation, risks, estimate) in a `## Forge Triage` comment. Never write feature code or open a PR. On completion the caller moves the ticket back to `Backlog` and adds the `ready-for-execution` label so a human can decide when to build it.
---

# Triage / Spike

The pre-execution planning stage. A human moved this ticket into `Triage`
because it needs investigation before it is worth building. Your job is to
**de-risk and plan it, not build it**. The output is a spike another Forge run
(or a human) can pick up cold and execute.

## Hard rules

- **No implementation.** Do not write feature code, do not create a branch for
  changes, do not open a PR. Read-only investigation plus (optionally) a throwaway
  reproduction is the entire remit.
- **Do not edit the issue body/description.** All output goes in a single
  `## Forge Triage` comment.
- **Additive to Linear only** — one triage comment; do not spam extra comments.

## Workflow

### 1. Open the triage record
Find or create a single `## Forge Triage` comment on the issue (distinct from the
execution `## Forge Workpad`). Everything below lives in that one comment, kept
updated in place.

### 2. Investigate
- Read the issue and any linked context.
- Locate the concrete code involved: files, modules, functions, interfaces,
  config, tests. Cite exact paths.
- For a bug: reproduce or confirm the signal (command + output, failing test, or
  deterministic UI behavior) so the fix target is explicit. A temporary local
  reproduction is allowed; revert it — never commit it.
- For a feature: map the surface end-to-end (entry point → data flow → where the
  effect lands) and the existing patterns to follow.
- Check `origin/<base-branch>` and open PRs for overlapping/already-done work; if
  the work already exists, record the evidence and recommend `Done`/`Duplicate`
  instead of a plan.

### 3. Produce the spike
Write these sections into the `## Forge Triage` comment so an executor can start
without re-investigating:

- **Summary** — what the change is and why, in a few sentences.
- **Findings** — the concrete code map (files/functions), the confirmed
  reproduction (for bugs), and the chosen approach with any decisions taken.
- **Plan** — a hierarchical checklist of implementation steps.
- **Acceptance Criteria** — falsifiable, checkable outcomes (include a UI
  walkthrough for user-facing changes).
- **Validation / Test Plan** — the exact commands/tests that prove it works.
- **Risks & Open Questions** — anything that could derail execution.
- **Estimate** — rough scope/effort.

### 4. Split if needed
If the spike shows the ticket is really several units of work, file the follow-up
issues (clear title/description/acceptance criteria, same project, `related` link,
`blockedBy` where dependent) and note them in the triage comment.

### 5. Hand off
Move the ticket **back to `Backlog`** and add the `ready-for-execution` label
(create the label if it does not exist). Do **not** move it to `Todo` — a human
decides when execution starts. Do not open a PR or start implementation.

## Triage comment template

````md
## Forge Triage

### Summary
<what + why>

### Findings
- <file:line / module> — <what it does, why it matters>
- Reproduction: `<command>` → <observed>

### Plan
- [ ] 1\. <step>
  - [ ] 1.1 <sub-step>
- [ ] 2\. <step>

### Acceptance Criteria
- [ ] <falsifiable outcome>

### Validation / Test Plan
- [ ] `<command>` → <expected>

### Risks & Open Questions
- <risk / question>

### Estimate
- <rough scope / effort>
````

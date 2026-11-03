---
name: thermo-nuclear-code-quality-review-decompose
description: Decompose a Thermo-Nuclear (maintainability / structural) code review into severity-bucketed findings — Critical/High/Medium/Low tables with per-finding file:line, diagnosis, and code-judo remedy — matching the /code-review output shape without losing any content. Use after running a thermo-nuclear / deep code-quality review, or when asked to restructure, bucket, severity-rank, or tabulate a maintainability review's prose findings into the same format as the bug-focused review.
disable-model-invocation: true
---

# Thermo-Nuclear Code Quality Review — Decompose

The [[thermo-nuclear-code-quality-review]] skill produces a deep, ambitious **maintainability** review, but its output is prioritized prose (by structural concern), not severity-bucketed findings. The bug-focused `/code-review` flow produces Critical/High/Medium/Low tables. These two are **complementary** — same PR, different lens — and teams want them in one comparable shape.

This skill **runs the Thermo-Nuclear review and decomposes its findings** into the same severity-table format, losslessly — one invocation that produces both the deep maintainability review *and* its severity-bucketed breakdown. (If a finished thermo review is already supplied, it skips straight to decomposing.) The decomposition itself is a faithful transform of the review, not a second re-review.

## When To Use

- As the default: run the Thermo-Nuclear review on the current branch and get its findings back as Critical/High/Medium/Low tables (no separate step).
- When you already have a maintainability/structural review (pasted, in a file, or in the conversation) and want it bucketed by severity like `/code-review`.
- As the structural lane inside `/code-review-nuclear`, which fans this out alongside the behavioral agents and merges the results.
- To merge a Thermo-Nuclear review and a bug-focused review into one unified findings list.

## Inputs (pick the first that applies)

1. **A diff/branch to review (default, no review supplied)** — run the full two-step Execution below: perform the Thermo-Nuclear review, then decompose it. This is the primary mode. If no diff file is named, review the current branch's working tree + diff vs `origin/main` (the same diff `/code-review` produces).
2. **A finished thermo review is provided** — a file path, pasted text, or a review already in this conversation. Skip Step A and decompose that text directly (ingest fallback).
3. **Genuinely nothing to act on** — ask which branch to review or which review to decompose. Never invent findings from scratch.

## Execution

**Step A — Run the review** (skip if input mode 2 already gave you a finished review):
Perform the Thermo-Nuclear review by following the sibling `thermo-nuclear-code-quality-review` skill (`.forge/skills/code-review/…`, `.agents/skills/code-review/…`, or `$HOME/.claude/skills/…`, first that exists) against the diff. Apply its full standard — be ambitious about structural simplification, hunt for code-judo moves, and **read unchanged consumer files too** (drift like an enum mapped one way in the feature and another way in an untouched consumer is exactly what this lens exists to catch, so do not restrict yourself to changed files). Produce the review's prose findings, its canonical/code-judo recommendation, and its "what's good" notes.

**Step B — Decompose** the Step A output into the severity buckets using the rubric below, preserving every finding, its `file:line`, its remedy, and the Canonical/Code-Judo section, per the Prime Directive. The decomposition must not lose or soften anything Step A found.

## Prime Directive: Lossless Decomposition

This is a reformat. The decomposed output must preserve **everything** the source review found:

- **Every finding maps to exactly one row.** Do not drop, merge, or silently summarize away findings. A finding-count check at the end must match.
- **One exception — splitting:** if a single prose paragraph actually contains two separable findings (e.g. "the enum has drifted *and* the label switch is duplicated"), split it into two rows. Splitting preserves content; merging loses it.
- **Never invent.** Do not add findings, severities, or claims the source review did not make. If you want to add a new observation, say so explicitly as a clearly-labelled `[decomposer note]`, separate from the source findings.
- **Preserve the detail of each finding:** the structural diagnosis (the *why it's a problem*), the `file:line` references, any cross-file drift evidence, and — critically — the **remedy / "code-judo" move** the review proposed. The remedy is the most valuable part of a Thermo-Nuclear review; never collapse it to "refactor this."
- **Preserve the big-picture move.** Thermo-Nuclear reviews often propose one unifying restructuring (e.g. "introduce one canonical enum and route all readers through it") that dissolves several findings at once. Do not fragment it across rows until it's unrecognizable — keep a dedicated **Canonical / Code-Judo Recommendation** section that states the unifying move, and cross-reference the individual findings it resolves.
- **Do not re-grade or soften.** If the source review calls something a presumptive blocker, it stays a blocker. Keep its conviction and tone.

## Severity Rubric (maintainability-calibrated)

Bug severity ≠ maintainability severity. Map the Thermo-Nuclear skill's own **presumptive blockers** and **priority order** onto severities by *impact × conviction*, not by structural category:

- **CRITICAL — must fix before merge.** A structural problem that has already produced, or will certainly produce, a shippable defect: contract/enum drift across files, two parts of the app disagreeing on the same concept, or any "presumptive blocker" from the parent skill that the author cannot justify. (Example: a status enum written as `5` in the feature but mapped as `6` in the audit labels — the structure failed and a real defect shipped.)
- **HIGH — strongly recommended before merge.** A clear structural regression or a high-conviction code-judo move that materially reduces complexity: verbatim-duplicated logic when a canonical helper already exists, a file pushed from <1k to >1k lines, feature checks scattered across shared code, or a missed reframing that would delete whole branches/layers.
- **MEDIUM — should fix.** A real, concrete improvement that doesn't block merge: extract a helper or predicate, introduce a named constant for a magic value, unify two encodings of one concept, move logic to its canonical layer.
- **LOW — nice to have.** Minor structural nits and consistency notes: a nested closure that bloats a big function, a single magic number, a stylistic inconsistency that doesn't threaten correctness.

When the source review states an Approval Bar / blocker list, those items anchor the top of the Critical/High buckets. The parent skill's priority order (structural regression → missed simplification → spaghetti growth → boundary/type → file-size → modularity → legibility) is a **tie-breaker for ordering within a bucket**, not a severity in itself.

## Output Format

Mirror the `/code-review` shape so the two reviews are directly comparable:

```markdown
# Thermo-Nuclear Review (Decomposed): <Feature>

> Source: <review file / pasted / run-on-branch>. This is a lossless decomposition of a
> maintainability review — structural lens, not bug/coverage hunting.

## Executive Summary

| Severity | Count |
| -------- | ----- |
| CRITICAL | X |
| HIGH     | X |
| MEDIUM   | X |
| LOW      | X |

**Headline:** <the review's one-to-two-sentence thesis, verbatim-faithful>

## Canonical / Code-Judo Recommendation
<the single unifying restructuring the review proposed, if any, and which finding IDs it resolves>

## CRITICAL (Must Fix Before Merge)
### C1 — <title>
**`path/to/file.ext:line`**
<structural diagnosis, faithful to the source>
**Remedy:** <the code-judo / restructuring move the review proposed>

## HIGH
### H1 — ...

## MEDIUM
### M1 — ...

## LOW
### L1 — ...

## What's Good
<preserve the review's positive findings>

## Summary Checklists
### Must Fix Before Merge
- [ ] C1 — ...
### Should Fix
- [ ] H1 — ...  M1 — ...
### Nice to Have
- [ ] L1 — ...
```

Save the result next to the bug-focused review, using the `/code-review` naming convention:
`tmp/code-reviews/<safe-branch-name>-thermo-decomposed.md` (increment `-1`, `-2`, … if it exists).

## Self-Audit Before Finishing

1. **Count parity** — number of distinct findings in the source == number of rows out (splits accounted for). State the count: "Decomposed N source findings into N rows."
2. **No dropped references** — every `file:line` in the source appears in the output.
3. **No unassigned severity** — every finding has exactly one bucket.
4. **Remedy retained** — every finding that proposed a fix still carries that fix.
5. **No invented findings** — anything not in the source is labelled `[decomposer note]`.
6. **Big-picture intact** — if the review proposed a unifying move, it survives as its own section.

## Optional: Merge With the Bug-Focused Review

If a `/code-review` output exists for the same branch and the user asks for one combined list, append a **Cross-Reference** note rather than blending the two lenses silently: keep Thermo (structural) and code-review (behavioral) findings distinguishable by ID prefix (e.g. `T-C1` vs `B-C1`), and flag any finding both reviews raised so it isn't double-counted.

## Tone

You are a faithful transcriber with a severity rubric, not a second reviewer. Keep the source review's conviction, keep its remedies, keep its evidence. Add nothing silently; lose nothing.

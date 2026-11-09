---
name: simplify
description: Quality-only cleanup pass over the code changed on this branch — improve reuse, simplification, efficiency, and altitude while preserving behavior exactly. Use at the END of execution (before AI Review) once the change is working and validated. This is NOT a bug hunt (that is `code-review`); it only makes already-correct code cleaner. Focuses on recently modified code, re-runs validation after changes, and commits with the `commit` skill.
---

# Simplify

Run this as the final execution step, after the change works and validation is
green. It refines the code you just wrote for clarity, consistency, and
maintainability **without changing behavior**. It does not look for bugs — that
is the job of `code-review` / `code-review-nuclear` in the AI Review stage.

## Scope

- Only the code changed on this branch (`git diff origin/<base-branch>...`).
  Do not refactor untouched code.
- Preserve behavior exactly. If a "simplification" would change observable
  behavior, it is out of scope — leave it and note it for review instead.

## What to look for

- **Reuse** — replace bespoke code with an existing helper, type, or pattern
  already in the codebase; delete duplication introduced by the change.
- **Simplification** — collapse needless indirection, dead branches, redundant
  state, over-general abstractions, and noisy comments that restate the code.
- **Efficiency** — remove obvious wasted work (redundant queries, N+1s,
  re-computation) only where the fix is clearly behavior-preserving.
- **Altitude** — put logic at the right layer and match the surrounding module's
  idioms, naming, and comment density (see AGENTS.md / ARCHITECTURE.md). Keep
  barrel `index.ts` files re-export-only; keep files under the size limit.

## Procedure

1. Diff the branch against the base to scope the changed surface.
2. Apply the cleanups directly (this skill applies fixes, it does not just
   report them).
3. Keep each change small and obviously behavior-preserving.
4. Re-run the scope's validation (`make all` or the targeted subset) and confirm
   it is still green. If anything goes red, revert that cleanup.
5. Commit and push the simplifications with the `commit` skill (signed).
6. Leave a one-line note in the `## Workpad` `Notes` section summarizing
   what was simplified (or "no simplifications needed").

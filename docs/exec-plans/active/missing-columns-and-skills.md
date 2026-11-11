# Plan: missing columns, parking, Next step and skills in sessions

Design: [design/missing-columns-and-skills.md](../../design/missing-columns-and-skills.md). Omar's decision (Nov 11):
build all six together, one goal, one release.

## Rules for this plan
- Every item is test-first: a failing test (output saved), the fix, the test passing. Then an offscreen render.
- Never touch Omar's real Linear workspace: fake boards in tests.
- Tick a box only when its PR is merged to main.
- One release once every box is ticked.

## Progress
- [x] 1. Setup: Continue works with missing columns; "Add them to Linear…" only on a tap; a plain line says what Forge will and won't do without them (PR #94)
- [x] 2. Workflow Studio: a stage with no column turns off by itself, greyed out with its reason, and comes back when the column shows up (PR #96)
- [x] 3. Orchestrator: never moves a card into a column that doesn't exist; a stage runs only if its column exists and it's on (PR #98)
- [x] 4. Parking: In Progress done with no next column = stays In Progress, nothing posted, parked "Waiting on you" in forge.sqlite, draft PR, no retry loop, the tracker wins, easy to see (PR #100)
- [x] 5. Orchestrator "Next step": stage moves only (AI review, QA, human review, rework, merge); a column moves the card, no column runs it locally and parks it again (PR #103)
- [x] 6. Skills in sessions: found in the repo, ~/.claude/skills, Codex and Forge's own; a Skills button and "/" open the same searchable list; cached, refreshed on change; nothing read outside skill folders (PR #107)
- [x] Ship: make check, one signed and notarized release, zip and dmg seals verified (v0.2.30)

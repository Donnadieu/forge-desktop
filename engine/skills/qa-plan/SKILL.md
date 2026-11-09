---
name: qa-plan
description: The QA stage — draft a QA plan for this repo's change, EXECUTE it end-to-end against the app running locally, self-heal on failure (fix the code, re-run), then attach media evidence to the PR and the Linear card and add the `qa-complete` label. Use when a card reaches the `QA` status. Data setup is strictly additive — never delete or mutate existing records.
---

# QA (draft → execute → self-heal → evidence)

The automated QA stage. The change has passed AI Review; now prove it actually
works against the running app, fix anything QA catches, and leave media evidence
for the human reviewer. This runs unattended and loops until every scenario
passes (bounded).

Learn how this repo runs before planning: its `README`, `AGENTS.md` /
`CLAUDE.md`, `CONTRIBUTING`, `Makefile` / `package.json` scripts, and CI config
say how to install, start and test it. Use what they say; don't invent a stack.

## Think like a QA engineer, not a browser driver

The question is **"how do I verify this change end-to-end?"** — not "is this in
the browser?". Before writing the plan, decompose the change into three things:

1. **Observation surface — where does the effect become visible?** A page in
   the app's UI, a command's output, a file it writes, an API response, a
   database row, a log line. A change with no UI is still QA-able — watch a
   different surface. Follow the diff to where the effect lands.
2. **Trigger — what real action produces it?** Prefer a UI action you can
   drive in a browser; otherwise a real inbound edge (an HTTP call, the CLI
   command); as a last resort a documented console/DB step that fires the
   *genuine* code path.
3. **Data prep — what must exist first?** Seed additively. Never delete or
   mutate existing data.

## Core rules

- **Additive data only.** Create new fixtures; never delete, reset or mutate.
- **Falsifiable expectations.** Every scenario states an exact checkable result
  on the identified surface (URL becomes X, element Y present, the command
  prints Z) — not "it works".
- **Self-heal, don't hand off.** When a scenario fails, that is a real defect —
  fix the code, re-validate, re-run. Do not just report it.
- **Bounded loops.** At most 3 fix→re-run cycles. If it still fails, move the
  card to `Human Review` with a blocker brief in the workpad.
- **Never use real credentials you weren't given.** If a scenario needs a
  secret or an outside account the environment doesn't have, say so in the
  workpad and move to `Human Review` rather than faking it.

## Workflow

### 1. Map the change → surface / trigger / data
Read the PR diff. Follow the code from the changed lines to the observation
surface, back to the trigger(s), and list the data + setup each needs.

### 2. Derive scenarios
Happy path, each branch/fallback, the "does nothing" cases, and the
**regression** the fix targets. Each scenario names its trigger and its
expected result on the surface from step 1.

### 3. Start the app + seed additively
Install and start the app the way the repo says (for example `npm install`
then `npm run dev`, `make run`, `docker compose up`). Use free local ports. If
the branch adds migrations, apply them to a local database only. Seed only new
fixtures. Stop everything you started when QA is done.

### 4. Draft the plan
Fill [assets/qa-plan-template.md](assets/qa-plan-template.md): the
environment, the surface/trigger header, the fixtures table, and one numbered
section per scenario with an explicit expected result. Save it under
`.context/qa-plan-<card>.md` (keep `.context/` out of commits).

### 5. Execute the plan end-to-end
Drive every scenario against the running app.

- **UI surfaces:** drive the real UI with a headless browser (Playwright, or
  browser tools if they are connected). **Never skip a UI scenario because a
  browser is unavailable — install Playwright's Chromium and run headless.**
  Note in the workpad which way you used.
- **Non-browser surfaces:** drive the real trigger (the command, an HTTP call)
  and inspect the surface (its output, the file, the response, the row).

### 6. Self-heal on failure
If any scenario fails:
1. Fix the underlying code.
2. Re-run the repo's validation (its tests, lint, build), confirm green.
3. Commit + push with the `commit` skill (signed).
4. Re-run the affected scenarios.
Repeat until all pass, up to 3 cycles. Record each failure + fix in the workpad.

### 7. Capture media
On a fully passing run, capture a screenshot per key scenario and, for a UI
flow, a short video or GIF of the primary flow (Playwright's screenshot and
`recordVideo`). For a command, render its transcript to an image. Name files
meaningfully (`qa-<card>-<scenario>.png`).

### 8. Attach evidence to PR + card
- **Card:** upload each file with the Linear `fileUpload` mutation (see the
  `linear` skill: `fileUpload` → `curl -X PUT` to `uploadUrl` → use `assetUrl`),
  then embed the `assetUrl`s in the workpad comment under a `### QA Evidence`
  heading, one line per scenario with a pass note.
- **PR:** `gh pr comment <pr> --body` with a `## QA Evidence` section embedding
  the same asset URLs and the per-scenario pass summary.

### 9. Close out
Add the `qa-complete` label to the card (create it if missing), update the
workpad QA summary, and move the card to `Human Review`.

---
name: forge-desktop-change
description: Use before any change in Forge Desktop. The loop that keeps the repo clean.
---

# Making a change in Forge Desktop

## Before
1. Read [AGENTS.md](../../../AGENTS.md) and the doc for the area you're touching ([docs/INDEX.md](../../../docs/INDEX.md)).
2. Check [docs/exec-plans/active/](../../../docs/exec-plans/active/scaffold.md): is this the next step? Don't jump ahead.
3. One clone needs `make hooks` once (identity from `.env`).

## During
- Swift: put code in the right folder (App / UI / Core / EngineHost). `make format` before committing.
- Engine: only files from the import list, copied at one Forge commit, each with a row in
  `engine/PROVENANCE.md`. `make engine-fix` then `make engine`.
- Prefer the simpler design. Delete before adding.

## After
- `make check` green, then land it (docs/HARNESS.md "Landing a change").
- Update the plan's Progress checklist and QUALITY_SCORE.md if an area changed.
- Learned something reusable? Add it below under Lessons.
- Same mistake twice? Add a rule to `tools/lint/forge-lint.py` with a canary in `CANARIES`.

## Lessons
- A check launch of the app (`--window-check`) must set itself to `.accessory` and see-through, or it
  flashes a window on the person's screen; launched hidden with `open -j` it gets napped and never reports.
- `mise` can't record trust for `.mise.toml` in sandboxed shells; `tools/engine.sh` falls back to
  mise's installed Node 22 directly.

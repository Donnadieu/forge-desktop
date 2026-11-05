---
name: forge-desktop-change
description: Use before any change in Forge Desktop. The loop that keeps the repo clean.
---

# Making a change in Forge Desktop

## Before
1. Read [AGENTS.md](../../../AGENTS.md) and the doc for the area you're touching ([docs/INDEX.md](../../../docs/INDEX.md)).
2. Check [docs/exec-plans/active/](../../../docs/exec-plans/active/scaffold.md): is this the next step? Don't jump ahead.
3. One clone needs `make hooks` once (identity from `.env`).
4. Read the Lessons below. They are mistakes already made once in this repo.

## During
- Swift: put code in the right folder (App / UI / Core / EngineHost). `make format` before committing.
- Engine: only files from the import list, copied at one Forge commit, each with a row in
  `engine/PROVENANCE.md`. `make engine-fix` then `make engine`.
- Prefer the simpler design. Delete before adding.

## After
- `make check` green, then land it (docs/HARNESS.md "Landing a change").
- Update the plan's Progress checklist and QUALITY_SCORE.md if an area changed.
- Learned something reusable about this repo (code, build, tests, engine)? Add it below under
  Lessons, in the same pull request. Lessons about one person's machine or accounts stay out.
- Same mistake twice? Add a rule to `tools/lint/forge-lint.py` with a canary in `CANARIES`.

## Lessons

### App checks and launches
- A check launch of the app (`--window-check`) must set itself to `.accessory` and see-through, or it
  flashes a window on the person's screen; launched hidden with `open -j` it gets napped and never reports.
- Preflight can leave `--window-check` copies running from `build/`. They share the bundle id, can take
  over `open -a Forge`, and ignore SIGTERM. After a run, kill only those:
  `pgrep -f "build/app.noindex/Forge.app/Contents/MacOS/Forge --window-check"`.
- Never call `NSApp.terminate` from a main-queue block (dispatch source, `DispatchQueue.main.async*`,
  a @MainActor Task): it waits for `reply(toApplicationShouldTerminate:)` on the main queue and hangs
  forever. Use `AppDelegate.quitSoon()`; preflight checks quit-by-itself and quit-on-SIGTERM.
- Updater code must handle `NSApp` being nil (CLI modes like `--update-now`).
- `NSWorkspace.icon(forFile:)` and `NSImage(named: applicationIconName)` return the blank icon on the
  first launch after a rebuild: checks retry or read the .icns directly.

### Swift
- New `SetupChoices` fields must be Optional: synthesized Decodable throws on a missing key, and
  `load()` would silently reset the whole setup.
- A new agent sign-in method is a new `SetupChoices.Worker` case, so old settings decode unchanged.
  Route every `switch` on Worker (WorkerCheck, RepoReader, SetupProbe, EngineSettings, AgentSignIn, SetupApply).
- `guard x || (await f())` doesn't compile (async in an autoclosure): compute into a `let` first.
- A memberwise init with a `private` stored property becomes private: give new SetupFrame params
  `var ... = default`.
- Big UI rewrite: delete the old view files first and build; the compiler's errors list every call site
  of the removed components. Add selftest checks in `Sources/App/Checks.swift` for each new pure rule
  (old settings JSON must still decode: include the required Bool fields, or it fails for the wrong reason).

### Screens
- Colours, fonts and controls come only from `Theme.swift` and `Controls.swift`. Never stock
  `.accentColor`, `.green` or system fonts.
- A vertical divider `Rectangle().frame(width: 1)` inside an HStack stretches the row to fill its
  parent: give the HStack a fixed height. Top-bar buttons need `.lineLimit(1).fixedSize()` or they
  wrap at 1200 px.
- A `.plain` TextField/SecureField draws its placeholder in the field's foreground colour: use
  `forgeField(hint:empty:)`, not `prompt:`.
- `--render-screens` draws 1200x800 with fake traffic lights, and prominent buttons come out grey
  (the window isn't key). Don't "fix" the colour, and say the live title bar is unproven.

### Shell, tests and the gate
- `cmd | grep -q` under `set -o pipefail` can fail on SIGPIPE: capture the output into a variable first.
- A test that fails only in the full suite or the commit hook is a race until proven otherwise. Fix it
  the second time it shows up instead of retrying: reproduce with 4 parallel runs x 5, show the old code
  fails and the new code passes.
- README release links must be absolute URLs: `docs-map` flags `../../releases`.
- `mise` can't record trust for `.mise.toml` in sandboxed shells; `tools/engine.sh` falls back to
  mise's installed Node 22 directly.

### Worktrees
- `.env` is git-ignored: copy it into a new worktree before committing.
- With `engine/node_modules` symlinked to main's, `git add -A` stages the link (`git rm --cached` it)
  and `make engine` fails its frozen install: run biome, tsc and vitest from `engine/node_modules/.bin`.
- `pnpm install` in a worktree replaces that link with a real (git-ignored) folder: don't `rm` it in
  an `&&` chain before the commit, or the commit never runs.

### Engine, agents and bundled skills
- Bundled skills copied from Forge must lose hosted-platform content.
  `engine/test/unit/workspace/bundled-skills.test.ts` greps for it (even "factory functions" needs
  rewording). Record each adaptation in `engine/PROVENANCE.md`.
- Desktop agents run as the signed-in person, with their own `~/.claude` settings and commands. Claude
  Code's commit/PR attribution outranks the commit skill, and only top-level `.claude/skills/<name>`
  registers. `workspace/copy-assets.ts` turns attribution off in the card's `.claude/settings.local.json`
  and mirrors nested skills to the top. When an agent ignores a skill, find the desktop-only cause in its
  transcript before adding any enforcement.
- Claude sign-in: decide "signed out" from the failure text (authenticate, OAuth, expired, 401), not
  from `claude auth status`. An expired session can exit 0, so checks read `is_error` and the result.
  Sign-in tokens are 108 characters: another length means the parser glued or cut text (check the
  length, never the value).

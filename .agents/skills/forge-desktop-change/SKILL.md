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
- Stage Manager and the Dock get an app's icon from macOS by bundle id; Finder and `NSWorkspace.icon(forFile:)`
  get it by path. macOS 26 keeps the bundle-id picture: a new version, a new icon file, an asset catalog
  or `lsregister -f` don't replace it. A blank white tile in Stage Manager is that cache. Check icons by
  bundle id (`SystemIcon.state`), test icon changes on a copy with a new bundle id, and clear the cache
  with `notifyutil -p com.apple.iconservicesd.clearCache.immediately` (Forge does it at launch when stale).
- macOS 26 shrinks any icon picture that doesn't sit on its icon grid (squircle 824/1024 of the canvas)
  onto a light plate. The small SVG's 16/32 px art is drawn bigger, so the iconset ships 64 to 1024 px.

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

- Agents start dev servers detached (`(bin/rails server &)`, `nohup vite &`): they leave the agent's process
  group, and puma's title (`$0 =`) wipes the environment marker the tree kill searches for, so they outlived
  their cards for hours. `process/leftovers.ts` finds them by working folder (`lsof`) instead; a lock holder
  stops them at a run's start and end, and the poll loop every 3 minutes. Keep that check to detached
  processes (parent pid 1) with no terminal whose cwd is inside the workspace root, so an editor or shell
  the person opened there is never touched. Its real-process test runs on macOS only (Linux may hand
  orphans to a subreaper instead of pid 1).

- Dispatch fills only the free slots, in stage order (furthest along first), and a refused claim ends that card's
  turn without trying the next one. A card someone else holds in a later column (another person's In Progress
  card) therefore took the only free slot every poll and the Todo cards never ran: one agent short of the limit,
  with `ticket claim refused` every 30 s in the log. Refused cards now rank last for 10 minutes
  (`state.claimRefused`, like workspace-locked cards). Any new reason to refuse a card must also rank it last,
  or it starves the queue the same way.

- A usage limit (Claude's 5-hour or spend limit, Codex's usage limit, a quota) is not a failure: retrying it every
  minute burnt the retry queue, then the card fell off it and failed every 30 s with no reason shown.
  `orchestrator/usage-limits.ts` parks the card until the reset with the same attempt and no slot; the texts are read
  in `agent/usage-limit.ts`, one recorded line per provider in its test. Add a provider's new limit text there, never
  a retry rule.
- Codex's app-server reports a failed turn as `turn/completed` with `turn.status: "failed"` and `turn.error`, not
  `turn/failed`: reading every `turn/completed` as success hid Codex's usage limits.

- Claude Code's Bash tool resets PATH from the person's login shell (checked live with `claude -p`, Nov 9): a wrapper
  `gh` or `git` put first on the agent's PATH is skipped. Guard what an agent runs with a PreToolUse hook in the
  card's `.claude/settings.local.json` (exit 2, reason on stderr: the agent reads it and retries) and git's own hooks,
  as `workspace/marks-guard.ts` does.
- Anything an agent writes others can read (pull requests, card comments, commits, branches) must pass `findMarks`
  (`tracker/marks.ts`) when the workspace keeps Forge invisible. A new place the engine or a prompt writes to
  people goes through it too, and its words must not name Forge.

- The disk gate (`workspace/inode-pressure.ts`) only refuses to START cards under 10% free; a running agent once wrote a
  78 GB file in three minutes (`exec > f 2>&1` then `cat f`, copying the file into itself) and every card stopped with
  nothing on screen. `workspace/runaway-guard.ts` stops such a run and the app shows why (`disk` in the engine state).
  Anything that can stop dispatch must reach the screen the same way, never only the log.

### Sessions
- Snapshots (`git commit-tree` in `sessions/git.ts`) must pass `--no-gpg-sign`: the person's global config may sign
  every commit, which would sign (and maybe prompt for) a private snapshot on every turn.
  Linux CI has no git identity and can't guess an email, so commit-tree fails there while it passes on a Mac: give it a
  placeholder identity only when `git var GIT_COMMITTER_IDENT` fails.
- `Forge --transcript-check` timings on GitHub's Mac runners are about 4x a desk Mac: the check scales its budget when
  `CI` is set.
- A worktree's `.git` is a file: find merge or rebase state with `git rev-parse --absolute-git-dir`, never `<folder>/.git/`.
- `git checkout <sha> -- .` fails on an empty tree: check `git ls-tree` first.
- Claude Code (2.1.319) sends `AskUserQuestion` and `ExitPlanMode` as `can_use_tool` requests even in
  `bypassPermissions`; answer a question with `updatedInput.answers` = {question: label}. Approving a plan switches the
  session to `default`, so set the permission mode back or the next Bash call asks.
- Test chats with `engine/test/fixtures/sessions/fake-claude.mjs` (`FORGE_CLAUDE_COMMAND`), never a real `claude`.
- Claude Code's transcript (`~/.claude/projects/<folder with every non-alphanumeric as ->/<session>.jsonl`) has no
  result line: a card session's turn ends at an assistant message with `stop_reason: end_turn` and no tool call.
  Lines with `isSidechain: true` are helpers' own conversations; skip them.
- A run waiting for the person (hands-on) must keep touching `lastActivityAt`, or the stall check kills it.

### Intelligence provider accounts
- An account's secret is a Keychain item named at run time (`Keychain.get/set/delete(named:)`); `Keychain.has(named:)`
  reads attributes only, so migration can look without a dialog. Never copy a secret to rename it: carried-over
  accounts keep their old item names.
- A browser account must sign in and run inside its own folder: `claude setup-token` with `CLAUDE_CONFIG_DIR`,
  `codex login` and Codex's agents with `CODEX_HOME`. Claude agents with a kept sign-in get only
  `CLAUDE_CODE_OAUTH_TOKEN` (their `~/.claude` settings stay as before); without one, `CLAUDE_CONFIG_DIR` points at the
  empty folder, which Claude Code answers with "Not logged in" (checked live, 2.1.318) instead of the Mac's own login.
- OpenRouter is Claude Code with `FORGE_SMITH_EXECUTION_PROVIDER=openrouter` + `OPENROUTER_API_KEY` for the engine's
  own switch (`claude-env.ts`, keeps the `anthropic/...` model name) and the plain Anthropic variables for checks
  run outside the engine. A new provider is a new `SetupChoices.Worker` case plus an `IntelligenceProvider` case.

### Trackers (Linear, Basecamp, GitHub Issues)
- A new tracker touches every place that says Linear: `SetupChoices.board`, setup 1 and 2, `EngineSettings`
  (tracker block, environment, the note in front of lead.md), `AppModel.makeCard`/`projectURL`, the Orchestrator's
  words and fixes, `SetupApply`. `grep -rn Linear Sources` before calling it done.
- Bundled skills must not mention Basecamp (`bundled-skills.test.ts` bans it), so tracker-specific agent
  instructions live in `engine/workflow/<tracker>.md`, put in front of the lead's instructions by the app.
- Basecamp keeps rich text as HTML with only div, h1, br, strong, em, a, pre, ul, ol, li, blockquote, and no
  line breaks between blocks: anything that reads comments line by line (labels, the workpad) must turn a
  block's end into a new line first (`tracker/rich-text.ts`, `extractLabels`).
- Basecamp access tokens last about an hour and a renewal may replace the refresh token: only the app renews
  (`Forge --basecamp-token`, under a file lock); the engine and the agents' tool run that command. Never give
  them the refresh token.
- Test the sign-in without touching the person's: `FORGE_KEYCHAIN_SERVICE=<scratch>` and `FORGE_HOME=<scratch>`
  keep the Keychain items and setup apart; `Forge --basecamp-sign-in` prints the link and code instead of
  opening a browser. A sandboxed shell can't write the login keychain ("Operation not permitted"): make a
  scratch keychain (`security create-keychain`, unlock it) and point `FORGE_KEYCHAIN_PATH` at it. Never read
  Forge's items with `security -w`: the item's ACL trusts only Forge, so it fails or asks the person.
- The engine's env check must accept every way a tracker can get its secret (Basecamp: the token command);
  run the real engine once (`node dist/index.js` with a scratch `FORGE_HOME`, never press Start) and read
  `/api/v1/state` before calling a tracker done. Unit tests didn't catch the refusal to start.
- GitHub Issues: a project's built-in workflows set Status on their own ("Item added to project" to Todo, "Pull
  request linked to issue" to In Progress) and fight the pipeline: in the live test a card went from Human Review
  back to In Progress seconds after Forge moved it. Setup refuses to finish while they're on. Read them with
  `ProjectV2.workflows { name enabled }`; there is no API to switch one off, only `deleteProjectV2Workflow`.
- Adding Status options goes through `updateProjectV2Field(singleSelectOptions:)`, which replaces the whole list:
  send every existing option with its `id` (or every card in it loses its column). Order is the list order.
- Testing the GitHub sign-in from a sandbox: a scratch app copy and keychain (as for Basecamp), a stand-in device
  server proves the save path (`FORGE_GITHUB_AUTH`), then one real approval; record live GraphQL answers by
  wrapping `fetch` in the test script and keep them in `engine/test/fixtures/github/`.

### Workspaces and tracker connections
- Tracker sign-ins are per connection: read the running project's with `store.trackerItem(choices)` (or
  `BasecampLogin.item` / `GitHubLogin.item`, which `AppModel.useSignIns` points at it), never `Keychain.Item.linearKey`
  and friends directly; those names belong only to the connection carried over from before workspaces.
- Several engines run at once, one per project: never use `EngineHost.shared`, `Paths.workflow` or `GitHub.account` for
  a project's engine. Get its host with `model.host(for:)` / `model.link(for:)` and its answers with
  `store.runChoices(id, live: choices)`; `EngineSettings.prepare(c, host:)` writes into that host's folder.
- A setting every engine reads at start (the Mac-wide agent ceiling) must restart every running workspace's engines,
  not only the one on screen (`AppModel.restartEngines(in:shown:)`).
- Prove engine changes that span several engines with `Forge --engine-check` (it starts two real engines side by side)
  and role routing with the engine test `roles-dispatch.test.ts`, which fails without the hand-off.
- A project's answers live whole in `setup.json` while it's on screen and in `ProjectRecord.choices` otherwise. A new
  `SetupChoices` field that belongs to the Mac rather than the project (like the Harness engineering records) must be
  carried in `SetupChoices.carried()` and `SetupStore.choices(for:)`, or switching projects drops it.
- Pieces every screen shares (the top bar's workspace chip) read the model from `\.forgeModel` in the environment;
  `RootView` sets it. A popover can't be drawn by `--render-screens`: render its view on its own (`13-workspace-switcher`).
- Roles (`SetupChoices.roles`) belong to the project, while Workflow Studio's other answers (`WorkflowSettings`) belong to
  the workspace: Workflow Studio shows and saves the on-screen project's roles and says so in its side panel. Don't move
  roles into `WorkflowSettings` without carrying the per-project ones over.
- Test a migration on a copy of the real folder: `FORGE_HOME=<copy> Forge --workspaces-check` (reads only whether
  Keychain items exist, never a secret).


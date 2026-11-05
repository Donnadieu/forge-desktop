# Architecture

Two parts in one repo: a native SwiftUI app (`Sources/`) and the board engine (`engine/`), a
TypeScript process the app starts, watches and stops. They talk over `127.0.0.1` only, with a
random port and a token handed over at launch. Secrets live in the Keychain and reach the engine
only through its environment.

```
Forge.app (SwiftUI)  --starts/stops-->  engine (Node, bundled)  --runs-->  claude / codex / kimi, git, gh
      ^                                        |
      +--------- local API (HTTP + WebSocket) -+
```

## The app (`Sources/`)

Dependencies point one way: **App -> UI -> EngineHost -> Core**. Each area is a folder; a new area is a new folder.

| Folder | What lives there | May use |
|---|---|---|
| `Sources/App/` | the entry point, the scene, check modes (`--selftest`, `--window-check`) | UI, Core |
| `Sources/UI/` | SwiftUI views and the app's one model (`AppModel`): setup screens, the board | EngineHost, Core |
| `Sources/Core/` | plain logic and facts every layer reads; Foundation only | nothing above it |
| `Sources/EngineHost/` | the only code that starts programs: the engine (`EngineHost`, single-flight start, watch, drain), the person's PATH (`ToolPath`), their tools for setup (`Tools`, `GitHub`, `GitHubSignIn`, `ForgeSigningKey`, `WorkerCheck`), the updater (`Updater`), `--engine-check`, `--github-check`, `--worker-check`, `--check-update` | Core |

Enforced by `tools/lint/forge-lint.py`: `core-imports` (no SwiftUI/AppKit in Core), `process-area`
(programs start only from `Sources/EngineHost/`), `no-browser-view`, `file-length` (400).

## The engine

Copied from Forge at a recorded commit ([engine/README.md](../engine/README.md),
[engine/PROVENANCE.md](../engine/PROVENANCE.md)). Same layer map as Forge's engine, minus the web platform.
Layer N may import only from lower layers. Enforced by `engine/test/architecture/boundaries.test.ts`.

| Layer | Module | Responsibility | May use |
|---|---|---|---|
| 0 | `config/` | workflow file schema, loader, watcher, env, AI provider list | none |
| 0 | `observability/` | logger, secret redaction | config |
| 0 | `process/` | process tree start/kill, process table (Linux and macOS) | none |
| 0 | `telemetry/` | per-card telemetry types | tracker |
| 1 | `agent/` | Claude Code, Codex, Kimi runners | process, config |
| 1 | `tracker/` | Linear, Basecamp, GitHub Issues (and an in-memory board for tests) | observability |
| 1 | `mcp/` | Linear, Basecamp or GitHub tools for agents | tracker, observability, config |
| 1 | `workspace/` | one folder per card, hooks, skills copy, git identity | tracker, process |
| 1 | `store/` | the engine's SQLite file: Start/Stop intent, finished runs and their tokens | none |
| 2 | `worker/` | one card's agent run, turns, the lead waiting for its helpers (`helper-wait.ts`) | agent, tracker, workspace, telemetry |
| 3 | `orchestrator/` | the board loop: poll, claim, dispatch, retry, reconcile | agent, tracker, workspace, worker, observability, telemetry, config |
| 3 | `server/` | the local API the app talks to (127.0.0.1 + launch token, HTTP + live WebSocket) | orchestrator, observability, config, store |
| 4 | `src/index.ts` | wires it together | anything |

**Never in the engine** (the test fails if any appears): `db/`, `services/`, `pipeline/`, `auth/`,
`clients/`, `smith/`, `cli/`, `ui/`. Accounts, billing, hosting and the factory chat stay in Forge.

The full import list (which Forge files come over) is in the plan,
[exec-plans/active/scaffold.md](exec-plans/active/scaffold.md#engine-import-list).

## How the app runs the engine

- The app bundles a pinned Node (`engine/node-version.txt`, SHA-checked by `tools/fetch-node.sh`) and the
  engine's compiled JS with its production packages (`tools/bundle-engine.sh`, called by `build.sh`).
- `EngineHost` starts `node dist/index.js` with a fresh 64-character token and the secrets in its
  environment. The engine binds `127.0.0.1:0` and prints one line, `FORGE_ENGINE_READY {"port":N}`.
- Every request carries `Authorization: Bearer <token>`. `GET /api/v1/state`, `POST /api/v1/start|stop|refresh`,
  and `WS /api/v1/live`, which pushes the state when it changes (the app never polls).
- One engine at a time; a healthy one is never restarted. A crash restarts it (1 s, 2 s, 4 s... up to 30 s,
  then gives up after 5 in a row and says why). Quit sends SIGTERM: the engine drains (running agents get
  `FORGE_DRAIN_MS`, 20 s), then stops; SIGKILL only if it hangs.
- Agents get the person's login-shell PATH plus the usual tool folders (an app opened from the Dock has a bare PATH).
- Basecamp: the sign-in is Basecamp's device sign-in (`Core/BasecampLogin.swift`, the public client its own
  command-line tool uses); the access and refresh tokens live only in the Keychain (`basecamp-login`). The
  access token lasts about an hour. The engine and the agents' `basecamp_api` tool never see the refresh
  token: they run the app itself, `Forge --basecamp-token` (`FORGE_BASECAMP_TOKEN_COMMAND`), which renews
  the token in the Keychain under a file lock and prints a short-lived one. On a Basecamp board the app puts
  `engine/workflow/basecamp.md` in front of the lead's instructions, with the board's ids filled in: it maps
  every Linear step to Basecamp (HTML comments, `Label:` lines for labels, the move endpoint).
- GitHub Issues: the board is a GitHub project (v2). Its single-select Status field is the column (one option
  per pipeline column, matched by name; setup adds the missing ones keeping every existing option's id), the
  issues carry assignees, labels and comments, and the pull request that closes an issue is its pull request.
  The sign-in is GitHub's device sign-in (`Core/GitHubLogin.swift`, the public client GitHub's own CLI uses,
  scopes `repo read:org project`, since the Mac's `gh` sign-in usually lacks `project`); the token lives only in
  the Keychain (`github-tracker-login`) and doesn't expire. The engine (`tracker/github.ts`) and the agents'
  `github_graphql` tool run `Forge --github-token` (`FORGE_GITHUB_TOKEN_COMMAND`). The app puts
  `engine/workflow/github.md` in front of the lead's instructions. GitHub's own project automations that set
  Status ("Item added to project", "Pull request linked to issue"...) fight the pipeline, so setup asks the
  person to turn them off.
- The Linear tools for agents are configured with a `${LINEAR_API_KEY}` placeholder, filled from the agent's
  environment, so no key is ever written into a card's folder.

## The lead waits for its helpers

A lead agent sends helpers (Claude Code background subagents or commands) and may end its turn while
they work. Claude Code keeps the session alive, reports each helper's end (`task_started` /
`task_notification`) and runs another turn. The engine follows those events: a turn is over only
when no helper runs. While the lead waits, the read and turn timeouts pause; one limit applies
(`agent.helper_wait_ms`, 60 minutes). If it is hit, the run stops and the card gets a plain note.
Proven by `engine/test/unit/worker/lead-waits-for-helpers.test.ts`, which fails on Forge's old runner.

## Getting a repo ready for agents (setup 6)

- `EngineHost/RepoReader.swift` shallow-clones the repo into a scratch folder and runs the chosen agent
  once, read-only (Claude Code with only Read/Grep/Glob allowed; Codex with `--sandbox read-only`), with
  the bundled `repo-assessment` skill. The answer ends in a JSON block: summary, what's missing, risks,
  and the guardrails worth adding. It's saved in `repo-report.json`, so closing Forge doesn't lose it.
- The person ticks guardrails; Forge makes one card in Todo (Linear, Basecamp or GitHub Issues) whose description lists them and
  names the `harness-engineering` skill. The pipeline does the rest: a pull request that lands in Human
  Review. "Skip for now" moves on; Settings' Harness engineering tile brings the screen back.
- Kimi can't do the read yet (it says so on the screen).
- Forge keeps a small record per repo in `setup.json` (`SetupChoices.harness`, `Core/Harness.swift`): read or
  not, the guardrails proposed, the ones in the latest card, the ones landed, the card, its pull request and
  whether it merged. Status: not started, partly done, done (every recommended guardrail landed).
  `EngineHost/HarnessCheck.swift` refreshes it from GitHub when Settings or the step opens: the card's pull
  request is found by the card's identifier in its branch or title; with no record, a merged pull request
  titled "… ready for agents" means done, and an AGENTS.md or a pre-commit hook in the repo's top folder
  means partly done.
- Opened from Settings, setup is in its changing mode: the step list drops the Orchestrator, every step is a
  button with its own mark (check, half circle for partly done, empty red circle), and the screens say
  Settings, not Setup. Changing the repo there offers harness engineering for the new repo; a partly done
  repo shows its landed guardrails ticked off and lets the person pick only what's left.

## The board

- The engine reads every card in the board's columns (`board.columns`) from Linear, Basecamp or GitHub on start, on every
  poll interval and on Refresh, and merges in what each agent holding a card is doing:
  one plain line built from its events (`orchestrator/activity.ts`), its helpers, and its last lines.
- The state reaches the app over the live WebSocket when it changes. The app never polls.
- Usage: a Claude plan's windows (5 hours, week) from Claude Code's `rate_limit_event`; otherwise tokens today.
- Card detail adds the workpad: `GET /api/v1/cards/<id>/workpad` reads the card's workpad note.
- Before starting the engine the app writes `WORKFLOW.md` (settings from setup plus the bundled lead
  instructions, `engine/workflow/lead.md`) and builds its environment from the Keychain and the `gh`
  sign-in (`EngineHost/EngineSettings.swift`). The workflow points `skills_dir` at the bundled agent
  skills (`engine/skills`); the engine copies them into each card's folder (`.claude/skills`,
  `.forge/skills`, git-excluded) before the agent starts. git asks `gh` for the GitHub sign-in through
  `GIT_CONFIG_*` in that environment; nothing is stored on disk.

## Workspaces and tracker connections

- A workspace (`Core/Workspaces.swift`, in `store.json` version 3) groups the tracker connections, projects, repos and
  intelligence providers Forge runs together. Sign-ins belong to the Mac: tracker connections, GitHub accounts and
  intelligence provider accounts are listed once and any workspace can use them. `setup.json` is the working copy of
  the project on screen; every other project keeps its answers in `ProjectRecord.choices`.
- Everything runs at once (`UI/AppModel+Fleet.swift`): Start and Stop are per workspace (`Workspace.running`, remembered
  so Forge reopens with the same workspaces started), and every set-up project of a running workspace runs in its own
  engine (`EngineHost.forProject`), with its own folder `projects/<id>/` (`ProjectRecord.folder`: workflow file,
  `forge.sqlite`, card folders; the engine reads it from `FORGE_ENGINE_HOME`), logs in `Logs/Forge/projects/<id>/`,
  port and launch token. Only the project carried over from 0.2.17 keeps Forge's own folder, so its cards and history
  stay put. Each project has its own `BoardLink`; the one on screen also feeds `model.engine`. Looking at a workspace
  never stops another. Quitting drains every engine (`AppModel.stopAllEngines`).
- One ceiling on agents across every engine on the Mac (`SetupStore.agentCeiling`, default 6, Workflow Studio): each
  engine publishes its agents in flight to `slots/` and adds up the others' before dispatching
  (`engine/src/orchestrator/shared-slots.ts`, env `FORGE_AGENT_CEILING`, `FORGE_AGENT_SLOTS_DIR`).
- "All workspaces" (`UI/AllWorkspacesScreen.swift`) shows every running workspace's cards in one Orchestrator, with a
  Workspace column; a row opens that project.
- Roles (`Core/Roles.swift`): Plans, Builds, Reviews and Tests can each have their own provider account and model
  (`SetupChoices.roles`); stages no role takes use the project's own. The workflow file lists them under
  `agent.roles` and each role's account reaches the engine under `FORGE_ROLE_<n>_`, so two accounts never share a
  variable; the engine picks the agent by the card's stage and a card moving to another role's stage ends its run so
  that role's agent picks it up (`engine/src/agent/roles.ts`).
- A tracker connection (`TrackerRecord`) is one sign-in; there can be several of each kind. A new one has the id
  `<kind>-<id>` and its own Keychain item `tracker-<kind>-<id>`; one carried over keeps the item its kind used before
  (`linear-key`, `basecamp-login`, `github-tracker-login`). A project names its connection (`SetupChoices.connectionID`,
  nil = the carried-over one) and its record id is `<connection>:<project>`. The engine's token commands carry the
  item (`Forge --basecamp-token --item <item>`), and `--item` accepts only tracker items (`Checks.trackerItemAllowed`).
- Switching workspace or project (`SetupStore.switchTo`, `AppModel.open`) only changes the view: it keeps the shown
  project's answers in its record (`ProjectRecord.choices`) and Workflow Studio's in its workspace, then loads the
  other project's answers, or a fresh start on its tracker for a project ticked but not set up (`ProjectRef`). What
  belongs to the Mac comes along: who signs commits (fresh starts only) and every repo's Harness engineering record.
  An engine whose workspace isn't running quits when its project leaves the screen.
- GitHub accounts: the ones the GitHub CLI has (read live) plus the ones Forge signs in to itself with GitHub's
  device sign-in (`GitHubAccountRecord`, Keychain `github-account-<login>`); `GitHub.env()` uses the latter's token.
- The first open of a 0.2.17 store (`SetupStore.upgrade`) makes one workspace of everything, turns every tracker
  sign-in already in the Keychain into a connection under its old item, and keeps `store.v1.json`. `Forge
  --workspaces-check` runs it on a copy of Forge's folder (`FORGE_HOME`).
- The design: [design/workspaces-design.md](design/workspaces-design.md).

## Intelligence providers and their accounts

- `Core/Accounts.swift` keeps `store.json`: trackers, projects (each on one tracker and mapped to one repo) and
  intelligence provider accounts, joined by ids. Each project has one provider (Claude Code, Codex, Kimi, or
  OpenRouter, which is Claude Code on an OpenRouter key) and one account. `setup.json` (`SetupChoices`) stays the
  working copy of the project Forge runs; `AppModel.save` writes it back (`sync`) and, when setup moves to a
  project Forge already knows, brings back its repo and account (`adopt`).
- An account (`AIAccount`) is a browser sign-in or an API key. Its secret is one Keychain item of its own
  (`ai-account-<id>`); a browser account also has its own login folder in `accounts/<id>`, which the sign-in
  runs in (`CLAUDE_CONFIG_DIR` for `claude setup-token`, `CODEX_HOME` for `codex login` and Codex's agents), so
  the person's own logins and other accounts are never touched. `WorkerCheck.env(account, secret:)` is the one
  place that turns an account into the agents' environment; a Claude account without its sign-in points at its
  empty folder and fails as signed out, never falling back to the Mac's own Claude Code login.
- 0.2.16's settings carry over on first launch (`SetupStore.migrate`): each item already in the Keychain
  (`claude-code-token`, `anthropic-key`, `openai-key`, `kimi-key`) becomes an account under its old name, and the
  one in use is chosen. Carried-over accounts have no folder and run exactly as before until they sign in again.
- Clearing an account (`EngineHost/AccountClear.swift`) removes its Keychain item and its folder (only inside
  `accounts/`) and unassigns it from every project.

## GitHub and signing

- GitHub: the `gh` sign-in already on the Mac. If `gh` holds several accounts, setup picks one and Forge
  passes that account's sign-in to `gh`, git and the agents as `GH_TOKEN` in their environment, without
  switching `gh`'s active account. If `gh` isn't signed in, setup runs GitHub's device sign-in and shows
  the code in the window.
- Who signs (setup 3): a key Forge makes (SSH ed25519; private half only in the Keychain, handed to the
  Mac's ssh-agent before the engine starts; public half in `signing/`; registered on GitHub after a yes),
  the person's own GPG key, or unsigned after they tick "I understand".
- The identity reaches each card folder's local git config through `FORGE_GIT_*` (engine
  `workspace/git-identity.ts`). Before a card starts the engine makes a signed test commit in a scratch
  repo; if it doesn't come out signed (or unsigned wasn't chosen), the card doesn't start.

## Local state

`~/Library/Application Support/Forge/`: the workflow file (source of truth for the pipeline), `setup.json` and
`store.json` (setup's answers; never a secret), `accounts/` (each browser account's own login folder), one
SQLite file written only by the engine (running/stopped, runs, usage), `workspaces/` (one folder per
card), `projects/<id>/` (the same three for each project after the first: its own engine's folder) and `slots/` (each
running engine's agents in flight, for the Mac-wide ceiling). Logs in `~/Library/Logs/Forge/`. Secrets in the Keychain, never on disk.

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
| 1 | `tracker/` | Linear (and an in-memory board for tests) | observability |
| 1 | `mcp/` | Linear tools for agents | tracker, observability, config |
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
- The person ticks guardrails; Forge makes one Linear card in Todo whose description lists them and
  names the `harness-engineering` skill. The pipeline does the rest: a pull request that lands in Human
  Review. "Skip for now" moves on; the Workflow button brings the screen back.
- Kimi can't do the read yet (it says so on the screen).

## The board

- The engine reads every card in the board's columns (`board.columns`) from Linear on start, on every
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

`~/Library/Application Support/Forge/`: the workflow file (source of truth for the pipeline), one
SQLite file written only by the engine (running/stopped, runs, usage), `workspaces/` (one folder per
card). Logs in `~/Library/Logs/Forge/`. Secrets in the Keychain, never on disk.

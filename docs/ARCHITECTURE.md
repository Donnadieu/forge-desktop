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
| `Sources/EngineHost/` | the only code that starts programs: the engine (`EngineHost`, single-flight start, watch, drain), the person's PATH (`ToolPath`), `--engine-check` | Core |

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

## Local state

`~/Library/Application Support/Forge/`: the workflow file (source of truth for the pipeline), one
SQLite file written only by the engine (running/stopped, runs, usage), `workspaces/` (one folder per
card). Logs in `~/Library/Logs/Forge/`. Secrets in the Keychain, never on disk.

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

Dependencies point one way: **App -> UI -> Core**. Each area is a folder; a new area is a new folder.

| Folder | What lives there | May use |
|---|---|---|
| `Sources/App/` | the entry point, the scene, check modes (`--selftest`, `--window-check`) | UI, Core |
| `Sources/UI/` | SwiftUI views | Core |
| `Sources/Core/` | plain logic and facts every layer reads; Foundation only | nothing above it |
| `Sources/EngineHost/` (step 3) | the only code that starts programs: the engine, and checks of the person's tools | Core |

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
| 2 | `worker/` | one card's agent run, turns, the lead waiting for its helpers | agent, tracker, workspace, telemetry |
| 3 | `orchestrator/` | the board loop: poll, claim, dispatch, retry, reconcile | agent, tracker, workspace, worker, observability, telemetry, config |
| 3 | `server/` | the local API the app talks to (127.0.0.1 + launch token) | orchestrator, observability, config |
| 4 | `src/index.ts` | wires it together | anything |

**Never in the engine** (the test fails if any appears): `db/`, `services/`, `pipeline/`, `auth/`,
`clients/`, `smith/`, `cli/`, `ui/`. Accounts, billing, hosting and the factory chat stay in Forge.

The full import list (which Forge files come over) is in the plan,
[exec-plans/active/scaffold.md](exec-plans/active/scaffold.md#engine-import-list).

## Local state

`~/Library/Application Support/Forge/`: the workflow file (source of truth for the pipeline), one
SQLite file written only by the engine (running/stopped, runs, usage), `workspaces/` (one folder per
card). Logs in `~/Library/Logs/Forge/`. Secrets in the Keychain, never on disk.

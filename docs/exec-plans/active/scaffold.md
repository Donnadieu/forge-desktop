# Forge Desktop: build order

Source of truth for the decisions: Omar's locked plan (Nov 3, 2026). This file tracks the work.

## Steps
1. **Repo and guardrails:** the repo, the harness, CI, branch protection, an empty window titled "Forge". No engine code.
2. **Engine import:** copy the folders below at one pinned Forge commit, strip the old project name, record provenance, Biome and boundary tests green, the macOS process table.
3. **Engine host:** bundle Node, start/watch/stop the engine from Swift (`Sources/EngineHost/`), local API with the launch token, WebSocket state.
4. **Lead waits for helpers** in the worker, with a test that nothing is killed mid-helper.
5. **Setup 1 and 2:** Linear key into the Keychain, project picker, missing statuses created on a yes.
6. **Setup 3 and 4:** GitHub sign-in, the signing choice, repo picker with the push check.
7. **Setup 5:** who does the work, checked with one real call.
8. **The board:** live columns, the plain line per card, usage, Start and Stop, card detail.
9. **Agent skills** (triage, commit, push, pull, simplify, code-review, code-review-nuclear, code-review-fix, qa-plan-forge, land, linear) bundled and copied into each card's folder.
10. **End to end** on a real Linear test project: a card goes from Todo to a merged PR with no terminal.
11. **Signed, notarized release** and the updater.

## Engine import list

| Forge `src/` folder | Comes over | Left behind |
|---|---|---|
| `config/` | schema, loader, watcher, resolver, env-validator, env (local subset), providers, provider-table, model-id, custom-base-url, boolean-token | smith-*, custom-workflows (always on) |
| `observability/` | logger, metrics, secret redaction and scan, types | the terminal dashboard |
| `process/` | process-tree, run-tree, procfs, plus a macOS process table | |
| `agent/` | types, index, compat, claude (+ env, usage), codex (+ protocol, sandbox), mcp-bridge, kimi (+ tree, usage), child-env, run-once, abortable-wait | privilege-drop, hermes |
| `tracker/` | types, index, memory, linear and its claim/errors/normalize/paginate/progress/reads/writes | Basecamp (later) |
| `workspace/` | manager, cleanup, copy-assets, mcp-config, git-identity, lock, orphan-reaper, inode-pressure | ssh, worker-ownership |
| `worker/` | runner, issue-state-checker, usage, prompt-renderer | |
| `orchestrator/` | the board loop (orchestrator, types, snapshot, dispatcher, dispatch-issue, refetch-dispatch, reconciler, worker-outcomes, session-guard, retry-queue, claim-gate, workpad-parser, workspace-lock-gate, workspace GC and sweeps, cost-ceiling, cli-callbacks) | deploy, smith, QA-bound, known-issues, factory build reports |
| `server/` | router, state-json, orchestrator-controls, http-utils | auth, CORS, OIDC, every hosted route, the web page |
| `mcp/` | linear-graphql-server, config, builders | forge-pipeline |
| `telemetry/` | types | |
| not at all | | db, services, pipeline, auth, clients, smith, cli, ui, the Python factory, Docker/Fly |

## Progress
- [x] 1. Repo and guardrails
- [x] 2. Engine import (Forge 05deefb0a, 94 files, Forge's unit tests green, macOS process table)
- [ ] 3. Engine host
- [ ] 4. Lead waits for helpers
- [ ] 5. Setup 1 and 2
- [ ] 6. Setup 3 and 4
- [ ] 7. Setup 5
- [ ] 8. The board
- [ ] 9. Agent skills
- [ ] 10. End to end
- [ ] 11. Signed release

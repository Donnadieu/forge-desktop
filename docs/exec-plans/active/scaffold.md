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
9. **Agent skills** (triage, commit, push, pull, simplify, code-review, code-review-nuclear, code-review-fix, qa-plan, land, linear) bundled and copied into each card's folder.
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
- [x] 3. Engine host (bundled Node 22.23.4, `EngineHost`, local API + live WebSocket, `--engine-check` in preflight)
- [x] 4. Lead waits for helpers (`worker/helper-wait.ts`; `test/unit/worker/lead-waits-for-helpers.test.ts` fails on the old runner)
- [x] 5. Setup 1 and 2 (Linear key into the Keychain, team and project pickers, missing columns created after a yes)
- [x] 6. Setup 3 and 4 (gh account, device sign-in, the three signing choices with a test signature, repo picker with the push check; the engine checks signing before every card)
- [x] 7. Setup 5 (Claude Code, Codex, Kimi or an Anthropic API key; one real call whose answer is read, not the exit code; keys into the Keychain)
- [x] 8. The board (live columns, one plain line per card, the lead's helpers, usage windows, Start and Stop, card detail with the workpad)
- [x] 9. Agent skills (eleven skills bundled in `engine/skills`, copied into each card's folder where Claude Code finds them, kept out of git)
- [ ] 10. End to end
- [x] 11. Signed release (Developer ID + hardened runtime, notarized and stapled, `Forge.zip`/`Forge.dmg`, in-app updater from the repo's releases; see docs/RELEASING.md)
- [x] 12. Setup 6, "Get your repo ready for agents": an agent reads the whole repo read-only (`repo-assessment` skill) and proposes guardrails; the person picks; one card runs the `harness-engineering` skill through the pipeline (asked for by Omar on Nov 3)
- [x] 13. Basecamp as a second tracker (Nov 4): setup 1 picks Linear or Basecamp (device sign-in, tokens in the Keychain), setup 2 picks the project and card table and adds missing columns after a yes; the engine reads and moves Basecamp cards (Forge `7f02afe2a` tracker, Backlog moves included) and agents get a `basecamp_api` tool. Forge has no other tracker: GitHub Issues and Jira are names in its config schema only.
- [x] 14. GitHub Issues as a third tracker (Nov 5): built new behind the same tracker interface. A GitHub project's Status field gives the columns; setup 1 signs in with GitHub's device sign-in (token in the Keychain), setup 2 picks the project and the repo for new issues, adds missing Status options after a yes and asks to turn off GitHub's Status automations; the engine reads, claims, moves and comments on issues (Backlog moves included) and agents get a `github_graphql` tool. Jira is postponed.
- [x] 15. Several accounts per intelligence provider (Nov 5): Claude Code, Codex, Kimi and OpenRouter (Claude Code on an OpenRouter key) each keep any number of browser sign-ins and API keys; setup 5 adds, switches and clears them. `store.json` relates trackers, projects (one repo each) and the account each project's provider uses, carried over from 0.2.16's single sign-in. Settings follows tracker → project and repo → intelligence provider and account.
- [x] 16. Workspaces, step 1 (Nov 5): several workspaces with a switcher in the top bar; several connections of each tracker kind; a project list per workspace (ticked under each connection); Forge's own GitHub accounts beside the GitHub CLI's; Settings per workspace with each project's repo and Harness engineering per repo. One project runs at a time. Next: every project running at once (one engine each), then roles per stage. Design: docs/design/workspaces-design.md.
- [x] 17. Roles move to Workflow Studio (Nov 5, Omar picked Direction A): who works each stage (provider, account and model) is picked on that stage's own row; setup 5 keeps providers, accounts and the default model. Same stored field (`SetupChoices.roles`), so roles saved before carry over untouched.
- [x] 18. What others see, and editing the workflow file (Nov 9, Omar picked Direction A): "Keep Forge invisible" per workspace in Workflow Studio (no `forge` label, no Forge words or folder paths in card notes, a branch prefix, commits only as the person, guarded at `git push`, `gh` writes and tracker writes), its own pull request label and branch prefix; "Edit workflow file" shows the real WORKFLOW.md, checked by the engine before it saves, Studio and Settings rewriting only their own settings, earlier versions kept to put back. The card note is "Workpad" for everyone. Design: docs/design/what-others-see.md.

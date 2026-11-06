# Engine provenance

Every file under `src/` came from Forge (`Forge-Factory-AI/forge`) at one commit, or is new here.
The lint rule `engine-provenance` fails on a file without a row. How to pull: [README.md](README.md).

- **Pull 1:** Forge `05deefb0a43adb85b92f57c62ee8acb9a06c1a7e` (Nov 2, 2026). Copied Nov 3, 2026.
- **Tests:** `test/unit/**` and `test/support/**` came from Forge's `test/` at the same commit.
  Tests for code left behind were dropped (the container privilege drop, the hermes runner, the
  factory QA bound and build completion, boot scripts). Two skills tests wait for step 9
  (the agent skills). `test/unit/process/ps-table.test.ts`, `test/unit/process/leftovers.test.ts` and
  `test/unit/workspace/leftover-sweep.test.ts` are new.
- **The lead's instructions:** `workflow/lead.md` is the body of Forge's `examples/WORKFLOW.md` at the
  same commit. The QA step's two hosted-platform passages were made general (observe the app's UI or a
  command, run the project the way its README says). The app writes the settings block above it.
  AI Review is code-review-nuclear, then code-review-fix on that review (looped), then
  code-comment-style; every skill runs by name with no instructions that override it.
- **Agent skills:** `skills/` holds eleven of Forge's `.agents/skills` at the same commit: triage,
  commit, push, pull, simplify, code-review (with code-review-nuclear, code-review-fix and the review
  helpers it calls), qa-plan-forge, land, linear. Changed: qa-plan-forge and its template rewritten for
  any repo (Forge's own stack removed); push lost two Forge-only sections; linear's lifecycle defers to
  the workflow (one `## Forge Workpad` comment, no summary comments); "GPG-signed" became "signed";
  three dead pointers to an `EDGE_CASE_TEMPLATE.md` Forge never had were removed.
  Forge's worker variant of linear (merge without Human Review) is not shipped.
  `skills/code-comment-style` is new here: the owner's own skill, copied verbatim.
- **Repo readiness:** `skills/harness-engineering` is Forge's `.agents/skills/harness-engineering` at the
  same commit; its "Running it" section (Forge's internal `pnpm harden` tool) became the steps a card
  follows (formatter, custom rules with WHY and FIX, ratchet, three enforcement points, canary proof).
  `skills/repo-assessment` is new: a read-only assessment that proposes guardrails.
- **Basecamp (Nov 4, 2026):** the eight `src/tracker/basecamp*.ts` files and their three tests
  (`basecamp.test.ts`, `basecamp-labels.test.ts`, `basecamp-token-provider.test.ts`) came from Forge
  `7f02afe2a` (includes the Backlog to Triage and ready to Todo moves). `workflow/basecamp.md` is new:
  the app puts it in front of the lead's instructions on a Basecamp board, with the board's ids filled in
  (how to read the Linear steps on Basecamp: the `basecamp_api` tool, HTML comments, `Label:` lines,
  the move endpoint). Bundled skills stay tracker-neutral, so it is not a skill.
- **GitHub Issues (Nov 5, 2026):** new here; Forge names `github` in its config schema only. The three
  `src/**/github*.ts` files, `workflow/github.md` (the GitHub section in front of the lead's instructions) and
  `test/unit/tracker/github.test.ts` with its recorded answers in `test/fixtures/github/` (recorded live from
  a private throwaway repo and project).

| Our path | Forge commit | Forge path | What changed |
|---|---|---|---|
| src/agent/abortable-wait.ts | 05deefb0a43a | src/agent/abortable-wait.ts | unchanged |
| src/agent/child-env.ts | 05deefb0a43a | src/agent/child-env.ts | unchanged |
| src/agent/claude-env.ts | 05deefb0a43a | src/agent/claude-env.ts | unchanged |
| src/agent/claude-usage.ts | 05deefb0a43a | src/agent/claude-usage.ts | unchanged |
| src/agent/claude.ts | 05deefb0a43a | src/agent/claude.ts | dropped the container privilege drop; follows helpers (`trackHelper`) and keeps reading past a turn end while they run (`waiting_for_helpers`); reads Claude Code's `rate_limit_event` (`mapRateLimit`) |
| src/agent/codex-protocol.ts | 05deefb0a43a | src/agent/codex-protocol.ts | comments reworded (no old project name); a `turn/completed` whose turn failed (usage limit, quota) is a failed turn with its reason |
| src/agent/codex-sandbox.ts | 05deefb0a43a | src/agent/codex-sandbox.ts | unchanged |
| src/agent/codex.ts | 05deefb0a43a | src/agent/codex.ts | dropped the container privilege drop; comments reworded (no old project name); no OPENAI_API_KEY required (Codex can use its own sign-in) |
| src/agent/compat.ts | 05deefb0a43a | src/agent/compat.ts | unchanged |
| src/agent/index.ts | 05deefb0a43a | src/agent/index.ts | dropped the hermes runner and the container privilege drop |
| src/agent/kimi-tree.ts | 05deefb0a43a | src/agent/kimi-tree.ts | unchanged |
| src/agent/kimi-usage.ts | 05deefb0a43a | src/agent/kimi-usage.ts | unchanged |
| src/agent/kimi.ts | 05deefb0a43a | src/agent/kimi.ts | dropped the container privilege drop and lent-home usage read; a turn with no events says what kimi printed (its quota or rate-limit error) |
| src/agent/mcp-bridge.ts | 05deefb0a43a | src/agent/mcp-bridge.ts | comment reworded (no old project name); fills `${VAR}` placeholders from the agent's env (`expandEnv`) |
| src/agent/run-once.ts | 05deefb0a43a | src/agent/run-once.ts | unchanged |
| src/agent/types.ts | 05deefb0a43a | src/agent/types.ts | `helper` and `waiting_for_helpers` events; `rate_limit` event |
| src/config/boolean-token.ts | 05deefb0a43a | src/config/boolean-token.ts | unchanged |
| src/config/custom-base-url.ts | 05deefb0a43a | src/config/custom-base-url.ts | unchanged |
| src/config/env-validator.ts | 05deefb0a43a | src/config/env-validator.ts | a Basecamp board needs the app's token command or a fixed key; a GitHub board needs the app's GitHub token command and `status_field_id` |
| src/config/env.ts | 05deefb0a43a | src/config/env.ts | `FORGE_BASECAMP_TOKEN_COMMAND` and `FORGE_GITHUB_TOKEN_COMMAND` (the app's token commands) |
| src/config/index.ts | 05deefb0a43a | src/config/index.ts | dropped custom-workflows exports (always on in the app) |
| src/config/loader.ts | 05deefb0a43a | src/config/loader.ts | unchanged |
| src/config/model-id.ts | 05deefb0a43a | src/config/model-id.ts | unchanged |
| src/config/provider-table.ts | 05deefb0a43a | src/config/provider-table.ts | unchanged |
| src/config/providers.ts | 05deefb0a43a | src/config/providers.ts | unchanged |
| src/config/resolver.ts | 05deefb0a43a | src/config/resolver.ts | unchanged |
| src/config/schema.ts | 05deefb0a43a | src/config/schema.ts | `agent.helper_wait_ms` (default 60 min); `board.columns`; `tracker.promote` from Forge 7f02afe2a; `tracker.status_field_id` (GitHub); `agent.roles` (Forge Desktop: a provider and model per stage) |
| src/config/watcher.ts | 05deefb0a43a | src/config/watcher.ts | unchanged |
| src/mcp/builders.ts | 05deefb0a43a | src/mcp/builders.ts | passes the Basecamp board's account through |
| src/mcp/config.ts | 05deefb0a43a | src/mcp/config.ts | only the Linear tools, or the Basecamp tool (`basecamp-api-server.ts`, account and the app's token command, no token), or the GitHub tool (`github-graphql-server.ts`, the app's token command, no token); run by the engine's own Node; the Linear key is a `${LINEAR_API_KEY}` placeholder, never written |
| src/mcp/handler-log.ts | 05deefb0a43a | src/mcp/forge-pipeline/handler-log.ts | moved from mcp/forge-pipeline/handler-log.ts |
| src/mcp/linear-graphql-server.ts | 05deefb0a43a | src/mcp/linear-graphql-server.ts | imports handler-log from its new path |
| src/observability/index.ts | 05deefb0a43a | src/observability/index.ts | dropped the terminal dashboard export |
| src/observability/logger.ts | 05deefb0a43a | src/observability/logger.ts | unchanged |
| src/observability/metrics.ts | 05deefb0a43a | src/observability/metrics.ts | unchanged |
| src/observability/secret-env-names.ts | 05deefb0a43a | src/observability/secret-env-names.ts | unchanged |
| src/observability/secret-redact.ts | 05deefb0a43a | src/observability/secret-redact.ts | unchanged |
| src/observability/secret-scan.ts | 05deefb0a43a | src/observability/secret-scan.ts | unchanged |
| src/observability/secret-spec.json | 05deefb0a43a | src/observability/secret-spec.json | unchanged |
| src/observability/secret-spec.ts | 05deefb0a43a | src/observability/secret-spec.ts | unchanged |
| src/observability/types.ts | 05deefb0a43a | src/observability/types.ts | activity, helpers, recent lines; usage limits (`limits`, `waitingForLimit`) |
| src/orchestrator/backlog-promotion.ts | 7f02afe2a | src/orchestrator/backlog-promotion.ts | comments say "workflow file" and drop the other tracker's marker note; its tests came with it |
| src/orchestrator/claim-gate.ts | 05deefb0a43a | src/orchestrator/claim-gate.ts | unchanged |
| src/orchestrator/cost-ceiling.ts | 05deefb0a43a | src/orchestrator/cost-ceiling.ts | unchanged |
| src/orchestrator/dispatch-issue.ts | 05deefb0a43a | src/orchestrator/dispatch-issue.ts | dropped QA bound counters; passes `helperWaitMs`; starts each card's activity line; asks the worker to end after its turn once stopped; picks the agent for the card's stage (`agentForState`) and passes `roleOf` to the worker; remembers a refused claim (`noteClaimRefused`); records whose account the run uses (`limitKey`) |
| src/orchestrator/dispatcher.ts | 05deefb0a43a | src/orchestrator/dispatcher.ts | comments reworded (no old project name); `effectiveAgentLimit`; cards whose claim was refused rank last for 10 minutes (`claimRefused`); a card waiting for a usage limit holds no slot; cards of a limited account aren't started (`limited`) |
| src/orchestrator/index.ts | 05deefb0a43a | src/orchestrator/index.ts | dropped deployment, hosted-app and stamped-repo exports |
| src/orchestrator/orchestrator.ts | 05deefb0a43a | src/orchestrator/orchestrator.ts | dropped factory build completion, QA bound and deployment checks; the Backlog sweep (`maybePromoteBacklog`) from Forge 7f02afe2a; dispatch counts against `effectiveAgentLimit` (the Mac-wide ceiling); the poll loop runs the leftover sweep (`workspace/leftover-sweep.ts`); cards of an account at a usage limit aren't started (`orchestrator/usage-limits.ts`) |
| src/orchestrator/reconciler.ts | 05deefb0a43a | src/orchestrator/reconciler.ts | unchanged |
| src/orchestrator/refetch-dispatch.ts | 05deefb0a43a | src/orchestrator/refetch-dispatch.ts | comment reworded (no old project name); re-dispatch counts against `effectiveAgentLimit`; releases only the reservation it owns (a usage-limit wait keeps the attempt number) |
| src/orchestrator/retry-queue.ts | 05deefb0a43a | src/orchestrator/retry-queue.ts | unchanged |
| src/orchestrator/session-guard.ts | 05deefb0a43a | src/orchestrator/session-guard.ts | unchanged |
| src/orchestrator/snapshot.ts | 05deefb0a43a | src/orchestrator/snapshot.ts | activity, helpers, recent lines, usage windows; usage limits |
| src/orchestrator/turn-telemetry.ts | 05deefb0a43a | src/orchestrator/turn-telemetry.ts | the plain activity line, helpers and usage windows from agent events; passes `shouldStop`; a run that gets going ends its account's usage limit |
| src/orchestrator/types.ts | 05deefb0a43a | src/orchestrator/types.ts | dropped factory build report, QA bound and known-issues fields; `helperWaitMs`; `activity`, `helpers`, `recent` on running cards; `rateLimits`; `backlogPromotion` from Forge 7f02afe2a; `agentLimit`, `agentForState`, `roleOf` (Forge Desktop: the Mac-wide ceiling and roles); `claimRefused`; `usageLimits`, `limitKey` |
| src/orchestrator/worker-outcomes.ts | 05deefb0a43a | src/orchestrator/worker-outcomes.ts | a failed run that says why (a lapsed sign-in) goes on the retry queue with its reason, for every agent; a usage limit waits for its reset with the same attempt (never retried as a failure, never given up) |
| src/orchestrator/workpad-parser.ts | 05deefb0a43a | src/orchestrator/workpad-parser.ts | unchanged |
| src/orchestrator/workspace-gc.ts | 05deefb0a43a | src/orchestrator/workspace-gc.ts | unchanged |
| src/orchestrator/workspace-lock-gate.ts | 05deefb0a43a | src/orchestrator/workspace-lock-gate.ts | unchanged |
| src/orchestrator/workspace-periodic-sweep.ts | 05deefb0a43a | src/orchestrator/workspace-periodic-sweep.ts | unchanged |
| src/orchestrator/workspace-startup-sweep.ts | 05deefb0a43a | src/orchestrator/workspace-startup-sweep.ts | unchanged |
| src/process/process-tree.ts | 05deefb0a43a | src/process/process-tree.ts | unchanged |
| src/process/procfs.ts | 05deefb0a43a | src/process/procfs.ts | falls back to the macOS process table (ps-table.ts) where /proc is missing |
| src/process/ps-table.ts | new | | macOS process table (Forge reads Linux /proc only) |
| src/process/leftovers.ts | new | | finds processes left running in card folders by cwd (`lsof`): detached, no terminal; stops them |
| src/process/run-tree.ts | 05deefb0a43a | src/process/run-tree.ts | unchanged |
| src/server/http-utils.ts | 05deefb0a43a | src/server/http-utils.ts | unchanged |
| src/server/index.ts | 05deefb0a43a | src/server/index.ts | exports the local pieces only (the hosted router stays in Forge) |
| src/server/orchestrator-controls.ts | 05deefb0a43a | src/server/orchestrator-controls.ts | IntendedStateRepo from ./types (local store, no database); Stop answers at once and drains in the background, intent saved as stopped right away |
| src/server/state-json.ts | 05deefb0a43a | src/server/state-json.ts | dropped the hosted analytics transformer; activity, helpers, recent lines; usage limits |
| src/server/types.ts | 05deefb0a43a | src/server/types.ts | kept only the status types; IntendedStateRepo defined here (local store, no database) |
| src/telemetry/infer-issue-type.ts | 05deefb0a43a | src/telemetry/infer-issue-type.ts | unchanged |
| src/telemetry/types.ts | 05deefb0a43a | src/telemetry/types.ts | TicketStatus written out instead of read from the database schema |
| src/tracker/index.ts | 7f02afe2a | src/tracker/index.ts | exports `GitHubTracker` |
| src/tracker/basecamp.ts | 7f02afe2a | src/tracker/basecamp.ts | `fetchBoard` (basecamp-board.ts); user agent names Forge Desktop; exports `createCommandTokenFn` |
| src/tracker/basecamp-claim.ts | 7f02afe2a | src/tracker/basecamp-claim.ts | unchanged |
| src/tracker/basecamp-errors.ts | 7f02afe2a | src/tracker/basecamp-errors.ts | unchanged |
| src/tracker/basecamp-normalize.ts | 7f02afe2a | src/tracker/basecamp-normalize.ts | a card's state is the canonical column name whatever its case; `Label:` lines are found in Basecamp's HTML (a block's end is a new line) |
| src/tracker/basecamp-paginate.ts | 7f02afe2a | src/tracker/basecamp-paginate.ts | unchanged |
| src/tracker/basecamp-reads.ts | 7f02afe2a | src/tracker/basecamp-reads.ts | unchanged |
| src/tracker/basecamp-token-provider.ts | 7f02afe2a | src/tracker/basecamp-token-provider.ts | `createCommandTokenFn`: the token comes from the app's `--basecamp-token`; `service` names whose sign-in lapsed (GitHub reuses the provider) |
| src/tracker/basecamp-writes.ts | 7f02afe2a | src/tracker/basecamp-writes.ts | unchanged |
| src/tracker/linear-claim.ts | 05deefb0a43a | src/tracker/linear-claim.ts | unchanged |
| src/tracker/linear-errors.ts | 05deefb0a43a | src/tracker/linear-errors.ts | unchanged |
| src/tracker/linear-normalize.ts | 05deefb0a43a | src/tracker/linear-normalize.ts | unchanged |
| src/tracker/linear-paginate.ts | 05deefb0a43a | src/tracker/linear-paginate.ts | unchanged |
| src/tracker/linear-progress.ts | 05deefb0a43a | src/tracker/linear-progress.ts | unchanged |
| src/tracker/linear-reads.ts | 05deefb0a43a | src/tracker/linear-reads.ts | unchanged |
| src/tracker/linear-writes.ts | 05deefb0a43a | src/tracker/linear-writes.ts | unchanged |
| src/tracker/linear.ts | 05deefb0a43a | src/tracker/linear.ts | comment reworded (no old project name); `fetchBoard` |
| src/tracker/memory.ts | 05deefb0a43a | src/tracker/memory.ts | unchanged |
| src/tracker/types.ts | 05deefb0a43a | src/tracker/types.ts | `BoardCard` (with labels and unfinished blockers), optional `fetchBoard` |
| src/worker/issue-state-checker.ts | 05deefb0a43a | src/worker/issue-state-checker.ts | returns `handoff` when the card moved to another role's stage |
| src/worker/prompt-renderer.ts | 05deefb0a43a | src/worker/prompt-renderer.ts | unchanged |
| src/worker/runner.ts | 05deefb0a43a | src/worker/runner.ts | the lead waits for its helpers: timeouts pause, `helperWaitMs` limit, plain note on the card; a failed turn keeps the agent's reason as the run's `error`; `shouldStop` ends the run after the current turn; a card that moves to another role's stage ends the run (`handoff`) so that role's agent picks it up |
| src/worker/usage.ts | 05deefb0a43a | src/worker/usage.ts | unchanged |
| src/workspace/cleanup.ts | 05deefb0a43a | src/workspace/cleanup.ts | unchanged |
| src/workspace/copy-assets.ts | 05deefb0a43a | src/workspace/copy-assets.ts | runs the signing check after writing the identity; mirrors nested skills (code-review-nuclear, code-review-fix) to the top of `.claude/skills/`; turns off Claude Code's commit/PR attribution in the card's local settings |
| src/workspace/git-identity.ts | 05deefb0a43a | src/workspace/git-identity.ts | SSH signing (`FORGE_GIT_SIGNING_FORMAT=ssh`); `verifyWorkspaceSigning` (a test signature before a card starts; unsigned only when chosen) |
| src/workspace/inode-pressure.ts | 05deefb0a43a | src/workspace/inode-pressure.ts | unchanged |
| src/workspace/lock.ts | 05deefb0a43a | src/workspace/lock.ts | stale-lock reclaim takes turns through a `.reclaiming` gate (fixes a race where two acquirers both held the lock) |
| src/workspace/manager.ts | 05deefb0a43a | src/workspace/manager.ts | dropped remote (SSH) workspaces and the container ownership hand-off; `acquireLock` stops a card's leftover processes after taking the lock and before releasing it |
| src/workspace/leftover-sweep.ts | new | | stops dev servers left running in card workspaces: at a run's start and end, and every 3 minutes for cards no live run holds |
| src/workspace/mcp-config.ts | 05deefb0a43a | src/workspace/mcp-config.ts | unchanged |
| src/workspace/orphan-reaper.ts | 05deefb0a43a | src/workspace/orphan-reaper.ts | unchanged |
| src/index.ts | new | | the engine as the app runs it (the tracker from `tracker-factory.ts`) (env in, ready line out, drain on SIGTERM); reads the board on start, every poll interval and on refresh; serves the workpad; moves a card for the person, then polls; turns on the Backlog sweep from `tracker.promote`; `FORGE_ENGINE_HOME` (one engine per project); roles (`agent/roles.ts`); the Mac-wide ceiling (`orchestrator/shared-slots.ts`); logs the leftover processes a run's lock stops |
| src/agent/usage-limit.ts | new | | reads a usage, spend or rate limit (and its reset time) from Claude Code, Codex, OpenRouter and Kimi failure texts |
| src/orchestrator/usage-limits.ts | new | | a card whose account hit a usage limit waits for the reset (no retry used, no slot held), then goes again |
| src/agent/roles.ts | new | | roles: each role's agent gets only its own account (`FORGE_ROLE_<n>_…`), and the router picks the agent by the card's stage |
| src/orchestrator/shared-slots.ts | new | | the ceiling on agents across every engine on the Mac: each engine publishes its count in a shared folder |
| src/server/local-api.ts | new | | the local API: 127.0.0.1, launch token, HTTP + live WebSocket; `GET /api/v1/cards/<id>/workpad`; `POST /api/v1/cards/<id>/move` (Start, Merge, Ask for changes); `POST /api/v1/stop` answers at once |
| src/server/engine-state.ts | new | | the one state object the app shows |
| src/store/local-store.ts | new | | the engine's SQLite file (Start/Stop intent, finished runs) |
| src/worker/helper-wait.ts | new | | the lead waits for its helpers (`HelperWatch`, the limit message) |
| src/orchestrator/activity.ts | new | | one plain line per card, the lead's helpers |
| src/orchestrator/board-reader.ts | new | | the board: every card in the columns, with live activity; the person's moves (Backlog to Todo, Human Review to Merging or Rework); names the tracker in its problems (Linear, Basecamp, GitHub); reads an HTML workpad |
| src/tracker/linear-board.ts | new | | the board's Linear read, with each card's pull request, labels and unfinished blockers |
| src/tracker/basecamp-board.ts | new | | the board's Basecamp read: every column, Backlog labels and pull requests from comments, kept per card until it changes |
| src/tracker/rich-text.ts | new | | Basecamp's HTML comments as the Markdown the window reads |
| src/tracker-factory.ts | new | | builds Linear, Basecamp or GitHub from the workflow file (adapted from Forge's `src/tracker-factory.ts` at 7f02afe2a: the token comes from the app) |
| src/mcp/basecamp-api-server.ts | new | | the agents' `basecamp_api` tool: one request per call, the app's short-lived token, paths kept inside the account |
| src/mcp/github-graphql-server.ts | new | | the agents' `github_graphql` tool: one GraphQL call each, the token from the app's `--github-token`, kept in memory |
| src/tracker/github.ts | new | | GitHub Issues on a GitHub project: Status field = column; reads, claims (assignees), moves (adds the issue to the project first), comments |
| src/tracker/github-queries.ts | new | | the GraphQL it sends, and how an issue becomes a card (labels, closing pull request, open blockers) |

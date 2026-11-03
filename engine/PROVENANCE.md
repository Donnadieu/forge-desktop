# Engine provenance

Every file under `src/` came from Forge (`Forge-Factory-AI/forge`) at one commit, or is new here.
The lint rule `engine-provenance` fails on a file without a row. How to pull: [README.md](README.md).

- **Pull 1:** Forge `05deefb0a43adb85b92f57c62ee8acb9a06c1a7e` (Nov 2, 2026). Copied Nov 3, 2026.
- **Tests:** `test/unit/**` and `test/support/**` came from Forge's `test/` at the same commit.
  Tests for code left behind were dropped (the container privilege drop, the hermes runner, the
  factory QA bound and build completion, boot scripts). Two skills tests wait for step 9
  (the agent skills). `test/unit/process/ps-table.test.ts` is new.
- **The lead's instructions:** `workflow/lead.md` is the body of Forge's `examples/WORKFLOW.md` at the
  same commit. The QA step's two hosted-platform passages were made general (observe the app's UI or a
  command, run the project the way its README says). The app writes the settings block above it.

| Our path | Forge commit | Forge path | What changed |
|---|---|---|---|
| src/agent/abortable-wait.ts | 05deefb0a43a | src/agent/abortable-wait.ts | unchanged |
| src/agent/child-env.ts | 05deefb0a43a | src/agent/child-env.ts | unchanged |
| src/agent/claude-env.ts | 05deefb0a43a | src/agent/claude-env.ts | unchanged |
| src/agent/claude-usage.ts | 05deefb0a43a | src/agent/claude-usage.ts | unchanged |
| src/agent/claude.ts | 05deefb0a43a | src/agent/claude.ts | dropped the container privilege drop; follows helpers (`trackHelper`) and keeps reading past a turn end while they run (`waiting_for_helpers`); reads Claude Code's `rate_limit_event` (`mapRateLimit`) |
| src/agent/codex-protocol.ts | 05deefb0a43a | src/agent/codex-protocol.ts | comments reworded (no old project name) |
| src/agent/codex-sandbox.ts | 05deefb0a43a | src/agent/codex-sandbox.ts | unchanged |
| src/agent/codex.ts | 05deefb0a43a | src/agent/codex.ts | dropped the container privilege drop; comments reworded (no old project name) |
| src/agent/compat.ts | 05deefb0a43a | src/agent/compat.ts | unchanged |
| src/agent/index.ts | 05deefb0a43a | src/agent/index.ts | dropped the hermes runner and the container privilege drop |
| src/agent/kimi-tree.ts | 05deefb0a43a | src/agent/kimi-tree.ts | unchanged |
| src/agent/kimi-usage.ts | 05deefb0a43a | src/agent/kimi-usage.ts | unchanged |
| src/agent/kimi.ts | 05deefb0a43a | src/agent/kimi.ts | dropped the container privilege drop and lent-home usage read |
| src/agent/mcp-bridge.ts | 05deefb0a43a | src/agent/mcp-bridge.ts | comment reworded (no old project name); fills `${VAR}` placeholders from the agent's env (`expandEnv`) |
| src/agent/run-once.ts | 05deefb0a43a | src/agent/run-once.ts | unchanged |
| src/agent/types.ts | 05deefb0a43a | src/agent/types.ts | `helper` and `waiting_for_helpers` events; `rate_limit` event |
| src/config/boolean-token.ts | 05deefb0a43a | src/config/boolean-token.ts | unchanged |
| src/config/custom-base-url.ts | 05deefb0a43a | src/config/custom-base-url.ts | unchanged |
| src/config/env-validator.ts | 05deefb0a43a | src/config/env-validator.ts | unchanged |
| src/config/env.ts | 05deefb0a43a | src/config/env.ts | unchanged |
| src/config/index.ts | 05deefb0a43a | src/config/index.ts | dropped custom-workflows exports (always on in the app) |
| src/config/loader.ts | 05deefb0a43a | src/config/loader.ts | unchanged |
| src/config/model-id.ts | 05deefb0a43a | src/config/model-id.ts | unchanged |
| src/config/provider-table.ts | 05deefb0a43a | src/config/provider-table.ts | unchanged |
| src/config/providers.ts | 05deefb0a43a | src/config/providers.ts | unchanged |
| src/config/resolver.ts | 05deefb0a43a | src/config/resolver.ts | unchanged |
| src/config/schema.ts | 05deefb0a43a | src/config/schema.ts | `agent.helper_wait_ms` (default 60 min); `board.columns` |
| src/config/watcher.ts | 05deefb0a43a | src/config/watcher.ts | unchanged |
| src/mcp/builders.ts | 05deefb0a43a | src/mcp/builders.ts | unchanged |
| src/mcp/config.ts | 05deefb0a43a | src/mcp/config.ts | only the Linear tools; run by the engine's own Node; the key is a `${LINEAR_API_KEY}` placeholder, never written |
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
| src/observability/types.ts | 05deefb0a43a | src/observability/types.ts | activity, helpers, recent lines |
| src/orchestrator/claim-gate.ts | 05deefb0a43a | src/orchestrator/claim-gate.ts | unchanged |
| src/orchestrator/cost-ceiling.ts | 05deefb0a43a | src/orchestrator/cost-ceiling.ts | unchanged |
| src/orchestrator/dispatch-issue.ts | 05deefb0a43a | src/orchestrator/dispatch-issue.ts | dropped QA bound counters; passes `helperWaitMs`; starts each card's activity line |
| src/orchestrator/dispatcher.ts | 05deefb0a43a | src/orchestrator/dispatcher.ts | comments reworded (no old project name) |
| src/orchestrator/index.ts | 05deefb0a43a | src/orchestrator/index.ts | dropped deployment, hosted-app and stamped-repo exports |
| src/orchestrator/orchestrator.ts | 05deefb0a43a | src/orchestrator/orchestrator.ts | dropped factory build completion, QA bound and deployment checks |
| src/orchestrator/reconciler.ts | 05deefb0a43a | src/orchestrator/reconciler.ts | unchanged |
| src/orchestrator/refetch-dispatch.ts | 05deefb0a43a | src/orchestrator/refetch-dispatch.ts | comment reworded (no old project name) |
| src/orchestrator/retry-queue.ts | 05deefb0a43a | src/orchestrator/retry-queue.ts | unchanged |
| src/orchestrator/session-guard.ts | 05deefb0a43a | src/orchestrator/session-guard.ts | unchanged |
| src/orchestrator/snapshot.ts | 05deefb0a43a | src/orchestrator/snapshot.ts | activity, helpers, recent lines, usage windows |
| src/orchestrator/turn-telemetry.ts | 05deefb0a43a | src/orchestrator/turn-telemetry.ts | the plain activity line, helpers and usage windows from agent events |
| src/orchestrator/types.ts | 05deefb0a43a | src/orchestrator/types.ts | dropped factory build report, QA bound and known-issues fields; `helperWaitMs`; `activity`, `helpers`, `recent` on running cards; `rateLimits` |
| src/orchestrator/worker-outcomes.ts | 05deefb0a43a | src/orchestrator/worker-outcomes.ts | unchanged |
| src/orchestrator/workpad-parser.ts | 05deefb0a43a | src/orchestrator/workpad-parser.ts | unchanged |
| src/orchestrator/workspace-gc.ts | 05deefb0a43a | src/orchestrator/workspace-gc.ts | unchanged |
| src/orchestrator/workspace-lock-gate.ts | 05deefb0a43a | src/orchestrator/workspace-lock-gate.ts | unchanged |
| src/orchestrator/workspace-periodic-sweep.ts | 05deefb0a43a | src/orchestrator/workspace-periodic-sweep.ts | unchanged |
| src/orchestrator/workspace-startup-sweep.ts | 05deefb0a43a | src/orchestrator/workspace-startup-sweep.ts | unchanged |
| src/process/process-tree.ts | 05deefb0a43a | src/process/process-tree.ts | unchanged |
| src/process/procfs.ts | 05deefb0a43a | src/process/procfs.ts | falls back to the macOS process table (ps-table.ts) where /proc is missing |
| src/process/ps-table.ts | new | | macOS process table (Forge reads Linux /proc only) |
| src/process/run-tree.ts | 05deefb0a43a | src/process/run-tree.ts | unchanged |
| src/server/http-utils.ts | 05deefb0a43a | src/server/http-utils.ts | unchanged |
| src/server/index.ts | 05deefb0a43a | src/server/index.ts | exports the local pieces only (the hosted router stays in Forge) |
| src/server/orchestrator-controls.ts | 05deefb0a43a | src/server/orchestrator-controls.ts | IntendedStateRepo from ./types (local store, no database) |
| src/server/state-json.ts | 05deefb0a43a | src/server/state-json.ts | dropped the hosted analytics transformer; activity, helpers, recent lines |
| src/server/types.ts | 05deefb0a43a | src/server/types.ts | kept only the status types; IntendedStateRepo defined here (local store, no database) |
| src/telemetry/infer-issue-type.ts | 05deefb0a43a | src/telemetry/infer-issue-type.ts | unchanged |
| src/telemetry/types.ts | 05deefb0a43a | src/telemetry/types.ts | TicketStatus written out instead of read from the database schema |
| src/tracker/index.ts | 05deefb0a43a | src/tracker/index.ts | dropped Basecamp |
| src/tracker/linear-claim.ts | 05deefb0a43a | src/tracker/linear-claim.ts | unchanged |
| src/tracker/linear-errors.ts | 05deefb0a43a | src/tracker/linear-errors.ts | unchanged |
| src/tracker/linear-normalize.ts | 05deefb0a43a | src/tracker/linear-normalize.ts | unchanged |
| src/tracker/linear-paginate.ts | 05deefb0a43a | src/tracker/linear-paginate.ts | unchanged |
| src/tracker/linear-progress.ts | 05deefb0a43a | src/tracker/linear-progress.ts | unchanged |
| src/tracker/linear-reads.ts | 05deefb0a43a | src/tracker/linear-reads.ts | unchanged |
| src/tracker/linear-writes.ts | 05deefb0a43a | src/tracker/linear-writes.ts | unchanged |
| src/tracker/linear.ts | 05deefb0a43a | src/tracker/linear.ts | comment reworded (no old project name); `fetchBoard` |
| src/tracker/memory.ts | 05deefb0a43a | src/tracker/memory.ts | unchanged |
| src/tracker/types.ts | 05deefb0a43a | src/tracker/types.ts | `BoardCard`, optional `fetchBoard` |
| src/worker/issue-state-checker.ts | 05deefb0a43a | src/worker/issue-state-checker.ts | unchanged |
| src/worker/prompt-renderer.ts | 05deefb0a43a | src/worker/prompt-renderer.ts | unchanged |
| src/worker/runner.ts | 05deefb0a43a | src/worker/runner.ts | the lead waits for its helpers: timeouts pause, `helperWaitMs` limit, plain note on the card |
| src/worker/usage.ts | 05deefb0a43a | src/worker/usage.ts | unchanged |
| src/workspace/cleanup.ts | 05deefb0a43a | src/workspace/cleanup.ts | unchanged |
| src/workspace/copy-assets.ts | 05deefb0a43a | src/workspace/copy-assets.ts | runs the signing check after writing the identity |
| src/workspace/git-identity.ts | 05deefb0a43a | src/workspace/git-identity.ts | SSH signing (`FORGE_GIT_SIGNING_FORMAT=ssh`); `verifyWorkspaceSigning` (a test signature before a card starts; unsigned only when chosen) |
| src/workspace/inode-pressure.ts | 05deefb0a43a | src/workspace/inode-pressure.ts | unchanged |
| src/workspace/lock.ts | 05deefb0a43a | src/workspace/lock.ts | unchanged |
| src/workspace/manager.ts | 05deefb0a43a | src/workspace/manager.ts | dropped remote (SSH) workspaces and the container ownership hand-off |
| src/workspace/mcp-config.ts | 05deefb0a43a | src/workspace/mcp-config.ts | unchanged |
| src/workspace/orphan-reaper.ts | 05deefb0a43a | src/workspace/orphan-reaper.ts | unchanged |
| src/index.ts | new | | the engine as the app runs it (env in, ready line out, drain on SIGTERM); reads the board on start, every poll interval and on refresh; serves the workpad |
| src/server/local-api.ts | new | | the local API: 127.0.0.1, launch token, HTTP + live WebSocket; `GET /api/v1/cards/<id>/workpad` |
| src/server/engine-state.ts | new | | the one state object the app shows |
| src/store/local-store.ts | new | | the engine's SQLite file (Start/Stop intent, finished runs) |
| src/worker/helper-wait.ts | new | | the lead waits for its helpers (`HelperWatch`, the limit message) |
| src/orchestrator/activity.ts | new | | one plain line per card, the lead's helpers |
| src/orchestrator/board-reader.ts | new | | the board: every card in the columns, with live activity |
| src/tracker/linear-board.ts | new | | the board's Linear read, with each card's pull request |

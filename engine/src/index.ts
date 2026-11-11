#!/usr/bin/env node
/**
 * The Forge engine, as the Forge app runs it. The app starts this process with
 * everything in its environment (secrets come from the Keychain, never a file):
 *
 *   FORGE_API_TOKEN   the launch token every local API request must carry (required)
 *   FORGE_HOME        Forge's folder (default ~/Library/Application Support/Forge)
 *   FORGE_ENGINE_HOME this engine's own folder when the app runs one per project (default $FORGE_HOME):
 *                     its workflow file and its store live there
 *   FORGE_WORKFLOW    the workflow file (default $FORGE_ENGINE_HOME/WORKFLOW.md)
 *   FORGE_AGENT_CEILING, FORGE_AGENT_SLOTS_DIR  the most agents at once across every engine on the Mac,
 *                     and the folder where engines share their counts (orchestrator/shared-slots.ts)
 *   FORGE_LOG_FILE    the log (default ~/Library/Logs/Forge/engine.log)
 *
 * On start it prints one line to stdout, `FORGE_ENGINE_READY {"port":N}`, and
 * nothing else ever goes to stdout. SIGTERM drains: no new cards, running agents
 * get FORGE_DRAIN_MS (default 20 s) to finish, then they are stopped.
 *
 * New in Forge Desktop (Forge's entry is a CLI for its hosted platform).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkerAgent, scrubMcpServerEnvs } from "./agent/index.js";
import { defaultAgentEnv, RoleRouter, roleEnv } from "./agent/roles.js";
import { validateRequiredEnv } from "./config/env-validator.js";
import { WorkflowStore } from "./config/watcher.js";
import { buildMcpServersConfig } from "./mcp/builders.js";
import { createLogger } from "./observability/logger.js";
import { resolveBacklogPromotion } from "./orchestrator/backlog-promotion.js";
import { BoardReader } from "./orchestrator/board-reader.js";
import { resolveCostCeiling } from "./orchestrator/cost-ceiling.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { SharedSlots } from "./orchestrator/shared-slots.js";
import { buildEngineState } from "./server/engine-state.js";
import { startLocalApi } from "./server/local-api.js";
import { createOrchestratorControls } from "./server/orchestrator-controls.js";
import { runSessionsHost } from "./sessions/main.js";
import { openLocalStore } from "./store/local-store.js";
import { marksNote, resolveMarks } from "./tracker/marks.js";
import type { TrackerConfig } from "./tracker/types.js";
import { createTrackerFromConfig } from "./tracker-factory.js";
import { loadSkillsManifest } from "./worker/prompt-renderer.js";
import { stopLeftoverServers } from "./workspace/leftover-sweep.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { guardCommand } from "./workspace/marks-guard.js";

async function main(): Promise<void> {
  const token = process.env.FORGE_API_TOKEN ?? "";
  if (token.length < 32) throw new Error("FORGE_API_TOKEN is missing or too short");
  const home =
    process.env.FORGE_ENGINE_HOME ??
    process.env.FORGE_HOME ??
    join(homedir(), "Library/Application Support/Forge");
  const workflowPath = resolve(process.env.FORGE_WORKFLOW ?? join(home, "WORKFLOW.md"));
  const logFile = process.env.FORGE_LOG_FILE ?? join(homedir(), "Library/Logs/Forge/engine.log");
  if (!existsSync(workflowPath)) throw new Error(`no workflow file at ${workflowPath}`);

  const logger = createLogger({ level: "info", logFile, fileOnly: true });
  const store = new WorkflowStore(workflowPath);
  const { config, promptTemplate } = store.current();
  validateRequiredEnv(config);
  logger.info({ workflowPath, tracker: config.tracker.kind }, "Forge engine starting");

  // What others see: the pull request label, the branch prefix and "Keep Forge invisible" (tracker/marks.ts).
  const marks = resolveMarks(config.marks);
  const tracker = createTrackerFromConfig(config, process.env, logger);
  const trackerConfig: TrackerConfig = {
    kind: config.tracker.kind,
    project_slug: config.tracker.project_slug,
    team_id: config.tracker.team_id,
    active_states: config.tracker.active_states,
    terminal_states: config.tracker.terminal_states,
    done_states: config.tracker.done_states,
    labels: config.tracker.labels,
  };
  const hasRoles = config.agent.roles.length > 0;
  const agent = createWorkerAgent(config.agent.kind, {
    command: config.agent.command,
    model: config.agent.model,
    logger,
    // With roles, the default agent never sees another role's account.
    ...(hasRoles ? { env: defaultAgentEnv(process.env) } : {}),
    envDenylist: config.agent.env_denylist,
  });
  // Roles: another provider, account and model for some stages (agent/roles.ts).
  const router = new RoleRouter(
    agent,
    config.agent.roles.map((r) => ({
      states: r.states,
      agent: createWorkerAgent(r.kind, {
        model: r.model,
        logger,
        env: roleEnv(process.env, r.env_prefix),
        envDenylist: config.agent.env_denylist,
      }),
    })),
  );
  const ceiling = Number(process.env.FORGE_AGENT_CEILING ?? 0);
  const slots =
    ceiling > 0 && process.env.FORGE_AGENT_SLOTS_DIR
      ? new SharedSlots(process.env.FORGE_AGENT_SLOTS_DIR, home, ceiling)
      : undefined;
  const skillsDir = config.workspace.skills_dir
    ? resolve(dirname(workflowPath), config.workspace.skills_dir)
    : undefined;
  const workspace = new WorkspaceManager({
    root: config.workspace.root,
    hooks: config.workspace.hooks,
    hookTimeoutMs: config.workspace.hooks.timeout_ms,
    skillsDir,
    marksGuard: marks.invisible ? guardCommand(dirname(fileURLToPath(import.meta.url))) : undefined,
    stopLeftovers: (root, card) => stopLeftoverServers(root, { only: card, logger }),
  });
  const local = openLocalStore(join(home, "forge.sqlite"));
  const board = new BoardReader(tracker, trackerConfig, config.board.columns);

  let notify = (): void => {};
  const orchestrator = new Orchestrator(
    tracker,
    agent,
    workspace,
    {
      pollIntervalMs: config.polling.interval_ms,
      maxConcurrentAgents: config.agent.max_concurrent_agents,
      ...(slots ? { agentLimit: (inFlight: number) => slots.limit(inFlight) } : {}),
      ...(hasRoles
        ? {
            agentForState: (state: string) => router.agentFor(state),
            roleOf: (state: string) => router.roleOf(state),
          }
        : {}),
      maxTurns: config.agent.max_turns,
      turnTimeoutMs: config.agent.turn_timeout_ms,
      readTimeoutMs: config.agent.read_timeout_ms,
      helperWaitMs: config.agent.helper_wait_ms,
      approvalPolicy: config.agent.approval_policy,
      stallTimeoutSeconds: config.agent.stall_timeout_seconds,
      maxRetryAttempts: config.retry.max_attempts,
      maxRetryDelayMs: config.agent.max_retry_backoff_ms,
      retryBaseDelayMs: config.retry.base_delay_seconds * 1000,
      trackerConfig,
      promptTemplate: promptTemplate + marksNote(marks),
      branchPrefix: marks.branchPrefix,
      mcpServers: scrubMcpServerEnvs(
        buildMcpServersConfig(
          config.tracker.kind,
          { accountId: config.tracker.account_id, endpoint: config.tracker.endpoint },
          { invisible: marks.invisible },
        ),
        config.agent.env_denylist,
      ),
      skillsManifest: skillsDir ? loadSkillsManifest(skillsDir) : undefined,
      logger,
      costCeiling: resolveCostCeiling(config.cost, { logger }),
      customWorkflows: true,
      claimOptions: { assignee: "me" },
      backlogPromotion: resolveBacklogPromotion(config.tracker.promote, {
        customWorkflows: true,
        logger,
      }),
    },
    {
      onDispatch: (issue) => {
        logger.info({ identifier: issue.identifier }, "Dispatching");
        notify();
      },
      onComplete: (_id, result, issue) => {
        logger.info({ identifier: issue.identifier, success: result.success }, "Completed");
        void board.refresh().then(() => notify());
      },
      onError: (issueId, err) => logger.error({ issueId, err }, "Card run failed"),
      onPollError: (err) => logger.warn({ err }, "Board poll failed"),
      onTicketComplete: (_id, t) => {
        local.recordRun({
          issueId: t.issueId,
          identifier: t.identifier,
          outcome: t.status,
          startedAt: new Date(t.startedAtMs).toISOString(),
          finishedAt: new Date(t.finishedAtMs).toISOString(),
          inputTokens: t.tokens.input,
          outputTokens: t.tokens.output,
          cacheReadTokens: t.tokens.cacheRead,
          cacheWriteTokens: t.tokens.cacheWrite,
        });
      },
    },
  );

  const controls = createOrchestratorControls({
    orchestrator,
    workflowPath,
    config,
    logger,
    intendedState: {
      read: async () => local.readDesired(),
      write: async (desired) => local.writeDesired(desired),
    },
  });

  const api = await startLocalApi({
    token,
    logger,
    getState: () =>
      buildEngineState({
        controls,
        orchestrator,
        local,
        board: () =>
          board.view(orchestrator.getSnapshot().running, (id) => orchestrator.handsOn.isOn(id)),
      }),
    workpad: (id) => board.workpad(id),
    move: async (id, to) => {
      const result = await board.move(id, to);
      logger.info({ issueId: id, to, ok: result.ok }, "Card moved from the board");
      if (result.ok) void orchestrator.triggerPoll();
      return result;
    },
    steer: (id, text) => {
      const ok = orchestrator.steer(id, text);
      logger.info({ issueId: id, ok }, "The person steered a card");
      return ok;
    },
    takeWheel: (id) => {
      const ok = orchestrator.takeWheel(id);
      logger.info({ issueId: id, ok }, "The person took the wheel of a card");
      return ok;
    },
    handBack: (id) => {
      const ok = orchestrator.handBack(id);
      logger.info({ issueId: id, ok }, "The person handed a card back to Forge");
      return ok;
    },
    start: () => controls.startOrchestrator(null),
    stop: () => controls.stopOrchestrator(null),
    refresh: () => {
      void board.refresh().then(() => notify());
      return orchestrator.triggerPoll();
    },
  });
  notify = api.notify;
  // The board shows even while agents are stopped: read it now and on every poll interval.
  await board.refresh();
  const boardTimer = setInterval(
    () => void board.refresh().then(() => notify()),
    config.polling.interval_ms,
  );
  boardTimer.unref();
  await controls.restoreFromPersistedIntent();

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "Forge engine stopping");
    const drainMs = Number(process.env.FORGE_DRAIN_MS ?? 20_000);
    const drained = orchestrator.stop().then(() => true);
    const timedOut = new Promise<boolean>((r) => setTimeout(() => r(false), drainMs).unref());
    if (!(await Promise.race([drained, timedOut]))) {
      logger.warn({ drainMs }, "Agents still running after the drain window; stopping them");
      await orchestrator.stop({ abort: true }).catch(() => {});
    }
    clearInterval(boardTimer);
    await api.close();
    slots?.close();
    local.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.stdout.write(`FORGE_ENGINE_READY ${JSON.stringify({ port: api.port })}\n`);
  logger.info({ port: api.port }, "Forge engine ready");
}

// FORGE_ENGINE_MODE=sessions: the sessions host (chats with agents) instead of a board engine.
(process.env.FORGE_ENGINE_MODE === "sessions" ? runSessionsHost() : main()).catch((err) => {
  process.stderr.write(
    `Forge engine could not start: ${err instanceof Error ? err.message : err}\n`,
  );
  process.exit(1);
});

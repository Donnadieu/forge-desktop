import type { Logger } from "pino";
import pino from "pino";
import type { AgentAdapter, AgentEvent, SessionHandle } from "../agent/types.js";
import type { TokenTotals } from "../telemetry/types.js";
import type { NormalizedIssue, TrackerAdapter, TrackerConfig } from "../tracker/types.js";
import { lockHolderLogFields, WORKSPACE_LOCK_HELD } from "../workspace/lock.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { gitHasBranch, issueBranch } from "./branch.js";
import { DEFAULT_HELPER_WAIT_MS, HelperWatch } from "./helper-wait.js";
import { IssueStateChecker } from "./issue-state-checker.js";
import { renderFirstTurnPrompt } from "./prompt-renderer.js";
import { addUsageTokens } from "./usage.js";

export interface WorkerConfig {
  maxTurns: number;
  turnTimeoutMs?: number;
  readTimeoutMs?: number;
  approvalPolicy?: string;
  promptTemplate: string;
  trackerConfig: TrackerConfig;
  mcpServers?: Record<string, unknown>;
  skillsManifest?: string;
  /** Dispatch attempt number (1 = first dispatch, >1 = continuation re-dispatch for single-turn agents). */
  attempt?: number;
  /** Pino logger; a silent default is created if omitted. */
  logger?: Logger;
  /** Maximum consecutive state-check failures before the worker aborts. */
  maxStateCheckRetries?: number;
  /** How long the lead may wait for its helpers after ending its turn (helper-wait.ts). */
  helperWaitMs?: number;
  /** Forge Desktop: which role a state belongs to. A card that moves to another role's stage ends this run. */
  roleOf?: (state: string) => number;
  /** Forge Desktop: Workflow Studio's branch prefix (branch.ts); empty = the tracker's own branch name. */
  branchPrefix?: string;
}

export interface WorkerResult {
  issueId: string;
  turns: number;
  tokens: TokenTotals;
  success: boolean;
  error?: string;
  workspacePath?: string;
  /** When true the orchestrator must NOT delete the workspace (single-turn agents need it for re-dispatch). */
  preserveWorkspace?: boolean;
}

export interface WorkerCallbacks {
  onEvent?: (issueId: string, event: AgentEvent) => void;
  onTurnStart?: (issueId: string, turn: number) => void;
  onTurnEnd?: (issueId: string, turn: number) => void;
  /** Forge Desktop: the session id and workspace are known (as soon as the agent's handle resolves), so the
   *  app can follow and steer this run's session (sessions/cards.ts) before the run itself finishes. */
  onSessionReady?: (issueId: string, sessionId: string, workspacePath: string) => void;
  /** Asked between turns: true once Stop was pressed, so the agent ends after the turn it's on. */
  shouldStop?: () => boolean;
  /** Forge Desktop (orchestrator/hands-on.ts): the person's message to run as the next turn while they hold the
   *  wheel; null for Forge's own turn. */
  nextPrompt?: () => Promise<string | null>;
  /** Forge Desktop: the person stopped this turn to take the wheel, so its interrupted end isn't a failure. */
  personStopped?: () => boolean;
  signal?: AbortSignal;
}

/**
 * Forge Desktop: the card moved to a stage another role's agent works. This run ends as a success with its folder
 * kept, so the orchestrator dispatches the card again at once, with that role's agent (agent/roles.ts).
 */
function handoff(
  issue: NormalizedIssue,
  turns: number,
  tokens: TokenTotals,
  workspacePath: string,
): WorkerResult {
  return {
    issueId: issue.id,
    turns,
    tokens,
    success: true,
    workspacePath,
    preserveWorkspace: true,
  };
}

export async function runWorker(
  issue: NormalizedIssue,
  config: WorkerConfig,
  agent: AgentAdapter,
  tracker: TrackerAdapter,
  workspace: WorkspaceManager,
  callbacks?: WorkerCallbacks,
): Promise<WorkerResult> {
  const logger = (config.logger ?? pino({ level: "silent" })).child({
    issueId: issue.id,
    identifier: issue.identifier,
  });
  const stateChecker = new IssueStateChecker(config.maxStateCheckRetries ?? 3);
  // Forge Desktop: the role this run's agent was picked for (the card's stage at dispatch). A card that moves
  // to another role's stage ends the run, so that role's agent picks it up.
  const roleOf = config.roleOf;
  const startRole = roleOf?.(issue.state);
  const leftRole = roleOf ? (state: string) => roleOf(state) !== startRole : undefined;

  const totalTokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let turnNumber = 0;
  let sessionId: string | undefined;
  let currentHandle: SessionHandle | null = null;
  let aborted = false;
  // The agent's own reason for a failed turn (e.g. "OAuth session expired"), kept so the
  // orchestrator can show it and retry instead of the run failing without a word.
  let lastError: string | undefined;

  if (callbacks?.signal?.aborted) {
    return { issueId: issue.id, turns: 0, tokens: totalTokens, success: false, error: "Aborted" };
  }
  callbacks?.signal?.addEventListener(
    "abort",
    () => {
      aborted = true;
      if (currentHandle) currentHandle.abortController.abort();
    },
    { once: true },
  );

  // 1. Take the issue's workspace dispatch lock before touching the workspace:
  // a live foreign holder (another orchestrator process, or a previous
  // orchestrator's surviving agent tree) means the workspace is in use.
  const locked = await workspace.acquireLock(issue);
  if (!locked.acquired) {
    logger.warn(lockHolderLogFields(locked.holder, locked.markedPids), WORKSPACE_LOCK_HELD);
    throw new Error(`Workspace for ${issue.identifier} is locked by live pid ${locked.holder.pid}`);
  }
  const { lock } = locked;

  let workspacePath: string;
  let mcpConfigPath: string | undefined;
  let issueEnv: Record<string, string>;
  try {
    // 2. Create/reuse workspace; 3. write MCP config if needed; 4. run before_run hook
    workspacePath = await workspace.ensureWorkspace(issue);
    issueEnv = {
      ISSUE_ID: issue.id,
      ISSUE_IDENTIFIER: issue.identifier,
      ISSUE_TITLE: issue.title,
      ISSUE_STATE: issue.state,
      ISSUE_BRANCH: issueBranch(issue, config.branchPrefix ?? "", gitHasBranch(workspacePath)),
    };
    if (config.mcpServers) {
      mcpConfigPath = await workspace.writeMcpConfig(workspacePath, config.mcpServers);
    }
    await workspace.runHook("before_run", workspacePath, issueEnv);
  } catch (err) {
    await lock.release();
    throw err;
  }

  let lastTurnSuccess = true;
  const useRunTurn = agent.persistentSession && typeof agent.runTurn === "function";

  try {
    // 4. For persistent adapters with runTurn: handshake once, then loop turns.
    // Skipped when the run was aborted during setup (e.g. orchestrator shutdown
    // landing in before_run), so no agent is spawned only to be killed.
    if (useRunTurn && !aborted) {
      const handle = await agent.startSession({
        prompt: "", // prompt sent via runTurn
        workspacePath,
        mcpConfigPath,
        sessionId,
        approvalPolicy: config.approvalPolicy,
        handshakeOnly: true,
        signal: callbacks?.signal,
      });
      currentHandle = handle;
      if (handle.pid !== undefined) await lock.recordAgentPid(handle.pid);
      sessionId = handle.id;
      callbacks?.onSessionReady?.(issue.id, sessionId, workspacePath);

      while (turnNumber < config.maxTurns && !aborted) {
        const person = turnNumber > 0 ? ((await callbacks?.nextPrompt?.()) ?? null) : null;
        if (aborted || (turnNumber > 0 && callbacks?.shouldStop?.())) break;
        turnNumber++;
        callbacks?.onTurnStart?.(issue.id, turnNumber);

        let turnTimedOut = false;
        let turnTimer: ReturnType<typeof setTimeout> | undefined;
        if (config.turnTimeoutMs) {
          turnTimer = setTimeout(() => {
            turnTimedOut = true;
          }, config.turnTimeoutMs);
        }

        const prompt =
          person ??
          (turnNumber === 1
            ? renderFirstTurnPrompt(
                config.promptTemplate,
                issue,
                config.attempt ?? 1,
                config.skillsManifest,
              )
            : buildContinuationGuidance(turnNumber, config.maxTurns));

        let turnSuccess = true;
        let eventCount = 0;
        let readTimer: ReturnType<typeof setTimeout> | undefined;
        let readTimedOut = false;

        const resetReadTimer = () => {
          if (readTimer) clearTimeout(readTimer);
          if (config.readTimeoutMs) {
            readTimer = setTimeout(() => {
              readTimedOut = true;
              handle.abortController.abort();
            }, config.readTimeoutMs);
          }
        };

        resetReadTimer();

        // useRunTurn guards entry to this branch — agent.runTurn is guaranteed.
        // biome-ignore lint/style/noNonNullAssertion: presence enforced by useRunTurn check above
        for await (const event of agent.runTurn!(handle, prompt)) {
          resetReadTimer();
          eventCount++;
          callbacks?.onEvent?.(issue.id, event);

          addUsageTokens(totalTokens, event);
          if (event.type === "error") {
            lastError = event.message;
            turnSuccess = false;
            break;
          }
          if (event.type === "done") {
            turnSuccess = event.success;
            break;
          }
        }

        if (eventCount === 0) turnSuccess = false;
        if (readTimer) clearTimeout(readTimer);
        if (turnTimer) clearTimeout(turnTimer);

        if (turnTimedOut || readTimedOut) {
          logger.debug({ turnNumber, turnTimedOut, readTimedOut }, "Killing session");
          await agent.stopSession(handle);
          lastTurnSuccess = false;
          break;
        }

        // Forge Desktop: the person stopped this turn to take the wheel; the run waits for them instead of failing.
        if (!turnSuccess && !aborted && callbacks?.personStopped?.()) turnSuccess = true;
        callbacks?.onTurnEnd?.(issue.id, turnNumber);

        if (!turnSuccess || aborted) {
          lastTurnSuccess = false;
          break;
        }
        if (callbacks?.shouldStop?.()) break;

        const stateCheck = await stateChecker.decide(
          tracker,
          issue,
          config.trackerConfig.active_states,
          logger,
          { turns: turnNumber, tokens: totalTokens, workspacePath, preserveWorkspace: false },
          leftRole,
        );
        if (stateCheck === "handoff") return handoff(issue, turnNumber, totalTokens, workspacePath);
        if (stateCheck === "break") break;
        if (stateCheck) return stateCheck;
      }
      const success = lastTurnSuccess && !aborted;
      return {
        issueId: issue.id,
        turns: turnNumber,
        tokens: totalTokens,
        success,
        ...(!success && lastError ? { error: lastError } : {}),
        workspacePath,
        preserveWorkspace: false,
      };
    }

    // 4. Per-turn streamEvents flow (non-persistent or no runTurn)
    while (turnNumber < config.maxTurns && !aborted) {
      const person = turnNumber > 0 ? ((await callbacks?.nextPrompt?.()) ?? null) : null;
      if (aborted || (turnNumber > 0 && callbacks?.shouldStop?.())) break;
      turnNumber++;

      callbacks?.onTurnStart?.(issue.id, turnNumber);

      // Turn timeout. Time spent waiting for helpers doesn't count against it
      // (the helper limit covers that), so it is checked only while the lead works.
      let turnTimedOut = false;
      let turnTimer: ReturnType<typeof setTimeout> | undefined;
      let turnOverdue = false;
      if (config.turnTimeoutMs) {
        turnTimer = setTimeout(() => {
          turnOverdue = true;
        }, config.turnTimeoutMs);
      }

      const prompt =
        person ??
        (turnNumber === 1
          ? renderFirstTurnPrompt(
              config.promptTemplate,
              issue,
              config.attempt ?? 1,
              config.skillsManifest,
            )
          : `Continuation guidance:

- The previous turn completed normally, but the Linear issue is still in an active state.
- This is continuation turn #${turnNumber} of ${config.maxTurns} for the current agent run.
- Resume from the current workspace and workpad state instead of restarting from scratch.
- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.`);

      // Spawn agent turn
      const handle = await agent.startSession({
        prompt,
        workspacePath,
        mcpConfigPath,
        sessionId,
        approvalPolicy: config.approvalPolicy,
        signal: callbacks?.signal,
      });

      currentHandle = handle;
      if (handle.pid !== undefined) await lock.recordAgentPid(handle.pid);
      sessionId = handle.id;
      callbacks?.onSessionReady?.(issue.id, sessionId, workspacePath);

      if (aborted) {
        handle.abortController.abort();
        lastTurnSuccess = false;
        break;
      }

      // Stream events with optional read timeout. While the lead waits for its
      // helpers (helper-wait.ts) the read timeout pauses and the helper limit applies.
      let turnSuccess = true;
      let eventCount = 0;
      let readTimer: ReturnType<typeof setTimeout> | undefined;
      let readTimedOut = false;
      const helpers = new HelperWatch();
      const helperWaitMs = config.helperWaitMs ?? DEFAULT_HELPER_WAIT_MS;
      let helperTimer: ReturnType<typeof setTimeout> | undefined;
      let helperLimitHit = false;
      let waitedForHelpers = false;

      const resetReadTimer = () => {
        if (readTimer) clearTimeout(readTimer);
        if (config.readTimeoutMs && !helpers.waiting) {
          readTimer = setTimeout(() => {
            readTimedOut = true;
            handle.abortController.abort();
          }, config.readTimeoutMs);
        }
      };

      resetReadTimer();

      for await (const event of agent.streamEvents(handle)) {
        helpers.observe(event);
        if (helpers.waiting) waitedForHelpers = true;
        if (helpers.waiting && !helperTimer) {
          logger.info({ helpers: helpers.count }, "Lead ended its turn; waiting for its helpers");
          helperTimer = setTimeout(() => {
            helperLimitHit = true;
            handle.abortController.abort();
          }, helperWaitMs);
        }
        if (!helpers.waiting && helperTimer) {
          clearTimeout(helperTimer);
          helperTimer = undefined;
        }
        resetReadTimer();
        eventCount++;

        callbacks?.onEvent?.(issue.id, event);

        addUsageTokens(totalTokens, event);

        if (event.type === "error") {
          lastError = event.message;
          turnSuccess = false;
          break;
        }

        if (event.type === "done") {
          turnSuccess = event.success;

          break;
        }
      }

      // If zero events were received, the agent likely crashed at startup — treat as failure
      if (eventCount === 0) {
        turnSuccess = false;
      }

      logger.debug(
        { events: eventCount, readTimedOut, turnTimedOut, turnSuccess, aborted },
        "streamEvents returned",
      );

      if (readTimer) clearTimeout(readTimer);
      if (helperTimer) clearTimeout(helperTimer);
      // A turn that ran long only because the lead waited for its helpers isn't overdue.
      turnTimedOut = turnOverdue && !waitedForHelpers;

      if (turnTimer) clearTimeout(turnTimer);
      if (helperLimitHit) {
        logger.warn({ helpers: helpers.count, helperWaitMs }, "Helper wait limit hit");
        await tracker
          .createComment?.(issue.id, helpers.limitMessage(helperWaitMs))
          .catch((err) => logger.warn({ err: String(err) }, "Could not leave the wait-limit note"));
        await agent.stopSession(handle);
        lastTurnSuccess = false;
        break;
      }
      if (turnTimedOut || readTimedOut) {
        logger.debug({ turnTimedOut, readTimedOut }, "Killing session");
        await agent.stopSession(handle);
        lastTurnSuccess = false;
        break;
      }

      // Forge Desktop: the person stopped this turn to take the wheel; the run waits for them instead of failing.
      if (!turnSuccess && !aborted && callbacks?.personStopped?.()) turnSuccess = true;
      callbacks?.onTurnEnd?.(issue.id, turnNumber);

      // An aborted (killed) run is a failure even if the killed process had
      // already streamed events and the adapter reported `done success:true`.
      if (!turnSuccess || aborted) {
        lastTurnSuccess = false;
        break;
      }

      // Single-turn agents (e.g. Hermes): run one turn, return to orchestrator for re-dispatch.
      if (!agent.persistentSession) {
        break;
      }
      if (callbacks?.shouldStop?.()) break;

      const stateCheck = await stateChecker.decide(
        tracker,
        issue,
        config.trackerConfig.active_states,
        logger,
        {
          turns: turnNumber,
          tokens: totalTokens,
          workspacePath,
          preserveWorkspace: !agent.persistentSession,
        },
        leftRole,
      );
      if (stateCheck === "handoff") return handoff(issue, turnNumber, totalTokens, workspacePath);
      if (stateCheck === "break") break;
      if (stateCheck) return stateCheck;
    }
  } catch (err) {
    // An abort rejects a pending startSession (or anything else mid-run): report it as aborted.
    if (!aborted) throw err;
    logger.debug({ err: String(err) }, "Run aborted mid-step");
    lastTurnSuccess = false;
  } finally {
    try {
      // Stop the agent on EVERY exit path, or a normal run end leaks its process.
      if (currentHandle) await agent.stopSession(currentHandle);
    } catch (err) {
      logger.warn({ err: String(err) }, "stopSession failed during run cleanup");
    }
    await workspace.runHook("after_run", workspacePath, issueEnv).catch(() => {}); // 5. never masks result
    await lock.release();
  }
  return {
    issueId: issue.id,
    turns: turnNumber,
    tokens: totalTokens,
    // An abort anywhere (between turns, during a state check) is a failure.
    success: lastTurnSuccess && !aborted,
    ...(aborted ? { error: "Aborted" } : !lastTurnSuccess && lastError ? { error: lastError } : {}),
    workspacePath: workspacePath,
    preserveWorkspace: !agent.persistentSession,
  };
}
function buildContinuationGuidance(turnNumber: number, maxTurns: number): string {
  return `Continuation guidance:

- The previous turn completed normally, but the issue is still in an active state.
- This is continuation turn #${turnNumber} of ${maxTurns} for the current agent run.
- Resume from the current workspace and workpad state instead of restarting from scratch.
- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.`;
}

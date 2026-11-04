/**
 * Factory for the lifecycle callbacks the HTTP control surface exposes.
 *
 * Keeps state (running / stoppingPromise / startedAt) in closures rather than
 * on the Orchestrator class so `start()` / `stop()` stay pure and the dashboard
 * can observe the transitional "stopping" state while workers drain.
 *
 * Persisted desired-state survives restarts: `startOrchestrator` /
 * `stopOrchestrator` write the person's intent to the local store, and
 * `restoreFromPersistedIntent` replays it on boot.
 */

import type { Logger } from "pino";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { IntendedStateRepo, OrchestratorStatus, StartReason } from "./types.js";

interface ControlsConfigSnapshot {
  tracker: { kind: string; project_slug: string; active_states: readonly string[] };
  agent: { max_concurrent_agents: number };
}

export interface OrchestratorControls {
  startOrchestrator: (userId: string | null) => Promise<{ started: boolean; reason?: StartReason }>;
  stopOrchestrator: (userId: string | null) => Promise<{ stopped: boolean }>;
  getStatus: () => OrchestratorStatus;
  /** Reads the persisted desired-state and replays it (boot-time only). */
  restoreFromPersistedIntent: () => Promise<void>;
}

export function createOrchestratorControls(params: {
  orchestrator: Orchestrator;
  workflowPath: string;
  config: ControlsConfigSnapshot;
  logger: Logger;
  intendedState: IntendedStateRepo;
  /** The orchestrator's boot-time dispatch hold (FRG-2928), if any. */
  dispatchHold?: OrchestratorStatus["dispatchHold"];
}): OrchestratorControls {
  let running = false;
  let startedAt: string | null = null;
  let stoppingPromise: Promise<void> | null = null;

  const writeIntent = async (
    desired: "running" | "stopped",
    userId: string | null,
  ): Promise<void> => {
    try {
      await params.intendedState.write(desired, userId);
    } catch (err) {
      params.logger.error(
        { err, desired, userId },
        "Failed to persist orchestrator intended-state",
      );
    }
  };

  const start = async (
    userId: string | null,
  ): Promise<{ started: boolean; reason?: StartReason }> => {
    if (stoppingPromise) return { started: false, reason: "stopping" };
    if (running) return { started: false, reason: "already_running" };
    running = true;
    startedAt = new Date().toISOString();
    params.orchestrator.start();
    params.logger.info({ userId }, "Orchestrator started");
    await writeIntent("running", userId);
    return { started: true };
  };

  // Stop answers at once: no new cards from now on, and the running agents
  // drain in the background (status "stopping" until they're done). Waiting
  // for the drain here made the app's request time out while a card ran.
  const stop = async (userId: string | null): Promise<{ stopped: boolean }> => {
    if (!running) return { stopped: false };
    running = false;
    params.logger.info({ userId }, "Orchestrator stop requested");
    const drain = params.orchestrator
      .stop()
      .then(
        () => params.logger.info({ userId }, "Orchestrator stopped"),
        (err) => params.logger.error({ err, userId }, "Orchestrator drain failed"),
      )
      .finally(() => {
        if (stoppingPromise === drain) stoppingPromise = null;
        startedAt = null;
      });
    stoppingPromise = drain;
    // The person's intent is "stopped" from the moment they pressed Stop, so a
    // quit mid-drain doesn't come back running.
    await writeIntent("stopped", userId);
    return { stopped: true };
  };

  return {
    startOrchestrator: start,
    stopOrchestrator: stop,
    getStatus: () => {
      const ph = params.orchestrator.getPollHealth();
      return {
        state: stoppingPromise ? "stopping" : running ? "running" : "stopped",
        startedAt,
        workflowPath: params.workflowPath,
        config: {
          tracker: params.config.tracker.kind,
          projectSlug: params.config.tracker.project_slug,
          maxAgents: params.config.agent.max_concurrent_agents,
          activeStates: [...params.config.tracker.active_states],
        },
        pollHealth: {
          lastPollAt: ph.lastPollAtMs === null ? null : new Date(ph.lastPollAtMs).toISOString(),
          lastPollError: ph.lastPollError,
          consecutiveEmptyPolls: ph.consecutiveEmptyPolls,
          running: ph.running,
          retrying: ph.retrying,
        },
        dispatchHold: params.dispatchHold ?? null,
      };
    },
    restoreFromPersistedIntent: async () => {
      let desired: "running" | "stopped";
      try {
        desired = await params.intendedState.read();
      } catch (err) {
        params.logger.error({ err }, "Failed to read orchestrator intended-state; staying stopped");
        return;
      }
      if (desired === "running") {
        params.logger.info("Restoring orchestrator to 'running' from persisted intent");
        await start(null);
      }
    },
  };
}

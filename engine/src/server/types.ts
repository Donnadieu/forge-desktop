import type { DispatchHold } from "../orchestrator/types.js";

/** The person's last Start or Stop, kept so the engine comes back the way they left it. */
export type IntendedState = "running" | "stopped";

/** Where Start/Stop intent is kept (local SQLite in the app; in memory in tests). */
export interface IntendedStateRepo {
  read(): Promise<IntendedState>;
  write(desired: IntendedState, userId: string | null): Promise<void>;
}

export interface OrchestratorStatus {
  state: "running" | "stopped" | "stopping";
  startedAt: string | null;
  workflowPath: string;
  config: {
    tracker: string;
    projectSlug: string;
    maxAgents: number;
    activeStates: string[];
  };
  /**
   * Live poll-health. Optional so non-orchestrator callers (dashboard-only
   * boot) can omit it. Lets a consumer (Smith) explain WHY nothing is
   * dispatching instead of guessing: `lastPollError` is the most recent
   * poll-cycle failure (e.g. an empty project slug), null when the last poll
   * was clean; `consecutiveEmptyPolls` flags a queue seen as empty.
   */
  pollHealth?: {
    lastPollAt: string | null;
    lastPollError: string | null;
    consecutiveEmptyPolls: number;
    running: number;
    retrying: number;
  };
  /**
   * Standing dispatch refusal (FRG-2928), null when workers may dispatch. Set
   * on a BYOK Smith whose own key can't back the build worker: `message` is the
   * owner-facing reason Hermes relays.
   */
  dispatchHold?: DispatchHold | null;
}

export type StartReason = "already_running" | "stopping";

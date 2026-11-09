/**
 * The one state object the app shows: whether the board is running, the
 * agents at work, cards waiting to retry, and usage. Sent by `GET /api/v1/state`
 * and by every live frame. Words here are the app's: cards, agents.
 *
 * New in Forge Desktop.
 */
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { LocalStore } from "../store/local-store.js";
import type { OrchestratorControls } from "./orchestrator-controls.js";
import { toStateJson } from "./state-json.js";

export interface EngineStateDeps {
  controls: OrchestratorControls;
  orchestrator: Orchestrator;
  local: LocalStore;
  /** The board's cards by column, once the board reader is wired (step 8). */
  board?: () => unknown;
}

export function buildEngineState(deps: EngineStateDeps): Record<string, unknown> {
  const status = deps.controls.getStatus();
  const snapshot = toStateJson(deps.orchestrator.getSnapshot());
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return {
    status: status.state,
    started_at: status.startedAt,
    poll: status.pollHealth ?? null,
    board: deps.board?.() ?? null,
    running: snapshot.running,
    retrying: snapshot.retrying,
    totals: snapshot.codex_totals,
    rate_limits: snapshot.rate_limits,
    limits: snapshot.limits,
    disk: deps.orchestrator.getDisk(),
    usage: { last_24h: deps.local.usageSince(dayAgo), all_time: deps.local.usageSince() },
  };
}

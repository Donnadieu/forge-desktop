/**
 * The lead waits for its helpers. A lead agent may end its turn while helpers
 * it sent (background subagents or commands) still work. The old runner took
 * that turn end as the end of the session and stopped the agent, which killed
 * the helpers mid-work and sent the card back to the start. Now the turn is
 * over only when no helper runs. While the lead waits, the read and turn
 * timeouts are paused (helpers can be quiet for a long time) and one limit
 * applies instead: `helperWaitMs` from the moment the lead started waiting.
 *
 * New in Forge Desktop.
 */
import type { AgentEvent } from "../agent/types.js";

/** Default time the lead may wait for its helpers after ending its turn. */
export const DEFAULT_HELPER_WAIT_MS = 60 * 60 * 1000;

export class HelperWatch {
  private running = new Map<string, string>();
  private waitingSince: number | null = null;

  /** Follow one event from the agent's stream. */
  observe(event: AgentEvent, now = Date.now()): void {
    if (event.type === "helper") {
      if (event.status === "started") this.running.set(event.id, event.description ?? "");
      else this.running.delete(event.id);
    } else if (event.type === "waiting_for_helpers") {
      this.waitingSince ??= now;
    } else if (event.type === "done") {
      this.waitingSince = null;
    }
  }

  /** The lead ended its turn and is waiting for helpers: timeouts are paused. */
  get waiting(): boolean {
    return this.waitingSince !== null;
  }

  get count(): number {
    return this.running.size;
  }

  /** What the helpers still running were sent to do, for the card. */
  descriptions(): string[] {
    return [...this.running.values()].filter(Boolean);
  }

  /** The plain message left on the card when the wait limit is hit. */
  limitMessage(limitMs: number): string {
    const minutes = Math.round(limitMs / 60_000);
    const list = this.descriptions();
    const what = list.length ? `: ${list.map((d) => `"${d}"`).join(", ")}` : "";
    return (
      `This run stopped: the agent waited ${minutes} minutes for ${this.count} ` +
      `helper${this.count === 1 ? "" : "s"} that had not finished${what}. ` +
      "The card goes back in line and its next run starts from the workpad."
    );
  }
}

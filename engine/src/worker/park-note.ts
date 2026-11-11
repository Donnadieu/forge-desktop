/**
 * The agent's park note (`.forge/parked`): on a board with no column for the
 * next stage, the agent leaves it instead of moving the card. The runner ends
 * the run when it finds one; the orchestrator parks the card
 * (orchestrator/parking.ts).
 *
 * New in Forge Desktop.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The agent's note, relative to the card's folder (`.forge/` is never committed). */
export const PARK_MARKER = ".forge/parked";

export interface ParkNote {
  /** The stage the card would go to next, which has no column. */
  next: string | null;
  /** One plain line for the person. */
  line: string;
}

/** Reads the agent's note and removes it, so the next run on the card (a Next step) starts clean. */
export function readParkMarker(dir: string): ParkNote | null {
  const path = join(dir, PARK_MARKER);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  rmSync(path, { force: true });
  try {
    const raw = JSON.parse(text) as { next?: unknown; line?: unknown };
    const line =
      typeof raw.line === "string" && raw.line.trim() ? raw.line.trim() : "Waiting on you";
    return { next: typeof raw.next === "string" ? raw.next : null, line };
  } catch {
    return { next: null, line: text.trim().split("\n")[0] || "Waiting on you" };
  }
}

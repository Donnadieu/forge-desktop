/**
 * Parking: "Waiting on you". On a board with no column for the next stage
 * (a shared team board without AI Review, QA, ...), the agent finishes In
 * Progress, opens the pull request as a draft and leaves a small note in the
 * card's folder (`.forge/parked`) instead of moving the card. The card stays in
 * its column on the board and nothing is posted: the team sees nothing new.
 *
 * The engine reads the note when the turn ends, ends the run there (no
 * "keep going while the issue is active" continuation, no retry), keeps the
 * card in `forge.sqlite` so it survives a restart, and skips it at dispatch
 * while it sits in the column it was parked in. If anyone moves the card on
 * the board, the board wins: the park is dropped and the card is worked as usual.
 *
 * New in Forge Desktop.
 */
import type { NormalizedIssue } from "../tracker/types.js";
import type { ParkNote } from "../worker/park-note.js";
import type { OrchestratorState } from "./types.js";

export { PARK_MARKER, type ParkNote, readParkMarker } from "../worker/park-note.js";

export interface ParkedCard extends ParkNote {
  issueId: string;
  identifier: string;
  /** The column the card sat in when it was parked. */
  state: string;
  parkedAt: string;
}

/** Where parks are kept across restarts (forge.sqlite). */
export interface ParkingStore {
  list(): ParkedCard[];
  put(card: ParkedCard): void;
  remove(issueId: string): void;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/** True while the card sits, parked, in the column it was parked in. */
export function isParked(state: OrchestratorState, issue: NormalizedIssue): boolean {
  const p = state.parked.get(issue.id);
  return p !== undefined && norm(p.state) === norm(issue.state);
}

/** The board wins: drops every park whose card left its column (or the active columns) since. */
export function forgetMovedParked(
  state: OrchestratorState,
  candidates: NormalizedIssue[],
  remove: (issueId: string) => void,
): void {
  const now = new Map(candidates.map((c) => [c.id, c.state]));
  for (const [id, p] of state.parked) {
    const at = now.get(id);
    if (at !== undefined && norm(at) === norm(p.state)) continue;
    state.parked.delete(id);
    remove(id);
  }
}

/** Parks a card the agent left a note on. */
export function parkCard(
  state: OrchestratorState,
  issue: NormalizedIssue,
  note: ParkNote,
  store?: ParkingStore,
): ParkedCard {
  const card: ParkedCard = {
    issueId: issue.id,
    identifier: issue.identifier,
    state: issue.state,
    next: note.next,
    line: note.line,
    parkedAt: new Date().toISOString(),
  };
  state.parked.set(issue.id, card);
  store?.put(card);
  return card;
}

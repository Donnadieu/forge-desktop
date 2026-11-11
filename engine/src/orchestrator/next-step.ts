/**
 * Next step: from the Orchestrator, the person picks a card's next stage (AI
 * review, QA, human review, rework, merge), and Forge runs it now, column or
 * not. A stage the board has a column for moves the card there, and the
 * pipeline carries on. A stage with no column runs here: the card leaves
 * parking for one run whose prompt says which step to do; it stays in its
 * column on the board and parks again when the step is done
 * (orchestrator/parking.ts). Human review with no column just keeps the card
 * waiting on the person.
 *
 * New in Forge Desktop.
 */
import type { BoardColumns } from "../tracker/board-columns.js";
import type { NormalizedIssue, TrackerAdapter } from "../tracker/types.js";
import type { ParkingStore } from "./parking.js";
import type { OrchestratorState } from "./types.js";

/** The only moves Next step offers: stages, never other skills. */
export const NEXT_STEPS = ["AI Review", "QA", "Human Review", "Rework", "Merging"];

/** Where a step waiting to run is kept across restarts (forge.sqlite). */
export interface StageRunStore {
  list(): Array<{ issueId: string; stage: string }>;
  put(issueId: string, stage: string): void;
  remove(issueId: string): void;
}

export interface NextStepDeps {
  state: OrchestratorState;
  tracker: TrackerAdapter;
  columns: BoardColumns;
  activeStates: string[];
  parking?: ParkingStore;
  stageRuns?: StageRunStore;
}

export type NextStepResult =
  | { ok: true; ran: "moved" | "here" | "waiting" }
  | { ok: false; problem: string };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

function unpark(deps: NextStepDeps, issueId: string): void {
  deps.state.parked.delete(issueId);
  deps.parking?.remove(issueId);
}

export async function takeNextStep(
  deps: NextStepDeps,
  issue: NormalizedIssue,
  stage: string,
): Promise<NextStepResult> {
  const step = NEXT_STEPS.find((s) => norm(s) === norm(stage));
  if (!step) return { ok: false, problem: `${stage} isn't a step Forge can run.` };
  if (!(await deps.columns.missing(step))) {
    if (!deps.tracker.updateIssueState)
      return { ok: false, problem: "This board can't move cards." };
    try {
      await deps.tracker.updateIssueState(issue.id, step);
    } catch (err) {
      return { ok: false, problem: err instanceof Error ? err.message : String(err) };
    }
    unpark(deps, issue.id);
    return { ok: true, ran: "moved" };
  }
  // Human review is the person's own step: with no column, the card just keeps waiting on them.
  if (step === "Human Review") return { ok: true, ran: "waiting" };
  if (!deps.activeStates.some((s) => norm(s) === norm(issue.state))) {
    const where = deps.activeStates.filter((s) => s !== "Triage").join(" or ");
    return { ok: false, problem: `Forge runs ${step} here only on cards in ${where}.` };
  }
  deps.state.stageRuns.set(issue.id, step);
  deps.stageRuns?.put(issue.id, step);
  unpark(deps, issue.id);
  return { ok: true, ran: "here" };
}

/** What the lead is told on top of its usual instructions when the person picked a step with no column. */
export function stageRunNote(stage: string): string {
  return [
    "",
    "",
    "## Forge: run one step now",
    "",
    `The person picked the next step for this ticket. Run the \`${stage}\` step on this ticket now, following this`,
    `workflow's \`${stage}\` steps as if the ticket were in \`${stage}\`. This board has no \`${stage}\` column, so`,
    "leave the ticket in its current column and never move it into a column the board doesn't have.",
    stage === "Merging"
      ? "When the pull request is merged, move the ticket to `Done`."
      : "When the step is done, park it again (Parking: waiting on the person), with the next stage in `next`.",
  ].join("\n");
}

/** The prompt for a card's run: with the step the person picked (once), else unchanged. */
export function promptWithStageRun(
  state: OrchestratorState,
  issueId: string,
  base: string,
  remove: (issueId: string) => void,
): string {
  const stage = state.stageRuns.get(issueId);
  if (!stage) return base;
  state.stageRuns.delete(issueId);
  remove(issueId);
  return base + stageRunNote(stage);
}

import type { Logger } from "pino";
import type { TokenTotals } from "../telemetry/types.js";
import type { NormalizedIssue, TrackerAdapter } from "../tracker/types.js";
import type { WorkerResult } from "./runner.js";

/**
 * Result of verifying whether an issue is still in an active state between
 * worker turns.
 */
export interface StateCheckResult {
  /** True when the issue is known to still be in an active state. */
  stillActive: boolean;
  /** True when the failure policy decided the worker should abort. */
  abort: boolean;
  /** Human-readable reason when abort is true. */
  error?: string;
}

export interface AbortContext {
  turns: number;
  tokens: TokenTotals;
  workspacePath: string;
  preserveWorkspace: boolean;
}

/**
 * Tracks consecutive failures when asking the tracker whether an issue is still
 * active, and decides when to keep retrying versus aborting the worker run.
 *
 * Policy: tolerate transient tracker errors up to `maxRetries` consecutive
 * failures. Each failure is logged. On a successful check the counter resets.
 * Once the threshold is exceeded the worker aborts with a failure result so it
 * does not keep running turns on an issue that may have been cancelled or
 * moved to a non-active state.
 */
export class IssueStateChecker {
  private consecutiveFailures = 0;

  constructor(private readonly maxRetries: number) {
    if (maxRetries < 1) {
      throw new RangeError("maxRetries must be at least 1");
    }
  }

  /**
   * Ask the tracker for the issue's current state and apply the retry/abort
   * policy. Returns `null` when the issue is still active, `"break"` when it is
   * known to be inactive, or a `WorkerResult` when the failure threshold was
   * exceeded and the worker must abort.
   */
  async decide(
    tracker: TrackerAdapter,
    issue: NormalizedIssue,
    activeStates: string[],
    logger: Logger,
    abortContext: AbortContext,
  ): Promise<WorkerResult | "break" | null> {
    const result = await this.check(tracker, issue, activeStates, logger);
    if (result.stillActive) return null;
    if (result.abort) {
      return {
        issueId: issue.id,
        ...abortContext,
        success: false,
        error: result.error,
      };
    }
    return "break";
  }

  /**
   * Ask the tracker for the issue's current state and apply the retry/abort
   * policy when the tracker call fails.
   */
  async check(
    tracker: TrackerAdapter,
    issue: NormalizedIssue,
    activeStates: string[],
    logger: Logger,
  ): Promise<StateCheckResult> {
    try {
      const currentStates = await tracker.fetchIssueStatesByIds([issue.id]);
      const currentState = currentStates.get(issue.id);
      this.consecutiveFailures = 0;

      if (currentState !== undefined && !activeStates.includes(currentState)) {
        return { stillActive: false, abort: false };
      }
      return { stillActive: true, abort: false };
    } catch (error) {
      this.consecutiveFailures++;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.warn(
        {
          issueId: issue.id,
          identifier: issue.identifier,
          error: errorMessage,
          consecutiveFailures: this.consecutiveFailures,
          maxRetries: this.maxRetries,
        },
        "Issue state check failed between turns; assuming still active and continuing",
      );

      if (this.consecutiveFailures >= this.maxRetries) {
        const abortMessage = `Aborting worker after ${this.consecutiveFailures} consecutive issue state check failures: ${errorMessage}`;
        logger.error(
          {
            issueId: issue.id,
            identifier: issue.identifier,
            consecutiveFailures: this.consecutiveFailures,
            maxRetries: this.maxRetries,
          },
          abortMessage,
        );
        return { stillActive: false, abort: true, error: abortMessage };
      }

      return { stillActive: true, abort: false };
    }
  }
}

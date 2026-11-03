/**
 * Per-build runaway-cost ceiling (FRG-958).
 *
 * The orchestrator accumulates LLM token usage into `state.totalTokens` as
 * `usage` events stream in (see turn-telemetry.ts). Without a ceiling a
 * runaway build can consume tokens unbounded and blow past cost targets.
 *
 * This module is pure: it converts accumulated tokens to an estimated USD
 * spend and decides whether a configured per-build cap has been exceeded. The
 * orchestrator owns the side effects (aborting workers / stopping the run).
 */

/** Default list pricing (USD per 1M tokens) — Claude Sonnet-class rates. */
export const DEFAULT_INPUT_USD_PER_MTOK = 3;
export const DEFAULT_OUTPUT_USD_PER_MTOK = 15;

export interface CostCeilingConfig {
  /**
   * Hard per-build spend ceiling in USD. `0` (or any non-positive value)
   * disables enforcement entirely so existing builds are unaffected.
   */
  maxBuildUsd: number;
  /** USD per 1M input tokens used for the estimate. */
  inputUsdPerMtok: number;
  /** USD per 1M output tokens used for the estimate. */
  outputUsdPerMtok: number;
}

export interface TokenTotals {
  input: number;
  output: number;
}

/**
 * Deterministic token→USD estimate. Negative/NaN token counts are treated as
 * zero so a malformed usage event can never under- or over-shoot the cap in a
 * surprising direction.
 */
export function estimateSpendUsd(tokens: TokenTotals, config: CostCeilingConfig): number {
  const input = Number.isFinite(tokens.input) && tokens.input > 0 ? tokens.input : 0;
  const output = Number.isFinite(tokens.output) && tokens.output > 0 ? tokens.output : 0;
  return (
    (input / 1_000_000) * config.inputUsdPerMtok + (output / 1_000_000) * config.outputUsdPerMtok
  );
}

export interface CostCeilingEvaluation {
  /** True only when enforcement is enabled AND the estimate is over the cap. */
  exceeded: boolean;
  /** Estimated spend in USD for the supplied token totals. */
  spendUsd: number;
  /** Echoed cap for logging/telemetry; <= 0 means disabled. */
  maxBuildUsd: number;
}

/**
 * Evaluate accumulated token usage against the configured ceiling.
 * Enforcement is opt-in: a non-positive `maxBuildUsd` always reports
 * `exceeded: false`.
 */
export function evaluateCostCeiling(
  tokens: TokenTotals,
  config: CostCeilingConfig,
): CostCeilingEvaluation {
  const spendUsd = estimateSpendUsd(tokens, config);
  const enabled = Number.isFinite(config.maxBuildUsd) && config.maxBuildUsd > 0;
  return {
    exceeded: enabled && spendUsd > config.maxBuildUsd,
    spendUsd,
    maxBuildUsd: config.maxBuildUsd,
  };
}

/** Snake-case cost config as it appears in the workflow config schema. */
export interface WorkflowCostConfig {
  max_build_usd: number;
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
}

export interface ResolveCostCeilingOptions {
  logger?: { warn: (obj: unknown, msg: string) => void };
}

/**
 * Resolve the orchestrator's `CostCeilingConfig` from workflow config, letting
 * `FORGE_MAX_BUILD_USD` override the ceiling so an operator can clamp a hot
 * run without redeploying config. A non-positive result disables enforcement.
 *
 * Env-parsing contract:
 * - Unset, empty string, or whitespace-only → use the workflow config value
 *   (an exported-but-empty env var must not silently disable enforcement).
 * - Non-numeric / `NaN` → warn loudly and fall back to the config value
 *   (silent disable on operator typo would defeat the whole safety net).
 * - Valid number → override.
 */
export function resolveCostCeiling(
  cost: WorkflowCostConfig,
  options: ResolveCostCeilingOptions = {},
): CostCeilingConfig {
  const raw = process.env.FORGE_MAX_BUILD_USD;
  let maxBuildUsd = cost.max_build_usd;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      maxBuildUsd = parsed;
    } else {
      options.logger?.warn(
        { value: raw, fallback: cost.max_build_usd },
        "FORGE_MAX_BUILD_USD is not a valid number — falling back to workflow config cost.max_build_usd",
      );
    }
  }
  return {
    maxBuildUsd,
    inputUsdPerMtok: cost.input_usd_per_mtok,
    outputUsdPerMtok: cost.output_usd_per_mtok,
  };
}

/**
 * Side-effecting deps the orchestrator hands to {@link enforceCostCeiling} so
 * the abort orchestration lives here rather than inflating orchestrator.ts.
 */
export interface CostCeilingGuardDeps {
  tokens: TokenTotals;
  ceiling: CostCeilingConfig | undefined;
  alreadyTripped: boolean;
  buildReportGenerated: boolean;
  logger?: { error: (obj: unknown, msg: string) => void };
  onExceeded?: (info: {
    spendUsd: number;
    maxBuildUsd: number;
    tokens: { input: number; output: number };
  }) => void;
  onBuildComplete?: (report: { success: boolean; data: null }) => void;
  killWorker: (issueId: string) => void;
  runningIssueIds: () => string[];
  stop: () => void;
}

/**
 * Decide whether the per-build runaway-cost ceiling (FRG-958) has tripped and,
 * if so, abort the build: kill in-flight workers, stop the run, and surface a
 * failed build exactly once. Returns an action report the orchestrator applies
 * to its own latching flags.
 */
export function enforceCostCeiling(deps: CostCeilingGuardDeps): {
  tripped: boolean;
  markTripped: boolean;
  markBuildReportGenerated: boolean;
} {
  if (deps.alreadyTripped)
    return { tripped: true, markTripped: false, markBuildReportGenerated: false };
  if (!deps.ceiling) return { tripped: false, markTripped: false, markBuildReportGenerated: false };
  const { exceeded, spendUsd, maxBuildUsd } = evaluateCostCeiling(deps.tokens, deps.ceiling);
  if (!exceeded) return { tripped: false, markTripped: false, markBuildReportGenerated: false };

  const tokens = { ...deps.tokens };
  deps.logger?.error(
    { spendUsd, maxBuildUsd, tokens },
    `Per-build cost ceiling exceeded ($${spendUsd.toFixed(2)} > $${maxBuildUsd.toFixed(2)}) — aborting build`,
  );
  try {
    deps.onExceeded?.({ spendUsd, maxBuildUsd, tokens });
  } catch {
    // Defensive: a telemetry hook must never block the abort path.
  }
  // Abort in-flight workers immediately (not a graceful drain — the whole
  // point is to stop spending). killWorker records killed-ticket telemetry
  // before aborting so the timeline isn't lost.
  for (const issueId of deps.runningIssueIds()) {
    deps.killWorker(issueId);
  }
  deps.stop();
  // Surface as a failed build exactly once so the run finalizes/exits via the
  // same path as a normal end-of-build.
  const markBuildReportGenerated = !deps.buildReportGenerated;
  if (markBuildReportGenerated) {
    deps.onBuildComplete?.({ success: false, data: null });
  }
  return { tripped: true, markTripped: true, markBuildReportGenerated };
}

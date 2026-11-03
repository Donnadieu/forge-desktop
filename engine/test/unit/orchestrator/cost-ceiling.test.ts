import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CostCeilingConfig,
  estimateSpendUsd,
  evaluateCostCeiling,
  resolveCostCeiling,
  type WorkflowCostConfig,
} from "../../../src/orchestrator/cost-ceiling.js";

const RATES: CostCeilingConfig = {
  maxBuildUsd: 10,
  inputUsdPerMtok: 3,
  outputUsdPerMtok: 15,
};

describe("estimateSpendUsd", () => {
  it("computes USD from input + output tokens", () => {
    // 1M input @ $3 + 1M output @ $15 = $18
    expect(estimateSpendUsd({ input: 1_000_000, output: 1_000_000 }, RATES)).toBeCloseTo(18);
  });

  it("returns 0 for zero usage", () => {
    expect(estimateSpendUsd({ input: 0, output: 0 }, RATES)).toBe(0);
  });

  it("clamps negative / NaN token counts to zero", () => {
    expect(estimateSpendUsd({ input: -500, output: Number.NaN }, RATES)).toBe(0);
  });
});

describe("evaluateCostCeiling", () => {
  it("is disabled when maxBuildUsd <= 0 (backward compatible)", () => {
    const huge = { input: 1_000_000_000, output: 1_000_000_000 };
    const r = evaluateCostCeiling(huge, { ...RATES, maxBuildUsd: 0 });
    expect(r.exceeded).toBe(false);
    expect(r.spendUsd).toBeGreaterThan(0);
  });

  it("does not trip below the ceiling", () => {
    // ~$1.80 spend, cap $10
    const r = evaluateCostCeiling({ input: 100_000, output: 100_000 }, RATES);
    expect(r.exceeded).toBe(false);
  });

  it("does not trip exactly at the ceiling (strictly greater)", () => {
    // input only: maxBuildUsd 9 means 3M input tokens = exactly $9
    const r = evaluateCostCeiling({ input: 3_000_000, output: 0 }, { ...RATES, maxBuildUsd: 9 });
    expect(r.spendUsd).toBeCloseTo(9);
    expect(r.exceeded).toBe(false);
  });

  it("trips when estimated spend exceeds the ceiling", () => {
    const r = evaluateCostCeiling({ input: 5_000_000, output: 0 }, RATES);
    expect(r.spendUsd).toBeCloseTo(15);
    expect(r.exceeded).toBe(true);
    expect(r.maxBuildUsd).toBe(10);
  });

  it("treats a NaN ceiling as disabled", () => {
    const r = evaluateCostCeiling(
      { input: 9_000_000_000, output: 0 },
      {
        ...RATES,
        maxBuildUsd: Number.NaN,
      },
    );
    expect(r.exceeded).toBe(false);
  });
});

describe("resolveCostCeiling — FORGE_MAX_BUILD_USD parsing", () => {
  const CONFIG: WorkflowCostConfig = {
    max_build_usd: 25,
    input_usd_per_mtok: 3,
    output_usd_per_mtok: 15,
  };
  const ORIGINAL_ENV = process.env.FORGE_MAX_BUILD_USD;

  beforeEach(() => {
    process.env.FORGE_MAX_BUILD_USD = undefined;
    delete process.env.FORGE_MAX_BUILD_USD;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.FORGE_MAX_BUILD_USD;
    else process.env.FORGE_MAX_BUILD_USD = ORIGINAL_ENV;
  });

  it("uses the workflow config value when env is unset", () => {
    expect(resolveCostCeiling(CONFIG).maxBuildUsd).toBe(25);
  });

  it("uses the workflow config value when env is empty string (exported-but-empty)", () => {
    process.env.FORGE_MAX_BUILD_USD = "";
    const warn = vi.fn();
    expect(resolveCostCeiling(CONFIG, { logger: { warn } }).maxBuildUsd).toBe(25);
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses the workflow config value when env is whitespace-only", () => {
    process.env.FORGE_MAX_BUILD_USD = "   ";
    expect(resolveCostCeiling(CONFIG).maxBuildUsd).toBe(25);
  });

  it("overrides config with a valid numeric env value", () => {
    process.env.FORGE_MAX_BUILD_USD = "7.5";
    expect(resolveCostCeiling(CONFIG).maxBuildUsd).toBe(7.5);
  });

  it("warns and falls back to config when env is non-numeric (does not silently disable)", () => {
    process.env.FORGE_MAX_BUILD_USD = "5O"; // letter O typo
    const warn = vi.fn();
    expect(resolveCostCeiling(CONFIG, { logger: { warn } }).maxBuildUsd).toBe(25);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ value: "5O", fallback: 25 });
  });

  it("allows an explicit env value of 0 to disable enforcement", () => {
    process.env.FORGE_MAX_BUILD_USD = "0";
    expect(resolveCostCeiling(CONFIG).maxBuildUsd).toBe(0);
  });
});

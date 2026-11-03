import { describe, expect, it } from "vitest";
import {
  AGENT_KINDS,
  AGENT_KINDS_WITH_CUSTOM,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  getProviderConfig,
  isAgentKind,
  isSupportedModel,
  isWiredProvider,
  PROVIDER_IDS,
  PROVIDER_KEY_VARS,
  PROVIDERS,
  supportedModel,
  WIRED_PROVIDER_IDS,
} from "../../../src/config/providers.js";

describe("provider registry", () => {
  it("exports a provider for every canonical id", () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(PROVIDER_IDS);
  });

  it("contains exactly the v1 providers", () => {
    expect(PROVIDER_IDS).toEqual([
      "anthropic",
      "openai",
      "openrouter",
      "openai-compatible",
      "kimi-coding",
      "claude-subscription",
      "custom",
    ]);
  });

  it("maps providers to their canonical API-key env vars", () => {
    expect(PROVIDER_KEY_VARS.anthropic).toBe("ANTHROPIC_API_KEY");
    expect(PROVIDER_KEY_VARS.openai).toBe("OPENAI_API_KEY");
    expect(PROVIDER_KEY_VARS.openrouter).toBe("OPENROUTER_API_KEY");
    expect(PROVIDER_KEY_VARS["openai-compatible"]).toBe("XIAOMI_MIMO_API_KEY");
    expect(PROVIDER_KEY_VARS["kimi-coding"]).toBe("KIMI_API_KEY");
    expect(PROVIDER_KEY_VARS.custom).toBeUndefined();
  });

  it("lists only wired providers (excludes dead custom enum)", () => {
    expect(WIRED_PROVIDER_IDS).toEqual([
      "anthropic",
      "openai",
      "openrouter",
      "openai-compatible",
      "kimi-coding",
      "claude-subscription",
    ]);
    expect(WIRED_PROVIDER_IDS).not.toContain("custom");
  });

  it("exposes runtime agent kinds without the dead custom enum", () => {
    expect(AGENT_KINDS).toEqual(["claude", "codex", "hermes", "mimo", "kimi"]);
    expect(AGENT_KINDS_WITH_CUSTOM).toEqual([...AGENT_KINDS, "custom"]);
  });

  it("maps providers to their fixed agent kinds", () => {
    expect(getProviderConfig("anthropic")?.agentKind).toBe("claude");
    expect(getProviderConfig("openai")?.agentKind).toBe("codex");
    expect(getProviderConfig("kimi-coding")?.agentKind).toBe("kimi");
    expect(getProviderConfig("openai-compatible")?.agentKind).toBe("mimo");
    expect(getProviderConfig("openrouter")?.agentKind).toBeUndefined();
    expect(getProviderConfig("custom")?.agentKind).toBeUndefined();
  });

  it("returns undefined for unknown provider ids", () => {
    // @ts-expect-error intentional unknown id test
    expect(getProviderConfig("gpt-cloud")).toBeUndefined();
  });

  it("identifies wired providers", () => {
    expect(isWiredProvider("anthropic")).toBe(true);
    expect(isWiredProvider("kimi-coding")).toBe(true);
    expect(isWiredProvider("custom")).toBe(false);
    expect(isWiredProvider("gpt-cloud")).toBe(false);
  });

  it("identifies known agent kinds", () => {
    expect(isAgentKind("claude")).toBe(true);
    expect(isAgentKind("kimi")).toBe(true);
    expect(isAgentKind("custom")).toBe(false);
    expect(isAgentKind("unknown")).toBe(false);
  });

  it("keeps custom as a dead enum with no runtime wiring", () => {
    const custom = getProviderConfig("custom");
    expect(custom).toBeDefined();
    expect(custom?.keyEnvVar).toBeUndefined();
    expect(custom?.defaultBaseUrl).toBeUndefined();
    expect(custom?.agentKind).toBeUndefined();
    expect(custom?.chatCapable).toBe(false);
    expect(custom?.models).toEqual([]);
    expect(custom?.validationProbe).toBeUndefined();
  });
});

describe("supported models (FRG-4079)", () => {
  // The registry list is the one source of truth for which models run.
  it("supports exactly the listed ids of a curated provider", () => {
    expect(isSupportedModel("anthropic", "claude-opus-5")).toBe(true);
    expect(isSupportedModel("anthropic", " claude-opus-5 ")).toBe(true);
    expect(isSupportedModel("anthropic", "claude-sonnet-4-20250514")).toBe(false);
    expect(isSupportedModel("anthropic", "")).toBe(false);
    expect(isSupportedModel("anthropic", null)).toBe(false);
  });

  it("supports any non-empty id of an open-ended provider", () => {
    expect(isSupportedModel("openrouter", "anthropic/claude-sonnet-5")).toBe(true);
    expect(isSupportedModel("openrouter", "  ")).toBe(false);
  });

  it("resolves an off-list id to the provider default", () => {
    expect(supportedModel("anthropic", "claude-opus-5")).toBe("claude-opus-5");
    expect(supportedModel("anthropic", "claude-sonnet-4-20250514")).toBe("claude-sonnet-5");
    expect(supportedModel("anthropic", null)).toBe("claude-sonnet-5");
    expect(supportedModel("openrouter", "x/y")).toBe("x/y");
    expect(supportedModel("openrouter", null)).toBeUndefined();
    expect(supportedModel("nope", "x")).toBeUndefined();
  });
});

describe("Claude subscription provider (FRG-2078)", () => {
  it("is a CLI-only OAuth-token provider with no HTTP chat endpoint", () => {
    const cfg = getProviderConfig(CLAUDE_SUBSCRIPTION_PROVIDER_ID);
    expect(cfg.keyEnvVar).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(cfg.agentKind).toBe("claude");
    expect(cfg.chatCapable).toBe(false);
    expect(cfg.chatBaseUrl).toBeUndefined();
    expect(cfg.models).toEqual([
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-fable-5-1",
    ]);
  });
});

import { z } from "zod";
import { cleanCustomBaseUrl } from "./custom-base-url.js";
import { PROVIDERS } from "./provider-table.js";

/**
 * Canonical provider registry (v1).
 *
 * Single source of truth for the providers Forge actually wires today.
 * Nothing net-new is added here; the registry just centralises metadata that
 * previously drifted across TypeScript and Python copies.
 */

/** Provider ids wired in the v1 product surface. */
export const PROVIDER_IDS = [
  "anthropic",
  "openai",
  "openrouter",
  "openai-compatible",
  "kimi-coding",
  "claude-subscription",
  "custom",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Agent kinds the factory/Smith runtime can actually spawn. */
export const AGENT_KINDS = ["claude", "codex", "hermes", "mimo", "kimi"] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

/** Agent kinds exposed in workflow-config schema, including the dead `custom` enum. */
export const AGENT_KINDS_WITH_CUSTOM = [...AGENT_KINDS, "custom"] as const;

export type AgentKindWithCustom = (typeof AGENT_KINDS_WITH_CUSTOM)[number];

/**
 * How a provider's `validationProbe` authenticates the credential:
 * `x-api-key` (Anthropic API key + `anthropic-version`), `bearer` (OpenAI wire)
 * or `bearer-oauth` (a `claude setup-token` OAuth token: Bearer + the Anthropic
 * OAuth beta header). The Python gateway builds the probe headers from it
 * (`provider_registry.probe_headers`) instead of branching on provider id.
 */
export type ProbeAuth = "x-api-key" | "bearer" | "bearer-oauth";

/** A registry provider's ModelRouter adapter kind (`createLLMAdapter`). */
export type AdapterKind =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "openai-compatible"
  | "claude-cli"
  | "custom";

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  /** Canonical API-key env var. Undefined for the dead `custom` enum. */
  keyEnvVar: string | undefined;
  /**
   * The API ORIGIN the key-validation probe is appended to (`validationProbe`
   * already carries its own `/v1/...`), so it never ends in `/v1`. Undefined
   * when there is no public endpoint to probe.
   */
  defaultBaseUrl: string | undefined;
  /**
   * The SDK ROOT an LLM *client* is constructed with, which is NOT
   * `defaultBaseUrl`: an SDK joins its own path onto whatever base it is
   * handed, so an OpenAI-wire provider needs the `/v1` segment baked in here
   * while the Anthropic SDK wants the bare host (it appends `/v1/messages`
   * itself). Undefined when the endpoint can only come from the environment.
   * The `/v1` convention is settled in this direction (FRG-2089): every value
   * a runtime is handed — `FORGE_SMITH_REASONING_BASE_URL`, the ModelRouter's
   * base URL, the factory chat agent — is this SDK root, never the probe
   * origin. `start-forgesmith.sh`'s legacy per-provider fallback mirrors it
   * (pinned by forgesmith-base-url-lockstep.test.ts).
   */
  chatBaseUrl: string | undefined;
  /** Fixed agent kind when a provider maps to exactly one runtime agent. */
  agentKind: AgentKind | undefined;
  /**
   * Chat runs on this provider over an HTTP chat endpoint with a key, so it can
   * take a custom base URL and be the platform factory model
   * (`FORGE_FACTORY_MODEL_PROVIDER`). False for the Claude subscription,
   * which has no chat endpoint — yet factory chat still runs on it under BYOK,
   * through the Claude Code CLI with the user's own token (FRG-2903, FRG-4541).
   * Whether factory chat can run on a vault row is `serves_factory_chat` in
   * scripts/provider_registry.py, served as the `chat_capable` field of
   * `/api/v1/me/providers` rows.
   */
  chatCapable: boolean;
  /**
   * The models this provider supports — the one source of truth: writes reject
   * any other id and reads heal a stored off-list id to `models[0]`, the
   * default (FRG-4079). Empty = open-ended: any id (a routing layer).
   */
  models: string[];
  /** Authenticated probe path (appended to defaultBaseUrl) that 401s on a bad key; undefined when not applicable. */
  validationProbe: string | undefined;
  /** Auth scheme for `validationProbe`; undefined exactly when there is no probe. */
  probeAuth: ProbeAuth | undefined;
  /** An `api_key`, or an `oauth_token` only the Claude Code CLI may spend: personal
   *  (BYOK-only), never sent to an HTTP endpoint. Served on vault rows (FRG-3011). */
  credentialKind: "api_key" | "oauth_token";
  /**
   * The prefix every credential of this provider starts with, when the vendor
   * stamps one that tells it apart from a sibling's (an Anthropic API key vs a
   * `claude setup-token` OAuth token). The one source of the prefix: the
   * wrong-slot check, the subscription chat's token test and the UI
   * placeholder read it. Served on vault rows (FRG-5463).
   */
  credentialPrefix: string | undefined;
  /** The ModelRouter's LLM adapter kind (`createLLMAdapter`). */
  adapterKind: AdapterKind;
  /** The provider id Hermes registers this provider under (its `AIAgent` provider). */
  hermesProviderId: string;
}

export { PROVIDERS };

/** Provider id lookup by exact id; throws for unknown ids. */
export function getProviderConfig(id: ProviderId): ProviderConfig;
/** Provider id lookup with a fallback for unknown string ids. */
export function getProviderConfig(id: string): ProviderConfig | undefined;
export function getProviderConfig(id: string): ProviderConfig | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Whether `provider` supports `model`. The registry's `models` list is the one
 * source of truth: a curated provider supports exactly the ids it lists, so an
 * id that falls off the list (e.g. one Anthropic retired, FRG-4079) is simply
 * unsupported. An open-ended provider (empty list, e.g. OpenRouter) takes any
 * non-empty id; an unknown provider supports nothing. Mirrors
 * `is_supported_model` in scripts/provider_registry.py.
 */
export function isSupportedModel(provider: string, model: string | null | undefined): boolean {
  const config = getProviderConfig(provider);
  if (!config) return false;
  const id = model?.trim() ?? "";
  return config.models.length === 0 ? id !== "" : config.models.includes(id);
}

/**
 * The model to run for `provider`: `model` when supported, else the provider's
 * default (`models[0]`), so a stored id that fell off the list heals on read
 * instead of failing every call. Undefined when nothing is runnable (an
 * open-ended provider with no id). Mirrors `supported_model` in
 * scripts/provider_registry.py.
 */
export function supportedModel(
  provider: string,
  model: string | null | undefined,
): string | undefined {
  if (isSupportedModel(provider, model)) return model?.trim();
  return getProviderConfig(provider)?.models[0];
}

/** Map of provider id → canonical API-key env var (excluding dead `custom`). */
export const PROVIDER_KEY_VARS: Record<ProviderId, string | undefined> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p.keyEnvVar]),
) as Record<ProviderId, string | undefined>;

/** Zod schemas derived from the canonical registry. */
export const ProviderIdSchema = z.enum(PROVIDER_IDS);
export const AgentKindSchema = z.enum(AGENT_KINDS);
export const AgentKindWithCustomSchema = z.enum(AGENT_KINDS_WITH_CUSTOM);

/** Provider ids that have a runtime API-key env var. */
export const WIRED_PROVIDER_IDS: readonly string[] = PROVIDERS.filter(
  (p) => p.keyEnvVar !== undefined,
).map((p) => p.id);

/** Type guard for a runtime-wired provider id. */
export function isWiredProvider(id: string): id is Exclude<ProviderId, "custom"> {
  return WIRED_PROVIDER_IDS.includes(id);
}

/**
 * The base URL a ModelRouter is built with for `provider`: the SDK root
 * (`chatBaseUrl`), else the probe origin for a provider whose runtime never
 * calls the API directly (claude-subscription runs on `claude --print`, but the
 * router still requires a non-empty base URL). Undefined only for providers
 * with no public endpoint at all (openai-compatible, custom). Mirrors
 * `router_base_url` in scripts/provider_registry.py.
 */
export function routerBaseUrl(provider: ProviderConfig | undefined): string | undefined {
  return provider?.chatBaseUrl ?? provider?.defaultBaseUrl;
}

/**
 * Whether an owner may point `provider` at their own base URL (a per-app
 * `smith_base_url`, FRG-2089): only a chat-capable provider with no registry
 * endpoint of its own (openai-compatible). A vendor provider keeps its
 * registry URL, because only the reasoning half of the Smith reads the base
 * URL — its key also drives consumers that don't (the kimi-code build worker,
 * Hermes delegation, the adapter's Moonshot detection), which would send a
 * gateway key to the vendor. The subscription's token is only ever spent by
 * the official CLI, which takes no endpoint. Mirrors `accepts_custom_base_url`
 * in scripts/provider_registry.py.
 */
export function acceptsCustomBaseUrl(provider: ProviderConfig | undefined): boolean {
  return provider?.chatCapable === true && routerBaseUrl(provider) === undefined;
}

export { cleanCustomBaseUrl, MAX_CUSTOM_BASE_URL_LEN } from "./custom-base-url.js";

/**
 * The endpoint a stored credential for `provider` runs on, or undefined when no
 * runtime can route it (FRG-5470): the row's own URL, cleaned, for a provider
 * that takes one (openai-compatible, FRG-4318), else the registry's
 * (`routerBaseUrl`). A stray row URL on a vendor provider is ignored — a vendor
 * key is only ever spent at its vendor. Mirrors `credential_base_url` in
 * scripts/provider_registry.py.
 */
export function credentialBaseUrl(
  provider: ProviderConfig | undefined,
  rowBaseUrl: unknown,
): string | undefined {
  if (acceptsCustomBaseUrl(provider)) return cleanCustomBaseUrl(rowBaseUrl) ?? undefined;
  return routerBaseUrl(provider);
}

/**
 * Providers an owner may select for a Smith (per-app BYOK config, FRG-2072).
 * The Smith's MCP router requires a non-empty base URL, so a provider needs
 * either a registry one (`routerBaseUrl`) or the ability to take the owner's
 * (`acceptsCustomBaseUrl` — openai-compatible, whose apps must then carry a
 * `smith_base_url`, FRG-2089). Mirrors SMITH_CONFIGURABLE_PROVIDER_IDS in
 * scripts/provider_registry.py (providers-lockstep.test.ts).
 */
export const SMITH_CONFIGURABLE_PROVIDER_IDS: readonly string[] = PROVIDERS.filter(
  (p) => p.keyEnvVar !== undefined && (routerBaseUrl(p) !== undefined || acceptsCustomBaseUrl(p)),
).map((p) => p.id);

/**
 * Providers a user can connect a key for today (the BYOK vault): runtime-wired
 * AND probe-able, because the live ping is mandatory before a key is accepted,
 * AND routable: a registry base URL, or (FRG-4318) the user's own, stored
 * beside the key, for a provider that takes one (`acceptsCustomBaseUrl` —
 * openai-compatible, probed at `<baseUrl>/models`). Mirrors
 * CONNECTABLE_PROVIDER_IDS in scripts/provider_registry.py
 * (providers-lockstep.test.ts).
 */
export const CONNECTABLE_PROVIDER_IDS: readonly string[] = PROVIDERS.filter(
  (p) =>
    p.keyEnvVar !== undefined &&
    p.validationProbe !== undefined &&
    (p.defaultBaseUrl !== undefined || acceptsCustomBaseUrl(p)),
).map((p) => p.id);

/** Type guard for a provider an owner may select for a Smith. */
export function isSmithConfigurableProvider(id: string): id is Exclude<ProviderId, "custom"> {
  return SMITH_CONFIGURABLE_PROVIDER_IDS.includes(id);
}

/** Claude subscription provider (FRG-2078). Behaviour keys on registry attributes
 *  (`credentialKind`, `adapterKind`, `hermesProviderId`), never on this id. */
export const CLAUDE_SUBSCRIPTION_PROVIDER_ID = "claude-subscription";

/** Whether `provider`'s credential is an OAuth token only the Claude Code CLI may spend. */
export function usesOAuthToken(provider: string): boolean {
  return getProviderConfig(provider)?.credentialKind === "oauth_token";
}

/**
 * Whether `provider` runs on the Claude Code CLI (`adapterKind: "claude-cli"`),
 * so it needs the Claude-specific plumbing: Hermes' Claude subscription plugin
 * in the image and the CLI's own env. Claude-scoped by name, unlike
 * `usesOAuthToken`, which only says what the credential may be used for.
 */
export function usesClaudeCli(provider: string): boolean {
  return getProviderConfig(provider)?.adapterKind === "claude-cli";
}

/**
 * Env vars that make Claude Code authenticate with something other than the
 * OAuth token (an API key wins over `CLAUDE_CODE_OAUTH_TOKEN`) or talk to
 * another backend. A subscription child must not inherit them: the platform
 * `ANTHROPIC_API_KEY` would silently bill the platform, and the Hermes plugin
 * refuses to run while any is set. Canonical list; `src/agent/claude-env.ts`
 * keeps the runtime copy (`agent/` imports only the `config/model-id.ts` leaf).
 */
export const CLAUDE_AUTH_OVERRIDE_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/** Type guard for a known runtime agent kind. */
export function isAgentKind(kind: string): kind is AgentKind {
  return AGENT_KINDS.includes(kind as AgentKind);
}

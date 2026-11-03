import { bareModelId } from "../config/model-id.js";

/**
 * Env vars that outrank a Claude subscription's `CLAUDE_CODE_OAUTH_TOKEN`
 * inside Claude Code (FRG-2078). Mirrors `CLAUDE_AUTH_OVERRIDE_VARS` in
 * `src/config/providers.ts` — kept as a local copy so `agent/` stays off the
 * `config/` barrel — pinned by test/unit/agent/claude.test.ts.
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

/**
 * The registry's one Claude-CLI provider (`adapterKind: "claude-cli"` in
 * `src/config/provider-table.ts`; kept local so `agent/` stays off the
 * `config/` barrel). Pinned by test/unit/config/provider-attribute-pins.test.ts.
 */
export const CLAUDE_SUBSCRIPTION_PROVIDER_ID = "claude-subscription";

/**
 * OpenRouter's Anthropic-compatible root, which Claude Code appends
 * `/v1/messages` to (FRG-4085). Mirrors the openrouter registry entry's
 * `defaultBaseUrl` in `src/config/providers.ts`, pinned by
 * test/unit/agent/claude.test.ts.
 */
export const OPENROUTER_PROVIDER_ID = "openrouter";
export const OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api";

/**
 * The agent child's env, keyed on the configured provider — a build worker's
 * `FORGE_WORKER_MODEL_PROVIDER` or a Smith's `FORGE_SMITH_REASONING_PROVIDER` /
 * `FORGE_SMITH_EXECUTION_PROVIDER` (the Smith's Claude build worker runs on the
 * execution half, FRG-2095).
 *
 * On a subscription the Anthropic overrides are stripped: on a Smith the
 * orchestrator may hold an ANTHROPIC_API_KEY (the platform key on a billed or
 * pre-FRG-4532 Smith, a stale owner key after a switch), which would otherwise win
 * over (or, with the token missing, silently stand in for) the owner's token.
 * On any other configured provider a leftover `CLAUDE_CODE_OAUTH_TOKEN` (the
 * stale-key unset push is best-effort) is dropped instead, so it never
 * displaces the owner's API key. With no provider configured (local dev, a
 * personal orchestrator logged in via `claude setup-token`) the env passes
 * through untouched.
 *
 * A Smith whose build worker runs on OpenRouter (FRG-4085) points Claude Code at
 * OpenRouter's Anthropic endpoint with the owner's OPENROUTER_API_KEY as the
 * bearer token. Every other Anthropic credential is stripped and
 * `ANTHROPIC_API_KEY` is pinned empty, so any Anthropic key left on the box
 * can never stand in — with the owner's key missing the child fails auth
 * instead of billing the platform.
 */
export function claudeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.FORGE_SMITH_EXECUTION_PROVIDER?.trim() === OPENROUTER_PROVIDER_ID) {
    const child = { ...env };
    for (const name of CLAUDE_AUTH_OVERRIDE_VARS) delete child[name];
    delete child.CLAUDE_CODE_OAUTH_TOKEN;
    child.ANTHROPIC_BASE_URL = OPENROUTER_ANTHROPIC_BASE_URL;
    child.ANTHROPIC_API_KEY = "";
    if (env.OPENROUTER_API_KEY) child.ANTHROPIC_AUTH_TOKEN = env.OPENROUTER_API_KEY;
    return child;
  }
  const providers = [
    env.FORGE_WORKER_MODEL_PROVIDER,
    env.FORGE_SMITH_REASONING_PROVIDER,
    env.FORGE_SMITH_EXECUTION_PROVIDER,
  ].filter(Boolean);
  if (providers.length === 0) return env;
  const child = { ...env };
  if (providers.includes(CLAUDE_SUBSCRIPTION_PROVIDER_ID)) {
    for (const name of CLAUDE_AUTH_OVERRIDE_VARS) delete child[name];
  } else {
    delete child.CLAUDE_CODE_OAUTH_TOKEN;
  }
  return child;
}

/**
 * The `--model` Claude Code is launched with. A provider-prefixed id is reduced
 * to the bare Anthropic name — except on OpenRouter (FRG-4085), whose closed
 * execution list holds OpenRouter slugs (`anthropic/claude-opus-4.8`) that its
 * endpoint routes on; the bare remainder is neither a slug nor an Anthropic id.
 */
export function claudeModelArg(model: string, env: NodeJS.ProcessEnv): string {
  if (env.FORGE_SMITH_EXECUTION_PROVIDER?.trim() === OPENROUTER_PROVIDER_ID) return model;
  return bareModelId(model);
}

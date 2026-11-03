import { z } from "zod";
import { parseBooleanToken } from "./boolean-token.js";

/**
 * Central Zod schema for every environment variable Forge reads.
 *
 * Goals:
 * - One typed source of truth for `process.env` access.
 * - Parse once at boot and fail-fast on invalid values.
 * - Provide sensible defaults so optional flags do not require empty values.
 * - Support incremental migration: code can keep reading `process.env` while
 *   new code (and refactored call sites) use `getEnv()`.
 *
 * The schema is intentionally permissive for string secrets (most are optional)
 * and strict on shape: booleans must look like booleans, numbers must parse,
 * and enum-ish values must match expected sets.
 */

const optionalString = z.string().optional();

function booleanFlag(defaultValue = false) {
  return z.preprocess((val) => {
    if (val === undefined || val === "") return defaultValue;
    if (typeof val === "boolean") return val;
    // Boolean token coercion is defined once, in config/boolean-token.ts, so
    // every reader agrees on which spellings count.
    const coerced = parseBooleanToken(String(val));
    return coerced ?? val;
  }, z.boolean());
}

/**
 * A positive-integer tuning knob with a default.
 *
 * Empty (not just unset) resolves to the default, because every boot path
 * threads these as `"${VAR:-}"` — an operator who never set the value hands the
 * subprocess an empty string, and `z.coerce.number()` would turn that into 0
 * and fail `.min(1)`, wedging the process at parse time. A non-numeric value
 * still throws: a typo in a value someone deliberately set should fail fast at
 * boot rather than run at a silent default nobody chose.
 */
function positiveIntFlag(defaultValue: number) {
  return z.preprocess((val) => {
    if (val === undefined || val === "") return defaultValue;
    if (typeof val === "number") return val;
    const n = Number(val);
    return Number.isNaN(n) ? val : n;
  }, z.number().int().min(1));
}

function optionalNumber() {
  return z.preprocess((val) => {
    if (val === undefined || val === "") return undefined;
    if (typeof val === "number") return val;
    const n = Number(val);
    return Number.isNaN(n) ? val : n;
  }, z.number().optional());
}

export const EnvSchema = z.object({
  // Node runtime
  NODE_ENV: optionalString,
  PATH: optionalString,
  TZ: optionalString,

  // Linear tracker (legacy + Forge-prefixed names)
  LINEAR_API_KEY: optionalString,
  LINEAR_TEAM_ID: optionalString,
  LINEAR_ENDPOINT: optionalString,
  FORGE_LINEAR_API_KEY: optionalString,
  FORGE_LINEAR_TEAM_ID: optionalString,
  FORGE_LINEAR_PROJECT_ID: optionalString,
  FORGE_LINEAR_PROJECT_SLUG: optionalString,

  // Basecamp tracker. accountId/projectId/identityId/columns are per-project
  // and come from the WORKFLOW.md's tracker config (schema.ts); only the
  // secret token lives in env, same pattern as Linear's API key.
  FORGE_BASECAMP_API_KEY: optionalString,
  FORGE_BASECAMP_ENDPOINT: optionalString,
  // Basecamp token auto-refresh (FRG: "Basecamp login renew itself", Nov 2026).
  // Two independent refresh strategies — set at most one set of these. Both
  // are optional; with none set, Forge falls back to the static
  // FORGE_BASECAMP_API_KEY behavior (never refreshed), unchanged.
  //
  // 1) Direct OAuth refresh against Launchpad. Works anywhere Forge runs
  //    (including Fly) once real client credentials are available.
  FORGE_BASECAMP_REFRESH_TOKEN: optionalString,
  FORGE_BASECAMP_CLIENT_ID: optionalString,
  FORGE_BASECAMP_CLIENT_SECRET: optionalString,
  FORGE_BASECAMP_TOKEN_ENDPOINT: z
    .string()
    .default("https://launchpad.37signals.com/authorization/token?type=refresh"),
  // 2) Delegate to an already-authenticated `basecamp` CLI login (device-code,
  //    full scope) — the CLI knows its own client id/secret and refreshes its
  //    stored token on any call. Only usable where that binary is installed
  //    (e.g. Omar's own Mac); not available on a Fly box.
  FORGE_BASECAMP_CREDENTIALS_FILE: optionalString,
  FORGE_BASECAMP_REFRESH_XDG_CONFIG_HOME: optionalString,
  // Space-separated override of the command run to force a refresh. Defaults
  // to `basecamp auth status --json` (cheap, read-only, still triggers the
  // CLI's own refresh-if-needed logic).
  FORGE_BASECAMP_REFRESH_COMMAND: optionalString,

  // Commit identity for agent workspaces. When NAME and EMAIL are both set,
  // each workspace's LOCAL git config gets user.name/user.email, plus
  // user.signingkey + gpg.format openpgp + commit.gpgsign when SIGNING_KEY (a
  // GPG key id; signing goes through the host's gpg-agent) is set. Unset ⇒
  // workspaces keep the host's own git config. Read by workspace/git-identity.ts
  // and agent/child-env.ts. Values live only in the git-ignored .env.
  FORGE_GIT_AUTHOR_NAME: optionalString,
  FORGE_GIT_AUTHOR_EMAIL: optionalString,
  FORGE_GIT_SIGNING_KEY: optionalString,

  // Smith Linear state/label name overrides
  FORGE_LINEAR_STATE_BACKLOG: z.string().default("Backlog"),
  FORGE_LINEAR_STATE_TODO: z.string().default("Todo"),
  FORGE_LINEAR_STATE_IN_PROGRESS: z.string().default("In Progress"),
  FORGE_LINEAR_STATE_IN_REVIEW: z.string().default("In Review"),
  FORGE_LINEAR_STATE_DONE: z.string().default("Done"),
  FORGE_LINEAR_STATE_CANCELLED: z.string().default("Cancelled"),
  FORGE_LINEAR_LABEL_FEATURE: z.string().default("smith_feature"),
  FORGE_LINEAR_LABEL_BUG: z.string().default("smith_bug"),
  FORGE_LINEAR_LABEL_INFRA: z.string().default("smith_infra"),

  // LLM providers
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_AUTH_TOKEN: optionalString,
  ANTHROPIC_BASE_URL: optionalString,
  OPENAI_API_KEY: optionalString,
  OPENROUTER_API_KEY: optionalString,
  OLLAMA_HOST: z.string().default("http://localhost:11434"),
  KIMI_API_KEY: optionalString,

  // Agent / model routing
  FORGE_LLM_PROVIDER: optionalString,
  FORGE_AGENT_KIND: optionalString,
  FORGE_WORKER_AGENT_KIND: optionalString,
  FORGE_SMITH_AGENT_KIND: optionalString,
  FORGE_WORKER_MODEL: optionalString,
  FORGE_WORKER_THINKING: optionalString,
  FORGE_WORKER_REASONING_EFFORT: optionalString,
  // The Smith reasoning/execution split. On a FACTORY these are the fleet-wide
  // fallback the `/required-env` handler uses when an app has no BYOK config of
  // its own (FRG-2072); on a Smith BOX they are the resolved per-app values the
  // deploy wrote as Fly secrets. Defaults live in `SMITH_MODEL_DEFAULTS`
  // (smith-provider-slice.ts + factory_smith_required_env.py), not here —
  // an unset var here must stay indistinguishable from "operator has no
  // fleet-wide override". FORGE_SMITH_REASONING_BASE_URL follows the same split
  // (FRG-2089): unset on the factory means the registry's SDK root; its
  // default lives in `routerBaseUrl` (src/config/providers.ts), not here.
  FORGE_SMITH_REASONING_PROVIDER: optionalString,
  FORGE_SMITH_REASONING_MODEL: optionalString,
  FORGE_SMITH_REASONING_BASE_URL: optionalString,
  FORGE_SMITH_EXECUTION_PROVIDER: optionalString,
  FORGE_SMITH_EXECUTION_MODEL: optionalString,
  SMITH_EXECUTION_MODEL: optionalString,

  // Database / Supabase
  DATABASE_URL: optionalString,
  FORGE_PIPELINE_DATABASE_URL: optionalString,
  FORGE_SMITH_HERMES_DATABASE_URL: optionalString,
  SUPABASE_URL: optionalString,
  SUPABASE_ANON_KEY: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,

  // Fly.io
  FLY_API_TOKEN: optionalString,
  FORGE_FLY_API_TOKEN: optionalString,
  FLY_MACHINE_ID: optionalString,
  FLY_IMAGE_REF: optionalString,
  FLY_API_BASE_URL: z.string().default("https://api.machines.dev/v1"),
  FORGE_WORKER_APP: z.string().default("forge-workers"),

  // Forge runtime / identity
  FORGE_RUN_ID: optionalString,
  FORGE_USER_ID: optionalString,
  FORGE_OWNER_USER_ID: optionalString,
  FORGE_TRUSTED_SPAWN: booleanFlag(false),
  FORGE_WORKER_MODE: booleanFlag(false),
  FORGE_SMITH_MODE: booleanFlag(false),
  FORGE_LOCAL_DEV: booleanFlag(false),
  // Private-beta login gate. When true, the login UI hides the self-serve
  // sign-in controls (Google + magic-link) and shows an invite-only notice.
  // Invited users still sign in via magic links sent manually (Supabase);
  // purely a UX gate, mirroring FORGE_LOCAL_DEV.
  FORGE_LOGIN_BETA: booleanFlag(false),
  FORGE_BUILD_MODE: optionalString,
  FORGE_MCP_TOOL_SCOPE: optionalString,
  FORGE_ADMIN_TOOLS: booleanFlag(false),
  FORGE_ADMIN_USER_IDS: z.string().default(""),

  // Forge URLs / tokens
  FORGE_PUBLIC_BASE_URL: optionalString,
  FORGE_FACTORY_URL: optionalString,
  FORGE_FACTORY_INTERNAL_URL: optionalString,
  FORGE_FACTORY_PUBLIC_URL: optionalString,
  FORGE_ORCHESTRATOR_URL: optionalString,
  FORGE_INTERNAL_TOKEN: optionalString,
  FORGE_FACTORY_INTERNAL_TOKEN: optionalString,
  // Per-boot vault token (minted by scripts/cloud-start.sh, never a Fly secret).
  FORGE_FACTORY_VAULT_TOKEN: optionalString,
  // Base URL of the co-located gateway's /internal/* routes, derived per role by
  // scripts/cloud-start.sh. Normalized by resolveFactoryInternalHttp().
  FORGE_FACTORY_INTERNAL_HTTP: optionalString,
  FORGE_GITHUB_ORG: optionalString,
  GH_TOKEN: optionalString,
  GH_REPO: optionalString,
  REPO_URL: optionalString,

  // Forge behavior toggles
  FORGE_BASE_BRANCH: optionalString,
  FORGE_MAX_TURNS: optionalNumber(),
  FORGE_MAX_BUILD_USD: optionalNumber(),
  FORGE_KEEP_ALIVE: booleanFlag(false),
  FORGE_WORKER_KEEPALIVE_TTL_MS: optionalNumber(),
  FORGE_WORKSPACE_AUTO_CLEANUP: booleanFlag(false),
  FORGE_LOCAL_DEPLOY_OUTCOME: optionalString,
  FORGE_STAMPED_REPO_FILE: optionalString,
  FORGE_RUNTIME_APP_NAME: optionalString,
  FORGE_APP_ID: optionalString,
  FORGE_DECOMPOSED_BUILD: booleanFlag(false),
  FORGE_EXPLICIT_FIDELITY: booleanFlag(false),
  FORGE_EXPLICIT_PLAN_APPROVAL: booleanFlag(false),
  // BYOK (bring-your-own-key) mode: hides billing tools, bypasses debit gates,
  // relaxes Stripe/pack required-env checks, and exposes `byok: true` in
  // public-context payloads so the UI can switch. Factory-WIDE de-billing switch
  // (the hosted factory runs with it on). See the invariant on isByokMode() in
  // src/pipeline/byok.ts.
  FORGE_BYOK_MODE: booleanFlag(false),
  FORGE_FREE_DISCOVERY_SESSIONS_PER_HOUR: optionalNumber(),
  FORGE_HERMES_BRIDGE: optionalString,
  FORGE_LEARNINGS_DIR: optionalString,
  FORGE_DASHBOARD_LOCAL: booleanFlag(false),
  FORGE_EMAIL_FROM: optionalString,
  FORGE_HOSTING_RENEWAL_WEBHOOK_ENABLED: booleanFlag(false),

  // Optional narrower token for the merge queue's GitHub calls; falls back to
  // GH_TOKEN when unset.
  FORGE_MERGE_QUEUE_GITHUB_TOKEN: optionalString,

  // Forge GitHub App (used for Stamp + the deploy-workflow self-sync token).
  // The private key is factory-only (read directly by scripts/github_app.py) and
  // is deliberately NOT modeled here — FRG-2027 ensures it never flows through
  // repo provisioning. `FORGE_GH_APP_ID` + `FORGE_GH_APP_INSTALLATION_ID` are the
  // non-secret identifiers used to install the App on customer repos.
  FORGE_GH_APP_ID: optionalString,
  FORGE_GH_APP_INSTALLATION_ID: optionalString,
  // Legacy aliases kept as a factory-continuity fallback for the App id /
  // installation id only (no private key). FORGE_SYNC_APP_PRIVATE_KEY and the
  // old HAS_FORGE_SYNC_KEY flag were retired in FRG-2027.
  FORGE_SYNC_APP_ID: optionalString,
  FORGE_SYNC_INSTALLATION_ID: optionalString,

  // Local worker / development
  FORGE_LOCAL_WORKER_IMAGE: optionalString,
  FORGE_LOCAL_WORKER_NETWORK: z.string().default("forge-local"),
  FORGE_LOCAL_WORKER_PRIVILEGED: booleanFlag(true),

  // Worker identity (passed through to spawned agents)
  FORGE_WORKER_UID: optionalString,
  FORGE_WORKER_GID: optionalString,
  FORGE_WORKER_USER: optionalString,
  FORGE_WORKER_HOME: optionalString,
  FORGE_WORKER_SECRET: optionalString,
  // Per-run worker write credential, sealed into the bootstrap bundle (FRG-5467).
  FORGE_WORKER_RUN_CREDENTIAL: optionalString,

  // Smith service scoping
  FORGE_SMITH_WORKSPACE_ROOT: optionalString,
  FORGE_SMITH_WRITES_VIA_FACTORY: booleanFlag(false),
  FORGE_BUILD_AGENT_CAP: optionalNumber(),
  SMITH_AGENT_CAP: optionalNumber(),
  FORGE_BUILD_BUG_GRACE_DAYS: optionalNumber(),
  FORGE_FEATURE_BUG_WINDOW_HOURS: optionalNumber(),

  // Custom workflows — the deploy-side master flag for the hidden product line
  // (repo import/advisor mode, Workflow Studio, merge queue, repo hardening).
  // A plain boolean, default off (on under FORGE_BYOK_MODE — the gate applies
  // that default; this parsed value only reflects an explicit setting): with it
  // off, production behaviour is byte-identical to before the line existed. There is deliberately no
  // per-feature deploy flag; features inside the line are switched on by
  // in-product configuration. Pilot customers are scoped with the separate
  // allowlist FORGE_CUSTOM_WORKFLOWS_APPS, which never enables the line on its
  // own. The gate lives in config/custom-workflows.ts.
  FORGE_CUSTOM_WORKFLOWS_ENABLED: booleanFlag(false),
  FORGE_CUSTOM_WORKFLOWS_APPS: optionalString,
  // Repository import (connect an existing repo, readiness report, write grant).
  // The one per-feature flag inside the line: default off and NOT defaulted on
  // by BYOK, and it also needs the master flag (config/custom-workflows.ts).
  FORGE_REPO_IMPORT_ENABLED: booleanFlag(false),

  // FRG-1987: number of occurrences a known issue must reach before the system
  // proposes an org skill for it. Default 3 — one-off flakes should not become
  // institutional knowledge.
  FORGE_ORG_SKILL_PROPOSAL_THRESHOLD: positiveIntFlag(3),

  // CORS
  FORGE_CORS_ALLOWED_ORIGINS: optionalString,
  FORGE_CORS_WILDCARD: booleanFlag(false),

  // Stripe
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_API_VERSION: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  STRIPE_PRICE_ID_STARTER: optionalString,
  STRIPE_PRICE_ID_BUILDER: optionalString,
  STRIPE_PRICE_ID_STUDIO: optionalString,
  STRIPE_PRICE_ID_PRO: optionalString,

  // Email
  RESEND_API_KEY: optionalString,

  // GitHub OAuth
  GITHUB_OAUTH_CALLBACK_URL: optionalString,
  GITHUB_OAUTH_CLIENT_ID: optionalString,
  GITHUB_OAUTH_CLIENT_SECRET: optionalString,
  GITHUB_OAUTH_RETURN_URL: optionalString,
});

export type Env = z.infer<typeof EnvSchema>;

let cachedEnv: Env | undefined;

/**
 * Parse a raw environment object through the central schema.
 *
 * `source` defaults to `process.env`. Tests can pass an explicit object to
 * avoid mutating global state. The function always returns a fresh parse,
 * so tests can re-parse with different inputs.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}

/**
 * Return the parsed environment, caching the result on first call.
 *
 * This is the typed accessor intended for production code. It is parsed once
 * at boot so invalid values fail fast instead of surfacing deep in a run.
 */
export function getEnv(): Env {
  if (cachedEnv === undefined) {
    cachedEnv = parseEnv();
  }
  return cachedEnv;
}

/**
 * Reset the cached environment. Intended for tests only.
 */
export function resetEnvCache(): void {
  cachedEnv = undefined;
}

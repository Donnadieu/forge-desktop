/**
 * Compiles `agent.env_denylist` entries (FRG-4081) into one anchored regex:
 * exact names, or case-sensitive `*` globs such as `*DATABASE_URL*`.
 */
function denylistPattern(denylist: readonly string[]): RegExp {
  const alternatives = denylist.map((entry) =>
    entry
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*"),
  );
  return new RegExp(`^(?:${alternatives.join("|")})$`);
}

/**
 * The Basecamp tracker secret and its refresh credentials never reach an
 * agent or workspace hook child, regardless of the workflow's own
 * `env_denylist` configuration. The ConstructEase WORKFLOW.md itself says
 * the agent doesn't need its own Basecamp credential — it was only ever
 * reaching child processes (and, confirmed live, a ConstructEase `puma` dev
 * server's own process listing) because nothing stripped it by default.
 * Mirrors how `nonClaudeAgentEnv` always adds `CLAUDE_CODE_OAUTH_TOKEN` to
 * whatever denylist the caller passes.
 */
export const ALWAYS_DENIED_AGENT_ENV_VARS = [
  "FORGE_BASECAMP_API_KEY",
  "FORGE_BASECAMP_REFRESH_TOKEN",
  "FORGE_BASECAMP_CLIENT_ID",
  "FORGE_BASECAMP_CLIENT_SECRET",
  "FORGE_BASECAMP_CREDENTIALS_FILE",
  "FORGE_BASECAMP_REFRESH_XDG_CONFIG_HOME",
] as const;

/**
 * Git's own identity env vars. They beat any `git config`, so one exported in
 * the operator's shell (or loaded from the operator's `.env`) would silently
 * override the identity Forge writes into each workspace's local git config.
 */
export const GIT_IDENTITY_OVERRIDE_VARS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

/**
 * True when the operator configured the workspace commit identity. Same env
 * contract as `workspace/git-identity.ts` (re-read here because agent must not
 * import workspace): FORGE_GIT_AUTHOR_NAME + FORGE_GIT_AUTHOR_EMAIL.
 */
function workspaceGitIdentitySet(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.FORGE_GIT_AUTHOR_NAME?.trim() && env.FORGE_GIT_AUTHOR_EMAIL?.trim());
}

/**
 * The agent child's env with every denylisted var removed. When the operator
 * set the workspace commit identity, git's own identity overrides
 * ({@link GIT_IDENTITY_OVERRIDE_VARS}) are removed too, so the workspace's
 * local git config is what the agent commits as. Returns a copy and
 * never mutates `env`, so the orchestrator keeps its own vars (e.g. the
 * telemetry `DATABASE_URL` on a personal orchestrator). Always applies
 * `ALWAYS_DENIED_AGENT_ENV_VARS` on top of the caller's own denylist (which
 * may be empty or absent).
 */
export function scrubAgentEnv(
  env: NodeJS.ProcessEnv,
  denylist: readonly string[] | undefined,
): NodeJS.ProcessEnv {
  const combined = [
    ...ALWAYS_DENIED_AGENT_ENV_VARS,
    ...(workspaceGitIdentitySet(env) ? GIT_IDENTITY_OVERRIDE_VARS : []),
    ...(denylist ?? []),
  ];
  const denied = denylistPattern(combined);
  const child: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!denied.test(name)) child[name] = value;
  }
  return child;
}

/**
 * `scrubAgentEnv` for every non-Claude agent child (kimi, codex, hermes), which
 * also drops the owner's Claude subscription token (FRG-3009). None of them
 * authenticates with it, so it would only ride along to every command they
 * run — dependency install scripts included.
 */
export function nonClaudeAgentEnv(
  env: NodeJS.ProcessEnv,
  denylist: readonly string[] | undefined,
): NodeJS.ProcessEnv {
  return scrubAgentEnv(env, [...(denylist ?? []), "CLAUDE_CODE_OAUTH_TOKEN"]);
}

/**
 * Hermes strips `GH_TOKEN` from every terminal child, but a build worker's
 * agent pushes through the box gitconfig's credential helper, which reads
 * `GH_TOKEN`, else `FORGE_GIT_HTTP_TOKEN` (worker-start.sh, FRG-5696). So on a
 * build worker the Hermes bridge also gets the token under that name. Taken
 * from the already-scrubbed `env`, so an `env_denylist` withholding
 * `GH_TOKEN` still wins; never on the factory or a Smith.
 */
export function hermesGitTokenEnv(env: NodeJS.ProcessEnv, isWorker: boolean): NodeJS.ProcessEnv {
  return isWorker && env.GH_TOKEN ? { FORGE_GIT_HTTP_TOKEN: env.GH_TOKEN } : {};
}

/**
 * Base env for local workspace hook shells (FRG-5414). Smith and build-worker
 * hooks are platform-generated (`git clone`, dependency install) and never call
 * `claude`, so the owner's subscription token is withheld from them like from a
 * non-Claude child (FRG-5687). A personal orchestrator keeps it, since its hooks
 * may run `claude`.
 */
export function workspaceHookEnv(
  env: NodeJS.ProcessEnv,
  denylist: readonly string[] | undefined,
  host: { isSmith: boolean; isWorker: boolean },
): NodeJS.ProcessEnv {
  return host.isSmith || host.isWorker
    ? nonClaudeAgentEnv(env, denylist)
    : scrubAgentEnv(env, denylist);
}

/**
 * `scrubAgentEnv` over each MCP server's `env` map. The map is written to the
 * agent's workspace (`.forge/mcp.json`) and every server started from it runs
 * under the agent, so a denied var must not ride in through it either.
 */
export function scrubMcpServerEnvs<T extends Record<string, unknown>>(
  servers: T,
  denylist: readonly string[] | undefined,
): T {
  const scrubbed: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const env = (server as { env?: NodeJS.ProcessEnv } | undefined)?.env;
    scrubbed[name] =
      env && typeof env === "object"
        ? { ...(server as object), env: scrubAgentEnv(env, denylist) }
        : server;
  }
  return scrubbed as T;
}

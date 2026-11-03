import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the MCP server configuration map for the orchestrator.
 *
 * @param trackerKind - The issue tracker kind (e.g. "linear")
 */
export function buildMcpServers(trackerKind: string): Record<string, unknown> {
  let mcpServers: Record<string, unknown> | undefined;

  if (trackerKind === "linear") {
    const mcpServerPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "mcp",
      "linear-graphql-server.js",
    );
    mcpServers = {
      "forge-linear": {
        command: "node",
        args: [mcpServerPath],
        env: {
          LINEAR_API_KEY: process.env.LINEAR_API_KEY ?? "",
          LINEAR_ENDPOINT: "https://api.linear.app/graphql",
        },
      },
    };
  }

  const pipelineMcpServerPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "mcp",
    "forge-pipeline",
    "server.js",
  );
  mcpServers = mcpServers ?? {};
  // Propagate trusted-spawn identity if set in the orchestrator's own env
  // (buildWorkerEnv injects FORGE_USER_ID + FORGE_TRUSTED_SPAWN per build).
  // The forge-pipeline MCP child reads these at boot via auth-context.ts so
  // getCurrentUserId() resolves without per-call args.userId.
  const pipelineEnv: Record<string, string> = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
    LINEAR_API_KEY: process.env.LINEAR_API_KEY ?? "",
    LINEAR_TEAM_ID: process.env.LINEAR_TEAM_ID ?? "",
    FORGE_LLM_PROVIDER: process.env.FORGE_LLM_PROVIDER ?? "",
    FORGE_GITHUB_ORG: process.env.FORGE_GITHUB_ORG ?? "",
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    // Public-facing URL (used by checkout success_url / cancel_url)
    FORGE_PUBLIC_BASE_URL: process.env.FORGE_PUBLIC_BASE_URL ?? "",
    // Supabase service role (server-side DB writes that bypass RLS)
    SUPABASE_URL: process.env.SUPABASE_URL ?? "",
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    // Stripe (paywall / credits)
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "",
    STRIPE_API_VERSION: process.env.STRIPE_API_VERSION ?? "",
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    STRIPE_PRICE_ID_STARTER: process.env.STRIPE_PRICE_ID_STARTER ?? "",
    STRIPE_PRICE_ID_BUILDER: process.env.STRIPE_PRICE_ID_BUILDER ?? "",
    STRIPE_PRICE_ID_STUDIO: process.env.STRIPE_PRICE_ID_STUDIO ?? "",
    STRIPE_PRICE_ID_PRO: process.env.STRIPE_PRICE_ID_PRO ?? "",
    // Admin tools gate (forge_admin_grant_credits — testing/ops bypass)
    FORGE_ADMIN_TOOLS: process.env.FORGE_ADMIN_TOOLS ?? "",
  };
  if (process.env.FORGE_USER_ID && process.env.FORGE_TRUSTED_SPAWN === "1") {
    pipelineEnv.FORGE_USER_ID = process.env.FORGE_USER_ID;
    pipelineEnv.FORGE_TRUSTED_SPAWN = "1";
  }
  mcpServers["forge-pipeline"] = {
    command: "node",
    args: [pipelineMcpServerPath],
    env: pipelineEnv,
  };

  return mcpServers;
}

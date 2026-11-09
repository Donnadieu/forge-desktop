/**
 * Builders for the MCP server config that gets passed into the orchestrator
 * and forwarded to spawned worker agents. Extracted from `src/index.ts` to
 * keep the CLI bootstrap under the architecture line-count ceiling.
 *
 * SINGLE SOURCE OF TRUTH: this delegates to `buildMcpServers` in `config.ts`.
 * The two used to be separate implementations that drifted — this one shipped
 * a thinner `forge-pipeline` env (no DATABASE_URL / Supabase / trusted-spawn
 * identity), so workers spawned with this config got a forge-pipeline MCP that
 * couldn't resolve the user or write persistence, and `forge-linear` was the
 * only Linear path. Routing through `config.ts` gives workers the full env.
 */

import { buildMcpServers } from "./config.js";

export type McpServersConfig = Record<string, unknown>;

export function buildMcpServersConfig(
  trackerKind: string,
  board: { accountId?: string; endpoint?: string } = {},
  marks: { invisible?: boolean } = {},
): McpServersConfig {
  return buildMcpServers(trackerKind, board, marks);
}

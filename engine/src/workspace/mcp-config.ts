import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Write per-workspace MCP config JSON for the agent.
 * Creates a .forge/mcp.json file in the workspace directory.
 */
export function writeMcpConfig(workspacePath: string, mcpServers: Record<string, unknown>): string {
  const forgeDir = join(workspacePath, ".forge");
  mkdirSync(forgeDir, { recursive: true });

  const configPath = join(forgeDir, "mcp.json");
  const config = { mcpServers };
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  return configPath;
}

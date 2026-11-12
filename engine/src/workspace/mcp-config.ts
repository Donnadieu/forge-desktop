import { join } from "node:path";
import { writeMcpFile } from "./person-mcp.js";

/**
 * Write per-workspace MCP config JSON for the agent.
 * Creates a .forge/mcp.json file in the workspace directory.
 */
export function writeMcpConfig(workspacePath: string, mcpServers: Record<string, unknown>): string {
  // Only the person can read it: the person's own servers may carry a key in their env or headers.
  return writeMcpFile(join(workspacePath, ".forge", "mcp.json"), mcpServers);
}

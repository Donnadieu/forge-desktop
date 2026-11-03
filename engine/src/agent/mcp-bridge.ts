/**
 * MCP-to-Codex dynamic tool bridge.
 *
 * Codex does not understand MCP natively. This bridge spawns MCP servers,
 * discovers their tools, and proxies tool calls — letting Codex use Forge's
 * MCP tools as "dynamic tools" registered at thread/start time.
 *
 * Response format: the normalized dynamic-tool result Codex expects.
 */

import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface DynamicToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DynamicToolResult {
  success: boolean;
  output: string;
  contentItems: Array<{ type: string; text: string }>;
}

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpServerConnection {
  client: Client;
  transport: StdioClientTransport;
}

export class McpBridge {
  private connections = new Map<string, McpServerConnection>();
  private toolToServer = new Map<string, string>();

  /** `baseEnv` is the env each server starts from (the agent's scrubbed env). */
  async initialize(
    mcpConfigPath: string,
    baseEnv: NodeJS.ProcessEnv = process.env,
  ): Promise<DynamicToolSpec[]> {
    const raw = readFileSync(mcpConfigPath, "utf-8");
    const config = JSON.parse(raw) as {
      mcpServers: Record<string, McpServerConfig>;
    };

    const allTools: DynamicToolSpec[] = [];

    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      try {
        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: { ...baseEnv, ...expandEnv(serverConfig.env, baseEnv) } as Record<string, string>,
        });
        const client = new Client({ name: "forge-codex-bridge", version: "0.1.0" }, {});
        await client.connect(transport);

        const { tools } = await client.listTools();
        for (const tool of tools) {
          allTools.push({
            name: tool.name,
            description: tool.description || "",
            inputSchema: tool.inputSchema as Record<string, unknown>,
          });
          this.toolToServer.set(tool.name, serverName);
        }

        this.connections.set(serverName, { client, transport });
      } catch {
        // Continue — partial tool availability is better than none
      }
    }

    return allTools;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<DynamicToolResult> {
    const serverName = this.toolToServer.get(toolName);
    if (!serverName) {
      return failureResult({
        error: {
          message: `Unsupported dynamic tool: ${toolName}.`,
          supportedTools: [...this.toolToServer.keys()],
        },
      });
    }

    const conn = this.connections.get(serverName);
    if (!conn) {
      return failureResult({
        error: { message: `MCP server not connected: ${serverName}` },
      });
    }

    try {
      const result = await conn.client.callTool({
        name: toolName,
        arguments: args,
      });
      const output = JSON.stringify(result, null, 2);
      return {
        success: true,
        output,
        contentItems: [{ type: "inputText", text: output }],
      };
    } catch (err) {
      return failureResult({
        error: {
          message: `Tool execution failed: ${String(err)}`,
        },
      });
    }
  }

  async close(): Promise<void> {
    for (const [, conn] of this.connections) {
      try {
        await conn.client.close();
      } catch {
        // best-effort cleanup
      }
    }
    this.connections.clear();
    this.toolToServer.clear();
  }
}

function failureResult(payload: unknown): DynamicToolResult {
  const output = JSON.stringify(payload, null, 2);
  return {
    success: false,
    output,
    contentItems: [{ type: "inputText", text: output }],
  };
}

/**
 * `${VAR}` placeholders in a server's env, filled from the agent's env (the same
 * expansion Claude Code does), so no secret has to be written into the card's folder.
 */
export function expandEnv(
  env: Record<string, string> | undefined,
  from: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    out[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => from[name] ?? "");
  }
  return out;
}

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the MCP server configuration map for the orchestrator.
 *
 * @param trackerKind - The issue tracker kind (e.g. "linear")
 * @param board - Basecamp only: the board's account, read from the workflow file.
 */
export function buildMcpServers(
  trackerKind: string,
  board: { accountId?: string; endpoint?: string } = {},
): Record<string, unknown> {
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
        // The engine's own Node: a Mac app's agents may not have `node` on PATH.
        command: process.execPath,
        args: [mcpServerPath],
        // A placeholder, never the key: this map is written into the card's folder.
        // Claude Code expands `${VAR}` from the agent's env; the Codex bridge does too.
        env: {
          LINEAR_API_KEY: "${LINEAR_API_KEY}",
          LINEAR_ENDPOINT: "https://api.linear.app/graphql",
        },
      },
    };
  }

  if (trackerKind === "basecamp") {
    mcpServers = {
      "forge-basecamp": {
        command: process.execPath,
        args: [
          resolve(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "basecamp-api-server.js"),
        ],
        // No secret here: the command asks the app for a short-lived token each time.
        env: {
          BASECAMP_ACCOUNT_ID: board.accountId ?? "",
          BASECAMP_ENDPOINT: board.endpoint ?? "https://3.basecampapi.com",
          BASECAMP_TOKEN_COMMAND: process.env.FORGE_BASECAMP_TOKEN_COMMAND ?? "[]",
        },
      },
    };
  }

  return mcpServers ?? {};
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { redactSecretsDeep, redactSecretsFromString } from "../observability/secret-redact.js";
import { findMarks, marksRefusal } from "../tracker/marks.js";
import { writeStderr } from "./handler-log.js";

const LINEAR_TOOL = {
  name: "linear_graphql",
  description: "Execute a GraphQL query or mutation against the Linear API",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "GraphQL query or mutation" },
      variables: { type: "object", description: "Optional GraphQL variables" },
    },
    required: ["query"],
  },
};

export async function executeGraphQL(
  query: string,
  variables: Record<string, unknown> | undefined,
  apiKey: string,
  endpoint: string,
  invisible = false,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  // "Keep Forge invisible": a mutation that would show a mark never leaves (tracker/marks.ts).
  const marks =
    invisible && /\bmutation\b/.test(query)
      ? findMarks(`${query}\n${JSON.stringify(variables ?? {})}`)
      : [];
  if (marks.length > 0) return { success: false, error: marksRefusal("this Linear write", marks) };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    // Agent-written workpads/comments leave the box here. Live secret values are
    // exact-matched when the agent's MCP launcher passes the worker env through;
    // credential shapes are caught either way. The Linear API key itself
    // travels in a header.
    body: JSON.stringify({
      query: redactSecretsFromString(query),
      variables: redactSecretsDeep(variables),
    }),
  });

  if (!response.ok) {
    return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
  }

  const json = (await response.json()) as { data?: unknown; errors?: Array<{ message: string }> };

  if (json.errors?.length) {
    return {
      success: false,
      error: `GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`,
    };
  }

  return { success: true, data: json.data };
}

export async function startServer(): Promise<void> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY environment variable is required");
  }
  const endpoint = process.env.LINEAR_ENDPOINT || "https://api.linear.app/graphql";

  const server = new Server(
    { name: "forge-linear", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [LINEAR_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "linear_graphql") {
      return {
        content: [
          { type: "text", text: JSON.stringify({ success: false, error: "Unknown tool" }) },
        ],
        isError: true,
      };
    }

    const args = request.params.arguments as { query: string; variables?: Record<string, unknown> };
    const result = await executeGraphQL(
      args.query,
      args.variables,
      apiKey,
      endpoint,
      process.env.MARKS_INVISIBLE === "1",
    );

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: !result.success,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run when executed directly (not when imported in tests)
const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isDirectExecution) {
  startServer().catch((err) => {
    writeStderr(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

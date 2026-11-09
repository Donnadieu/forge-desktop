/**
 * The agents' GitHub board tool: one GraphQL query or mutation per call, as
 * the person the app signed in to GitHub with (the token has the `project`
 * scope the person's own `gh` sign-in may lack). The token comes from the app
 * (`GITHUB_TOKEN_COMMAND`, a JSON array: the app's binary and
 * `--github-token`), which keeps it in the Keychain; this server holds it in
 * memory only and asks again after an hour or a 401.
 *
 * New in Forge Desktop (the agents' Linear tool is `linear-graphql-server.ts`).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { redactSecretsDeep, redactSecretsFromString } from "../observability/secret-redact.js";
import { createCommandTokenFn } from "../tracker/basecamp-token-provider.js";
import { findMarks, marksRefusal, PLAIN_USER_AGENT } from "../tracker/marks.js";
import { writeStderr } from "./handler-log.js";

const GITHUB_TOOL = {
  name: "github_graphql",
  description:
    "Run one GraphQL query or mutation against GitHub's API for this board (its project, issues, labels and comments).",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "GraphQL query or mutation" },
      variables: { type: "object", description: "Optional GraphQL variables" },
    },
    required: ["query"],
  },
};

export interface GitHubCallResult {
  success: boolean;
  status?: number;
  data?: unknown;
  error?: string;
}

export async function callGitHub(
  args: { query: string; variables?: Record<string, unknown> },
  opts: { endpoint: string; token: () => Promise<string>; invisible?: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubCallResult> {
  if (typeof args.query !== "string" || !args.query.trim()) {
    return { success: false, error: "query is required" };
  }
  // "Keep Forge invisible": a mutation that would show a mark never leaves (tracker/marks.ts).
  const marks =
    opts.invisible && /\bmutation\b/.test(args.query)
      ? findMarks(`${args.query}\n${JSON.stringify(args.variables ?? {})}`)
      : [];
  if (marks.length > 0) return { success: false, error: marksRefusal("this issue write", marks) };
  const response = await fetchImpl(opts.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await opts.token()}`,
      "Content-Type": "application/json",
      "User-Agent": PLAIN_USER_AGENT,
    },
    // Agent-written comments leave the box here: credential shapes are redacted.
    body: JSON.stringify({
      query: redactSecretsFromString(args.query),
      variables: redactSecretsDeep(args.variables),
    }),
  });
  if (!response.ok) {
    return { success: false, status: response.status, error: `HTTP ${response.status}` };
  }
  const json = (await response.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    return {
      success: false,
      status: response.status,
      data: json.data,
      error: `GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`,
    };
  }
  return { success: true, status: response.status, data: json.data };
}

export async function startServer(): Promise<void> {
  const endpoint = process.env.GITHUB_GRAPHQL_ENDPOINT || "https://api.github.com/graphql";
  const command = JSON.parse(process.env.GITHUB_TOKEN_COMMAND ?? "[]") as string[];
  if (command.length === 0) throw new Error("GITHUB_TOKEN_COMMAND is required");
  const invisible = process.env.MARKS_INVISIBLE === "1";
  const read = createCommandTokenFn({ command });
  let cached: { token: string; until: number } | null = null;
  const token = async (): Promise<string> => {
    if (cached && cached.until > Date.now()) return cached.token;
    const s = await read();
    cached = { token: s.accessToken, until: s.expiresAtMs - 5 * 60_000 };
    return s.accessToken;
  };

  const server = new Server(
    { name: "forge-github", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [GITHUB_TOOL] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "github_graphql") {
      return {
        content: [
          { type: "text", text: JSON.stringify({ success: false, error: "Unknown tool" }) },
        ],
        isError: true,
      };
    }
    const args = request.params.arguments as { query: string; variables?: Record<string, unknown> };
    let result: GitHubCallResult;
    try {
      result = await callGitHub(args, { endpoint, token, invisible });
      if (result.status === 401) {
        cached = null;
        result = await callGitHub(args, { endpoint, token, invisible });
      }
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: !result.success,
    };
  });
  await server.connect(new StdioServerTransport());
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

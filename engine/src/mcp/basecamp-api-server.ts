/**
 * The agents' Basecamp tool: one call = one request to Basecamp's API for the
 * board's account. The token comes from the app (`BASECAMP_TOKEN_COMMAND`, a
 * JSON array: the app's binary and `--basecamp-token`), which keeps the
 * sign-in in the Keychain; this server holds only the short-lived access
 * token, in memory, and asks again when it is about to run out.
 *
 * New in Forge Desktop (the agents' Linear tool is `linear-graphql-server.ts`).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { redactSecretsDeep } from "../observability/secret-redact.js";
import { createCommandTokenFn } from "../tracker/basecamp-token-provider.js";
import { writeStderr } from "./handler-log.js";

const BASECAMP_TOOL = {
  name: "basecamp_api",
  description:
    "Call Basecamp's API for this board's account. `path` starts after the account id, e.g. " +
    "/buckets/<project>/card_tables/cards/<card>.json. Lists are paginated: the result's `next` is the next page's path.",
  inputSchema: {
    type: "object" as const,
    properties: {
      method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] },
      path: { type: "string", description: "API path after the account id, ending in .json" },
      body: { type: "object", description: "JSON body for POST and PUT" },
    },
    required: ["method", "path"],
  },
};

export interface BasecampCallResult {
  success: boolean;
  status?: number;
  data?: unknown;
  next?: string | null;
  error?: string;
}

/** A path inside the account: absolute URLs and anything that climbs out are refused. */
export function safePath(path: string): string | null {
  const p = path.trim();
  if (!p.startsWith("/") || p.includes("..") || p.includes("://")) return null;
  return p;
}

export async function callBasecamp(
  args: { method: string; path: string; body?: unknown },
  opts: { endpoint: string; accountId: string; token: () => Promise<string> },
  fetchImpl: typeof fetch = fetch,
): Promise<BasecampCallResult> {
  const method = args.method.toUpperCase();
  if (!["GET", "POST", "PUT", "DELETE"].includes(method)) {
    return { success: false, error: `Unsupported method ${args.method}` };
  }
  const path = safePath(args.path);
  if (!path) return { success: false, error: "path must start with / and stay inside the account" };
  const base = `${opts.endpoint}/${opts.accountId}`;
  const response = await fetchImpl(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await opts.token()}`,
      "Content-Type": "application/json",
      "User-Agent": "Forge Desktop (https://github.com/Donnadieu/forge-desktop)",
    },
    // Agent-written comments leave the box here: credential shapes are redacted.
    body: args.body === undefined ? undefined : JSON.stringify(redactSecretsDeep(args.body)),
  });
  const text = await response.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: keep the text
  }
  const link = response.headers.get("Link") ?? "";
  const nextUrl = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  const next = nextUrl?.startsWith(base) ? nextUrl.slice(base.length) : nextUrl;
  if (!response.ok) {
    return { success: false, status: response.status, error: `HTTP ${response.status}`, data };
  }
  return { success: true, status: response.status, data, next };
}

export async function startServer(): Promise<void> {
  const accountId = process.env.BASECAMP_ACCOUNT_ID ?? "";
  const endpoint = process.env.BASECAMP_ENDPOINT || "https://3.basecampapi.com";
  const command = JSON.parse(process.env.BASECAMP_TOKEN_COMMAND ?? "[]") as string[];
  if (!accountId || command.length === 0) {
    throw new Error("BASECAMP_ACCOUNT_ID and BASECAMP_TOKEN_COMMAND are required");
  }
  const refresh = createCommandTokenFn({ command });
  let cached: { token: string; until: number } | null = null;
  const token = async (): Promise<string> => {
    if (cached && cached.until > Date.now()) return cached.token;
    const s = await refresh();
    cached = { token: s.accessToken, until: s.expiresAtMs - 5 * 60_000 };
    return s.accessToken;
  };

  const server = new Server(
    { name: "forge-basecamp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [BASECAMP_TOOL] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "basecamp_api") {
      return {
        content: [
          { type: "text", text: JSON.stringify({ success: false, error: "Unknown tool" }) },
        ],
        isError: true,
      };
    }
    const args = request.params.arguments as { method: string; path: string; body?: unknown };
    let result: BasecampCallResult;
    try {
      result = await callBasecamp(args, { endpoint, accountId, token });
      if (result.status === 401) {
        cached = null;
        result = await callBasecamp(args, { endpoint, accountId, token });
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

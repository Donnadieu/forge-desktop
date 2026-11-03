import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockClient = vi.hoisted(() => ({
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
}));

const ClientMock = vi.hoisted(() => vi.fn(() => mockClient));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: ClientMock,
}));

const StdioClientTransportMock = vi.hoisted(() => vi.fn());

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: StdioClientTransportMock,
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { expandEnv, McpBridge } from "../../../src/agent/mcp-bridge.js";

function makeConfig(
  servers: Record<
    string,
    {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    }
  >,
): string {
  return JSON.stringify({
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([name, cfg]) => [
        name,
        {
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
        },
      ]),
    ),
  });
}

const { listTools: listToolsMock, callTool: callToolMock, close: closeMock } = mockClient;

describe("McpBridge", () => {
  let bridge: McpBridge;

  beforeEach(() => {
    bridge = new McpBridge();
    ClientMock.mockClear();
    StdioClientTransportMock.mockClear();
    mockClient.connect.mockReset();
    mockClient.listTools.mockReset();
    mockClient.callTool.mockReset();
    mockClient.close.mockReset();
    vi.mocked(readFileSync).mockReset();
  });

  afterEach(async () => {
    await bridge.close();
  });

  describe("initialize", () => {
    it("discovers tools from all configured servers and maps them by name", async () => {
      vi.mocked(readFileSync).mockReturnValue(
        makeConfig({
          linear: {
            command: "node",
            args: ["/opt/forge/dist/mcp/linear-graphql-server.js"],
            tools: [
              {
                name: "linear_graphql",
                description: "Run Linear GraphQL",
                inputSchema: { type: "object" },
              },
            ],
          },
          pipeline: {
            command: "node",
            args: ["/opt/forge/dist/mcp/forge-pipeline/server.js"],
            tools: [
              {
                name: "forge_create_run",
                description: "Create a run",
                inputSchema: { type: "object" },
              },
              {
                name: "forge_list_runs",
                description: "List runs",
                inputSchema: { type: "object" },
              },
            ],
          },
        }),
      );

      // listToolsMock uses the last Client constructor call to pick a server name.
      // The bridge constructs one Client per server with the same info object, so
      // we disambiguate by call index instead.
      const toolSets = [
        [
          {
            name: "linear_graphql",
            description: "Run Linear GraphQL",
            inputSchema: { type: "object" },
          },
        ],
        [
          {
            name: "forge_create_run",
            description: "Create a run",
            inputSchema: { type: "object" },
          },
          { name: "forge_list_runs", description: "List runs", inputSchema: { type: "object" } },
        ],
      ];
      let callIndex = 0;
      listToolsMock.mockImplementation(async () => ({ tools: toolSets[callIndex++] ?? [] }));

      const tools = await bridge.initialize("/tmp/mcp.json");

      expect(tools).toHaveLength(3);
      expect(tools).toContainEqual({
        name: "linear_graphql",
        description: "Run Linear GraphQL",
        inputSchema: { type: "object" },
      });
      expect(tools).toContainEqual({
        name: "forge_create_run",
        description: "Create a run",
        inputSchema: { type: "object" },
      });
      expect(tools).toContainEqual({
        name: "forge_list_runs",
        description: "List runs",
        inputSchema: { type: "object" },
      });
      expect(ClientMock).toHaveBeenCalledTimes(2);
      expect(StdioClientTransportMock).toHaveBeenCalledTimes(2);
    });

    it("merges server env on top of process env for the transport", async () => {
      vi.mocked(readFileSync).mockReturnValue(
        makeConfig({
          linear: {
            command: "node",
            args: ["server.js"],
            env: { LINEAR_API_KEY: "lin_secret" },
            tools: [{ name: "linear_graphql" }],
          },
        }),
      );
      listToolsMock.mockResolvedValue({ tools: [{ name: "linear_graphql" }] });

      await bridge.initialize("/tmp/mcp.json");

      expect(StdioClientTransportMock).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ LINEAR_API_KEY: "lin_secret" }),
        }),
      );
      const passedEnv = StdioClientTransportMock.mock.calls[0][0].env as Record<string, string>;
      expect(passedEnv.LINEAR_API_KEY).toBe("lin_secret");
    });

    it("starts servers from the caller's base env instead of process.env (FRG-4081)", async () => {
      vi.mocked(readFileSync).mockReturnValue(
        makeConfig({
          linear: {
            command: "node",
            args: ["server.js"],
            env: { LINEAR_API_KEY: "lin_secret" },
            tools: [{ name: "linear_graphql" }],
          },
        }),
      );
      listToolsMock.mockResolvedValue({ tools: [{ name: "linear_graphql" }] });
      vi.stubEnv("DATABASE_URL", "postgres://staging");
      try {
        await bridge.initialize("/tmp/mcp.json", { PATH: "/usr/bin" });
      } finally {
        vi.unstubAllEnvs();
      }

      const passedEnv = StdioClientTransportMock.mock.calls[0][0].env as Record<string, string>;
      expect(passedEnv).toEqual({ PATH: "/usr/bin", LINEAR_API_KEY: "lin_secret" });
    });

    it("continues when one server fails to connect (partial availability)", async () => {
      vi.mocked(readFileSync).mockReturnValue(
        makeConfig({
          failing: { command: "false", tools: [] },
          working: { command: "node", tools: [{ name: "working_tool" }] },
        }),
      );

      let callIndex = 0;
      mockClient.connect.mockImplementation(async () => {
        if (callIndex++ === 0) throw new Error("connection refused");
      });
      listToolsMock.mockResolvedValue({ tools: [{ name: "working_tool" }] });

      const tools = await bridge.initialize("/tmp/mcp.json");

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("working_tool");
      expect(ClientMock).toHaveBeenCalledTimes(2);
    });

    it("returns an empty array when every server fails", async () => {
      vi.mocked(readFileSync).mockReturnValue(
        makeConfig({
          a: { command: "false", tools: [] },
          b: { command: "false", tools: [] },
        }),
      );
      mockClient.connect.mockRejectedValue(new Error("down"));

      const tools = await bridge.initialize("/tmp/mcp.json");

      expect(tools).toEqual([]);
    });
  });

  describe("callTool", () => {
    beforeEach(async () => {
      vi.mocked(readFileSync).mockReturnValue(
        makeConfig({
          linear: {
            command: "node",
            args: ["linear.js"],
            tools: [{ name: "linear_graphql" }],
          },
          pipeline: {
            command: "node",
            args: ["pipeline.js"],
            tools: [{ name: "forge_create_run" }],
          },
        }),
      );

      const toolSets = [[{ name: "linear_graphql" }], [{ name: "forge_create_run" }]];
      let callIndex = 0;
      listToolsMock.mockImplementation(async () => ({ tools: toolSets[callIndex++] ?? [] }));

      await bridge.initialize("/tmp/mcp.json");
    });

    it("routes a tool call to the server that registered the tool", async () => {
      callToolMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

      const result = await bridge.callTool("linear_graphql", { query: "{ viewer { id } }" });

      expect(result.success).toBe(true);
      expect(result.output).toContain("ok");
      expect(callToolMock).toHaveBeenCalledWith({
        name: "linear_graphql",
        arguments: { query: "{ viewer { id } }" },
      });
    });

    it("routes different tools to different servers", async () => {
      callToolMock.mockImplementation(async (request) => {
        if (request.name === "linear_graphql")
          return { content: [{ type: "text", text: "linear" }] };
        return { content: [{ type: "text", text: "pipeline" }] };
      });

      const linearResult = await bridge.callTool("linear_graphql", { query: "{}" });
      const pipelineResult = await bridge.callTool("forge_create_run", { prompt: "x" });

      expect(linearResult.output).toContain("linear");
      expect(pipelineResult.output).toContain("pipeline");
      expect(callToolMock).toHaveBeenCalledTimes(2);
    });

    it("returns a failure when the tool is not registered", async () => {
      const result = await bridge.callTool("unknown_tool", {});

      expect(result.success).toBe(false);
      expect(result.output).toContain("Unsupported dynamic tool: unknown_tool");
      expect(result.output).toContain("linear_graphql");
      expect(result.output).toContain("forge_create_run");
    });

    it("returns a failure when the registered server is not connected", async () => {
      // Manually remove the connection while keeping the tool mapping.
      // This simulates a state where close() was partially invoked or a
      // connection was dropped without a corresponding map update.
      (bridge as any).connections.delete("linear");

      const result = await bridge.callTool("linear_graphql", { query: "{}" });

      expect(result.success).toBe(false);
      expect(result.output).toContain("MCP server not connected: linear");
    });

    it("returns a failure when the tool execution throws", async () => {
      callToolMock.mockRejectedValue(new Error("Linear API unreachable"));

      const result = await bridge.callTool("linear_graphql", { query: "{}" });

      expect(result.success).toBe(false);
      expect(result.output).toContain("Tool execution failed: Error: Linear API unreachable");
    });

    it("stringifies non-error thrown values", async () => {
      callToolMock.mockRejectedValue("raw string error");

      const result = await bridge.callTool("linear_graphql", {});

      expect(result.success).toBe(false);
      expect(result.output).toContain("Tool execution failed: raw string error");
    });
  });

  describe("close", () => {
    it("closes every connected client and clears internal state", async () => {
      vi.mocked(readFileSync).mockReturnValue(
        makeConfig({
          a: { command: "node", tools: [{ name: "tool_a" }] },
          b: { command: "node", tools: [{ name: "tool_b" }] },
        }),
      );
      const toolSets = [[{ name: "tool_a" }], [{ name: "tool_b" }]];
      let callIndex = 0;
      listToolsMock.mockImplementation(async () => ({ tools: toolSets[callIndex++] ?? [] }));

      await bridge.initialize("/tmp/mcp.json");
      await bridge.close();

      expect(closeMock).toHaveBeenCalledTimes(2);
      expect((bridge as any).connections.size).toBe(0);
      expect((bridge as any).toolToServer.size).toBe(0);
    });

    it("tolerates errors from individual client close calls", async () => {
      vi.mocked(readFileSync).mockReturnValue(
        makeConfig({
          a: { command: "node", tools: [{ name: "tool_a" }] },
          b: { command: "node", tools: [{ name: "tool_b" }] },
        }),
      );
      const toolSets = [[{ name: "tool_a" }], [{ name: "tool_b" }]];
      let callIndex = 0;
      listToolsMock.mockImplementation(async () => ({ tools: toolSets[callIndex++] ?? [] }));
      closeMock.mockRejectedValueOnce(new Error("close failed"));

      await bridge.initialize("/tmp/mcp.json");

      await expect(bridge.close()).resolves.toBeUndefined();
      expect(closeMock).toHaveBeenCalledTimes(2);
    });

    it("is safe to call on an uninitialized bridge", async () => {
      await expect(bridge.close()).resolves.toBeUndefined();
      expect(closeMock).not.toHaveBeenCalled();
    });
  });
});

describe("expandEnv", () => {
  it("fills ${VAR} placeholders from the agent's env and leaves other text alone", () => {
    expect(
      expandEnv({ A: "${KEY}", B: "x-${KEY}-y", C: "plain", D: "${MISSING}" }, { KEY: "k" }),
    ).toEqual({ A: "k", B: "x-k-y", C: "plain", D: "" });
  });
});

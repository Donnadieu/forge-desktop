import { describe, expect, it } from "vitest";
import { buildMcpServers } from "../../../src/mcp/config.js";

describe("buildMcpServers", () => {
  it("gives Linear cards the Linear tools, run by the engine's own Node", () => {
    const servers = buildMcpServers("linear") as Record<
      string,
      { command: string; args: string[] }
    >;
    expect(Object.keys(servers)).toEqual(["forge-linear"]);
    expect(servers["forge-linear"].command).toBe(process.execPath);
    expect(servers["forge-linear"].args[0]).toMatch(/linear-graphql-server\.js$/);
  });

  it("never writes the Linear key itself, only a placeholder the agent's env fills", () => {
    process.env.LINEAR_API_KEY = "lin_api_should_not_appear";
    try {
      const json = JSON.stringify(buildMcpServers("linear"));
      expect(json).not.toContain("should_not_appear");
      expect(json).toContain("${LINEAR_API_KEY}");
    } finally {
      delete process.env.LINEAR_API_KEY;
    }
  });

  it("gives a GitHub board the github_graphql server with the app's token command, never a token", () => {
    process.env.FORGE_GITHUB_TOKEN_COMMAND = '["/x/Forge","--github-token"]';
    try {
      const s = buildMcpServers("github")["forge-github"] as {
        args: string[];
        env: Record<string, string>;
      };
      expect(s.args[0]).toMatch(/mcp[/\\]github-graphql-server\.js$/);
      expect(s.env).toEqual({
        GITHUB_GRAPHQL_ENDPOINT: "https://api.github.com/graphql",
        GITHUB_TOKEN_COMMAND: '["/x/Forge","--github-token"]',
      });
    } finally {
      delete process.env.FORGE_GITHUB_TOKEN_COMMAND;
    }
  });

  it("gives other trackers no servers", () => {
    expect(buildMcpServers("memory")).toEqual({});
  });
});

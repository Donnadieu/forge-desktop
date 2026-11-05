import { describe, expect, it, vi } from "vitest";
import { callBasecamp, safePath } from "../../../src/mcp/basecamp-api-server.js";
import { buildMcpServers } from "../../../src/mcp/config.js";

const opts = { endpoint: "https://3.basecampapi.com", accountId: "999", token: async () => "tok" };

describe("basecamp_api tool", () => {
  it("calls the account's API with the app's token and returns the next page's path", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: {
            Link: '<https://3.basecampapi.com/999/buckets/42/recordings/1/comments.json?page=2>; rel="next"',
          },
        }),
    );
    const r = await callBasecamp(
      { method: "get", path: "/buckets/42/recordings/1/comments.json" },
      opts,
      fetchImpl as unknown as typeof fetch,
    );
    expect(r).toEqual({
      success: true,
      status: 200,
      data: [{ id: 1 }],
      next: "/buckets/42/recordings/1/comments.json?page=2",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://3.basecampapi.com/999/buckets/42/recordings/1/comments.json");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("redacts credential shapes from what the agent writes", async () => {
    // Built at run time so the repo holds no token-shaped string.
    const fake = `ghp_${"abcdefghij".repeat(4).slice(0, 36)}`;
    const fetchImpl = vi.fn(async () => new Response("", { status: 201 }));
    await callBasecamp(
      {
        method: "POST",
        path: "/buckets/42/recordings/1/comments.json",
        body: { content: `token ${fake}` },
      },
      opts,
      fetchImpl as unknown as typeof fetch,
    );
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(String(init.body)).not.toContain(fake);
  });

  it("refuses paths outside the account and unknown methods", async () => {
    expect(safePath("https://evil.example/x.json")).toBeNull();
    expect(safePath("/buckets/../../x.json")).toBeNull();
    expect(safePath("buckets/1.json")).toBeNull();
    expect(safePath("/buckets/1.json")).toBe("/buckets/1.json");
    const fetchImpl = vi.fn();
    const r = await callBasecamp(
      { method: "PATCH", path: "/x.json" },
      opts,
      fetchImpl as unknown as typeof fetch,
    );
    expect(r.success).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports Basecamp's refusal with its status", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"nope"}', { status: 403 }));
    const r = await callBasecamp(
      { method: "GET", path: "/projects.json" },
      opts,
      fetchImpl as unknown as typeof fetch,
    );
    expect(r).toMatchObject({ success: false, status: 403, data: { error: "nope" } });
  });
});

describe("agents' Basecamp server config", () => {
  it("names the account and the app's token command, never a token", () => {
    const before = process.env.FORGE_BASECAMP_TOKEN_COMMAND;
    process.env.FORGE_BASECAMP_TOKEN_COMMAND =
      '["/Applications/Forge.app/Contents/MacOS/Forge","--basecamp-token"]';
    try {
      const servers = buildMcpServers("basecamp", { accountId: "999" }) as Record<
        string,
        { args: string[]; env: Record<string, string> }
      >;
      expect(Object.keys(servers)).toEqual(["forge-basecamp"]);
      expect(servers["forge-basecamp"].args[0]).toMatch(/basecamp-api-server\.js$/);
      expect(servers["forge-basecamp"].env).toEqual({
        BASECAMP_ACCOUNT_ID: "999",
        BASECAMP_ENDPOINT: "https://3.basecampapi.com",
        BASECAMP_TOKEN_COMMAND:
          '["/Applications/Forge.app/Contents/MacOS/Forge","--basecamp-token"]',
      });
    } finally {
      if (before === undefined) delete process.env.FORGE_BASECAMP_TOKEN_COMMAND;
      else process.env.FORGE_BASECAMP_TOKEN_COMMAND = before;
    }
  });

  it("gives a Linear board only the Linear server", () => {
    expect(Object.keys(buildMcpServers("linear"))).toEqual(["forge-linear"]);
  });
});

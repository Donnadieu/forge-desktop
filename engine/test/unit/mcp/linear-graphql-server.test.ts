import { afterEach, describe, expect, it, vi } from "vitest";
import { executeGraphQL } from "../../../src/mcp/linear-graphql-server.js";

describe("MCP linear_graphql executeGraphQL", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(response: {
    ok: boolean;
    status?: number;
    statusText?: string;
    json: unknown;
  }) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status ?? 200,
      statusText: response.statusText ?? "OK",
      json: async () => response.json,
    });
  }

  const apiKey = "lin_api_test123";
  const endpoint = "https://api.linear.app/graphql";

  it("returns data from successful GraphQL query", async () => {
    const mockData = { issues: { nodes: [{ id: "1", title: "Test" }] } };
    mockFetch({ ok: true, json: { data: mockData } });

    const result = await executeGraphQL(
      "query { issues { nodes { id title } } }",
      undefined,
      apiKey,
      endpoint,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual(mockData);
    expect(globalThis.fetch).toHaveBeenCalledWith(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query: "query { issues { nodes { id title } } }",
        variables: undefined,
      }),
    });
  });

  it("passes variables correctly when provided", async () => {
    mockFetch({ ok: true, json: { data: { issue: { id: "1" } } } });
    const variables = { id: "issue-1" };

    await executeGraphQL("query ($id: ID!) { issue(id: $id) { id } }", variables, apiKey, endpoint);

    const callBody = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(callBody.variables).toEqual(variables);
  });

  it("scrubs secrets from agent-written query text and variables before sending", async () => {
    mockFetch({ ok: true, json: { data: {} } });
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345";

    await executeGraphQL(
      `mutation { commentCreate(input: { body: "leak ${key}" }) { success } }`,
      { body: `## Forge Workpad\n- saw ${key}`, id: "issue-1" },
      apiKey,
      endpoint,
    );

    const rawBody = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    expect(rawBody).not.toContain(key);
    const callBody = JSON.parse(rawBody);
    expect(callBody.variables).toEqual({
      body: "## Forge Workpad\n- saw [REDACTED]",
      id: "issue-1",
    });
  });

  it("returns error on HTTP failure", async () => {
    mockFetch({ ok: false, status: 401, statusText: "Unauthorized", json: {} });

    const result = await executeGraphQL("query { viewer { id } }", undefined, apiKey, endpoint);

    expect(result.success).toBe(false);
    expect(result.error).toBe("HTTP 401: Unauthorized");
  });

  it("returns error on GraphQL errors in response", async () => {
    mockFetch({
      ok: true,
      json: { errors: [{ message: "Field 'foo' not found" }, { message: "Syntax error" }] },
    });

    const result = await executeGraphQL("query { foo }", undefined, apiKey, endpoint);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Field 'foo' not found");
    expect(result.error).toContain("Syntax error");
  });

  it("uses provided endpoint", async () => {
    const customEndpoint = "https://custom.linear.dev/graphql";
    mockFetch({ ok: true, json: { data: {} } });

    await executeGraphQL("query { viewer { id } }", undefined, apiKey, customEndpoint);

    expect(globalThis.fetch).toHaveBeenCalledWith(customEndpoint, expect.any(Object));
  });

  it("returns success with data when response has data field", async () => {
    mockFetch({ ok: true, json: { data: { viewer: { id: "user-1", name: "Alice" } } } });

    const result = await executeGraphQL(
      "query { viewer { id name } }",
      undefined,
      apiKey,
      endpoint,
    );

    expect(result).toEqual({
      success: true,
      data: { viewer: { id: "user-1", name: "Alice" } },
    });
  });
});

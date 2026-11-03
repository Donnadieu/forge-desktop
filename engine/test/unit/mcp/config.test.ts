import { describe, expect, it } from "vitest";
import { buildMcpServers } from "../../../src/mcp/config.js";

/** The forge-pipeline child's `env:` map produced by buildMcpServers. */
function pipelineEnv(trackerKind = "linear"): Record<string, string> {
  const servers = buildMcpServers(trackerKind);
  const pipeline = servers["forge-pipeline"] as { env: Record<string, string> };
  expect(pipeline, "forge-pipeline server not configured").toBeTruthy();
  return pipeline.env;
}

describe("buildMcpServers forge-pipeline env (worker-spawned MCP)", () => {
  it("OMITS FORGE_FLY_API_TOKEN so the boot fail-fast does not fire on the worker", () => {
    // The build worker is factory-scope and its own process carries
    // FORGE_FLY_API_TOKEN. If that token reached the worker's forge-pipeline
    // child, assertFactoryMcpReady (server.ts) would run assertScaffoldDeployEnv
    // against the worker's env — which lacks STRIPE_SECRET_KEY, GH_TOKEN, the
    // internal token, Linear vars — and crash-loop every build's MCP. The worker
    // path is safe ONLY because this curated env omits the Fly token; assert that
    // contract so a future "thread everything through" change fails loudly here
    // instead of bricking builds.
    expect(pipelineEnv()).not.toHaveProperty("FORGE_FLY_API_TOKEN");
  });
});

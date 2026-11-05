import { describe, expect, it } from "vitest";
import { WorkflowConfigSchema } from "../../src/config/schema.js";
import { BasecampTracker } from "../../src/tracker/basecamp.js";
import { createCommandTokenFn } from "../../src/tracker/basecamp-token-provider.js";
import { LinearTracker } from "../../src/tracker/linear.js";
import { createTrackerFromConfig, tokenCommand } from "../../src/tracker-factory.js";

function config(tracker: Record<string, unknown>) {
  return WorkflowConfigSchema.parse({ tracker: { project_slug: "42", ...tracker } });
}

describe("createTrackerFromConfig", () => {
  it("builds a Basecamp board from the workflow file", () => {
    const t = createTrackerFromConfig(
      config({ kind: "basecamp", account_id: "999", card_table_id: "7", columns: { Todo: "1" } }),
      { FORGE_BASECAMP_TOKEN_COMMAND: '["/bin/echo"]' },
    );
    expect(t).toBeInstanceOf(BasecampTracker);
    expect(t.kind).toBe("basecamp");
  });

  it("builds a Linear board with the Linear key", () => {
    const t = createTrackerFromConfig(config({ kind: "linear" }), { LINEAR_API_KEY: "k" });
    expect(t).toBeInstanceOf(LinearTracker);
  });
});

describe("tokenCommand", () => {
  it("reads a JSON array, so a path with spaces stays one argument", () => {
    expect(tokenCommand('["/Apps/My Forge.app/Contents/MacOS/Forge","--basecamp-token"]')).toEqual([
      "/Apps/My Forge.app/Contents/MacOS/Forge",
      "--basecamp-token",
    ]);
    expect(tokenCommand("forge --basecamp-token")).toBeNull();
    expect(tokenCommand("[]")).toBeNull();
    expect(tokenCommand(undefined)).toBeNull();
  });
});

describe("createCommandTokenFn", () => {
  it("reads the token and its expiry from the command's last line", async () => {
    const fn = createCommandTokenFn({
      command: ["forge", "--basecamp-token"],
      runCommand: async () => 'note\n{"access_token":"abc","expires_at":1800000000}\n',
    });
    await expect(fn()).resolves.toEqual({ accessToken: "abc", expiresAtMs: 1_800_000_000_000 });
  });

  it("fails in plain words when the command prints no token", async () => {
    const fn = createCommandTokenFn({ command: ["x"], runCommand: async () => "{}" });
    await expect(fn()).rejects.toThrow("the sign-in command printed no token");
  });

  it("passes on the app's reason when the command fails", async () => {
    const fn = createCommandTokenFn({
      command: ["/bin/sh", "-c", "echo 'Sign in to Basecamp again.' >&2; exit 3"],
    });
    await expect(fn()).rejects.toThrow("Sign in to Basecamp again.");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeCodeAdapter,
  CodexAdapter,
  createAgent,
  KimiAdapter,
} from "../../../src/agent/index.js";

const ENV_KEYS = [
  "KIMI_API_KEY",
  "FORGE_WORKER_MODEL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

describe("createAgent", () => {
  let saved: Record<string, string | undefined>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // Suppress compat warnings — checked separately in compat.test.ts.
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("returns ClaudeCodeAdapter for kind=claude", () => {
    expect(createAgent("claude")).toBeInstanceOf(ClaudeCodeAdapter);
  });

  it("returns ClaudeCodeAdapter for kind=mimo (shared adapter)", () => {
    expect(createAgent("mimo")).toBeInstanceOf(ClaudeCodeAdapter);
  });

  it("returns CodexAdapter for kind=codex", () => {
    expect(createAgent("codex")).toBeInstanceOf(CodexAdapter);
  });

  it("returns KimiAdapter for kind=kimi", () => {
    process.env.KIMI_API_KEY = "test-key";
    expect(createAgent("kimi", { model: "kimi-k2.7-code" })).toBeInstanceOf(KimiAdapter);
  });

  it("forwards envDenylist to the adapter (FRG-4081)", () => {
    for (const kind of ["claude", "codex"]) {
      const agent = createAgent(kind, { envDenylist: ["*DATABASE_URL*"] });
      expect((agent as unknown as { envDenylist: string[] }).envDenylist).toEqual([
        "*DATABASE_URL*",
      ]);
    }
  });

  it("throws for unknown kind", () => {
    expect(() => createAgent("nonexistent")).toThrow(/Unknown agent kind/);
  });

  it("builds a KimiAdapter without KIMI_API_KEY so a held BYOK Smith boots (FRG-4532)", () => {
    expect(createAgent("kimi", { model: "kimi-k2.7-code" })).toBeInstanceOf(KimiAdapter);
  });
});

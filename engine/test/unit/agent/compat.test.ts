import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAgentModelCompat } from "../../../src/agent/compat.js";

describe("checkAgentModelCompat", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      warnings.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("is a no-op when model is undefined", () => {
    checkAgentModelCompat("kimi", undefined);
    expect(warnings).toEqual([]);
  });

  describe("kimi", () => {
    it("does not warn for kimi-prefixed model", () => {
      checkAgentModelCompat("kimi", "kimi-k2.7-code");
      expect(warnings).toEqual([]);
    });

    it("does not warn for moonshot model", () => {
      checkAgentModelCompat("kimi", "moonshot-v1");
      expect(warnings).toEqual([]);
    });

    it("warns when model contains neither kimi nor moonshot", () => {
      checkAgentModelCompat("kimi", "gpt-4");
      expect(warnings.join("")).toMatch(/Agent "kimi".*"gpt-4"/);
    });

    it("matches case-insensitively", () => {
      checkAgentModelCompat("kimi", "Kimi-K2.7-code");
      expect(warnings).toEqual([]);
    });
  });

  describe("claude", () => {
    it("does not warn for an Anthropic-style model", () => {
      checkAgentModelCompat("claude", "claude-opus-4-7");
      expect(warnings).toEqual([]);
    });

    it("warns when model is gpt-*", () => {
      checkAgentModelCompat("claude", "gpt-4");
      expect(warnings.join("")).toMatch(/Agent "claude".*Anthropic models/);
    });

    it("warns when model is codex-*", () => {
      checkAgentModelCompat("claude", "codex-mini");
      expect(warnings.join("")).toMatch(/Agent "claude"/);
    });
  });

  describe("codex", () => {
    it("does not warn for gpt models", () => {
      checkAgentModelCompat("codex", "gpt-5.3-codex");
      expect(warnings).toEqual([]);
    });

    it("does not warn for o1/o3/o4 reasoning models", () => {
      checkAgentModelCompat("codex", "o3-mini");
      checkAgentModelCompat("codex", "o4");
      expect(warnings).toEqual([]);
    });

    it("warns for non-OpenAI models", () => {
      checkAgentModelCompat("codex", "claude-opus-4-7");
      expect(warnings.join("")).toMatch(/Agent "codex".*OpenAI models/);
    });
  });

  it("does not warn for unknown agent kinds (no opinion expressed)", () => {
    checkAgentModelCompat("hermes", "anything");
    checkAgentModelCompat("mimo", "kimi-k2.7-code");
    expect(warnings).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { bareModelId } from "../../../src/config/index.js";

describe("bareModelId", () => {
  it.each([
    ["o3", "o3"],
    ["openai/o3", "o3"],
    ["anthropic/claude-opus-4-6", "claude-opus-4-6"],
    ["openrouter/anthropic/claude-opus-4-8", "claude-opus-4-8"],
    ["ft:o4-mini:org::id", "ft:o4-mini:org::id"],
    ["openai/", ""],
    ["", ""],
  ])("%j → %j", (model, expected) => {
    expect(bareModelId(model)).toBe(expected);
  });

  it("matches the split/pop idiom it replaced", () => {
    for (const model of ["o3", "a/b", "a/b/c", "a/", "/x", ""]) {
      expect(bareModelId(model)).toBe(model.split("/").pop());
    }
  });
});

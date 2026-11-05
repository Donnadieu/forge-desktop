import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveAgentLimit } from "../../../src/orchestrator/dispatcher.js";
import { SharedSlots } from "../../../src/orchestrator/shared-slots.js";

describe("the ceiling across every engine on the Mac (Forge Desktop)", () => {
  it("counts the other live engines' agents", () => {
    const dir = mkdtempSync(join(tmpdir(), "slots-"));
    const a = new SharedSlots(dir, "/forge/projects/a", 6);
    const b = new SharedSlots(dir, "/forge/projects/b", 6);
    a.publish(4);
    expect(b.limit(0)).toBe(2);
    b.publish(2);
    expect(a.limit(4)).toBe(4);
  });

  it("forgets an engine whose process is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "slots-"));
    writeFileSync(join(dir, "gone.json"), JSON.stringify({ pid: 999_999_999, inFlight: 5 }));
    const a = new SharedSlots(dir, "a", 6);
    expect(a.others()).toBe(0);
    expect(readdirSync(dir)).not.toContain("gone.json");
  });

  it("a stopped engine stops counting", () => {
    const dir = mkdtempSync(join(tmpdir(), "slots-"));
    const a = new SharedSlots(dir, "a", 6);
    const b = new SharedSlots(dir, "b", 6);
    a.publish(3);
    a.close();
    expect(b.others()).toBe(0);
  });

  it("an engine never goes over its own number or the ceiling", () => {
    expect(effectiveAgentLimit({ maxConcurrentAgents: 4 }, 0)).toBe(4);
    expect(effectiveAgentLimit({ maxConcurrentAgents: 4, agentLimit: () => 2 }, 0)).toBe(2);
    expect(effectiveAgentLimit({ maxConcurrentAgents: 4, agentLimit: () => 9 }, 0)).toBe(4);
  });
});

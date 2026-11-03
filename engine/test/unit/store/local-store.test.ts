import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalStore } from "../../../src/store/local-store.js";

describe("local store", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("starts stopped and remembers Start and Stop across a reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-store-"));
    dirs.push(dir);
    const path = join(dir, "forge.sqlite");
    const a = openLocalStore(path);
    expect(a.readDesired()).toBe("stopped");
    a.writeDesired("running");
    a.close();
    const b = openLocalStore(path);
    expect(b.readDesired()).toBe("running");
    b.writeDesired("stopped");
    expect(b.readDesired()).toBe("stopped");
    b.close();
  });

  it("adds up tokens from finished runs since a time", () => {
    const s = openLocalStore(":memory:");
    const run = (finishedAt: string, input: number) =>
      s.recordRun({
        issueId: "i",
        identifier: "ABC-1",
        outcome: "completed",
        startedAt: finishedAt,
        finishedAt,
        inputTokens: input,
        outputTokens: 10,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
      });
    run("2026-11-01T00:00:00.000Z", 100);
    run("2026-11-03T00:00:00.000Z", 5);
    expect(s.usageSince()).toEqual({
      runs: 2,
      inputTokens: 105,
      outputTokens: 20,
      cacheReadTokens: 2,
      cacheWriteTokens: 4,
    });
    expect(s.usageSince("2026-11-02T00:00:00.000Z").inputTokens).toBe(5);
    s.close();
  });
});

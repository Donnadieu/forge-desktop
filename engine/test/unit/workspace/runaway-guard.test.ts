import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHECK_EVERY_MS,
  folderBytes,
  RunawayGuard,
  type RunningFolder,
  stopReason,
} from "../../../src/workspace/runaway-guard.js";

const GB = 1024 ** 3;

function setup(sizes: Record<string, number>, free = 0.5) {
  const stopped: string[] = [];
  const cards: RunningFolder[] = Object.keys(sizes).map((id) => ({
    issueId: id,
    identifier: `BC-${id}`,
    stage: "QA",
    path: `/ws/${id}`,
  }));
  const deps = {
    workspaceRoot: "/ws",
    running: () => cards,
    stop: (id: string) => stopped.push(id),
    measure: async (p: string) => sizes[p.split("/").pop() as string] ?? null,
    freeRatio: async () => free,
  };
  return { stopped, cards, deps, sizes, setFree: (r: number) => (free = r) };
}

describe("RunawayGuard", () => {
  it("stops a card whose folder grew more than 5 GB in one run, and holds it until it moves", async () => {
    const g = new RunawayGuard();
    const t = setup({ a: 2 * GB, b: 2 * GB });
    await g.check(t.deps); // baseline
    t.sizes.a = 80 * GB; // the 78 GB transcript
    t.sizes.b = 3 * GB;
    await g.check(t.deps);
    expect(t.stopped).toEqual(["a"]);
    expect(g.holds("a")).toBe(true);
    expect(g.snapshot().stopped).toEqual([
      expect.objectContaining({ issue_identifier: "BC-a", grew_gb: 78, why: "folder" }),
    ]);
    g.forgetMoved([{ id: "a", state: "QA" }]);
    expect(g.holds("a")).toBe(true);
    g.forgetMoved([{ id: "a", state: "Rework" }]);
    expect(g.holds("a")).toBe(false);
  });

  it("on a nearly full disk stops only the card that grew most (at least 1 GB)", async () => {
    const g = new RunawayGuard();
    const t = setup({ a: GB, b: GB, c: GB });
    await g.check(t.deps);
    t.sizes.a = 3 * GB;
    t.sizes.b = 4.5 * GB;
    t.sizes.c = 1.2 * GB;
    t.setFree(0.04);
    await g.check(t.deps);
    expect(t.stopped).toEqual(["b"]);
    expect(g.snapshot()).toMatchObject({ low_space: true, free_pct: 4 });
  });

  it("stops nothing when the disk is full for another reason", async () => {
    const g = new RunawayGuard();
    const t = setup({ a: GB }, 0.04);
    await g.check(t.deps);
    t.sizes.a = 1.5 * GB;
    await g.check(t.deps);
    expect(t.stopped).toEqual([]);
    expect(g.snapshot().low_space).toBe(true);
  });

  it("Start lets stopped cards run again", async () => {
    const g = new RunawayGuard();
    const t = setup({ a: GB });
    await g.check(t.deps);
    t.sizes.a = 7 * GB;
    await g.check(t.deps);
    g.release();
    expect(g.holds("a")).toBe(false);
    expect(g.snapshot().stopped).toEqual([]);
  });

  it("checks at most every 30 seconds", async () => {
    const g = new RunawayGuard();
    let now = 0;
    let measured = 0;
    const t = setup({ a: GB });
    const deps = {
      ...t.deps,
      now: () => now,
      measure: async () => {
        measured++;
        return GB;
      },
    };
    await g.maybeCheck(deps);
    now = CHECK_EVERY_MS - 1;
    await g.maybeCheck(deps);
    now = CHECK_EVERY_MS;
    await g.maybeCheck(deps);
    expect(measured).toBe(2);
  });

  it("says why in plain words", () => {
    expect(stopReason({ grewBytes: 78 * GB, why: "folder" }, 4)).toContain("grew by 78 GB");
    expect(stopReason({ grewBytes: 3 * GB, why: "disk" }, 4)).toContain("4% free");
  });

  it("measures a real folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runaway-"));
    try {
      await writeFile(join(dir, "f"), Buffer.alloc(2 * 1024 * 1024, 1));
      const bytes = await folderBytes(dir);
      expect(bytes).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

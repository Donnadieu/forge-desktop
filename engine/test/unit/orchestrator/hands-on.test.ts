import { describe, expect, it } from "vitest";
import { HandsOn } from "../../../src/orchestrator/hands-on.js";

describe("taking the wheel of a running card", () => {
  it("gives Forge's own turn when nobody holds the wheel", async () => {
    expect(await new HandsOn().next("a")).toBeNull();
  });

  it("waits for the person's message, which becomes the next turn", async () => {
    const h = new HandsOn();
    h.take("a");
    expect(h.offer("a", "too early")).toBe(false);
    const next = h.next("a", { everyMs: 5 });
    expect(h.waiting("a")).toBe(true);
    expect(h.offer("a", "use the old API")).toBe(true);
    expect(await next).toBe("use the old API");
    expect(h.isOn("a")).toBe(true);
  });

  it("goes on by itself once handed back, stopped or aborted", async () => {
    const h = new HandsOn();
    h.take("a");
    const back = h.next("a", { everyMs: 5 });
    expect(h.give("a")).toBe(true);
    expect(await back).toBeNull();
    expect(h.give("a")).toBe(false);

    h.take("b");
    let stop = false;
    let alive = 0;
    const stopped = h.next("b", { everyMs: 5, stopping: () => stop, alive: () => alive++ });
    await new Promise((r) => setTimeout(r, 20));
    stop = true;
    expect(await stopped).toBeNull();
    expect(alive).toBeGreaterThan(0);

    const ac = new AbortController();
    const aborted = h.next("b", { signal: ac.signal, everyMs: 5 });
    ac.abort();
    expect(await aborted).toBeNull();
    h.forget("b");
    expect(h.isOn("b")).toBe(false);
  });
});

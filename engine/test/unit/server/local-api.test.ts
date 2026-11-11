import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type LocalApi, startLocalApi } from "../../../src/server/local-api.js";

const TOKEN = "t".repeat(48);

function nextMessage(ws: WebSocket): Promise<{ type: string; state: { n: number } }> {
  return new Promise((resolve) => ws.once("message", (d) => resolve(JSON.parse(String(d)))));
}

describe("local API", () => {
  let api: LocalApi | undefined;
  afterEach(async () => {
    await api?.close();
    api = undefined;
  });

  const boot = async (state: { n: number }, calls: string[] = []) => {
    api = await startLocalApi({
      token: TOKEN,
      getState: () => ({ ...state }),
      start: async () => {
        calls.push("start");
        return { started: true };
      },
      stop: async () => {
        calls.push("stop");
        return { stopped: true };
      },
      refresh: () => calls.push("refresh"),
      move: async (id, to) => {
        calls.push(`move ${id} ${to}`);
        return to === "Done" ? { ok: false, problem: "no" } : { ok: true };
      },
      nextStep: async (id, stage) => {
        calls.push(`next ${id} ${stage}`);
        return stage === "QA" ? { ok: true, ran: "here" } : { ok: false, problem: "no" };
      },
      steer: (id, text) => {
        calls.push(`steer ${id} ${text}`);
        return id === "abc-1";
      },
      takeWheel: (id) => {
        calls.push(`take ${id}`);
        return id === "abc-1";
      },
      handBack: (id) => {
        calls.push(`back ${id}`);
        return false;
      },
      pushCheckMs: 20,
    });
    return `http://127.0.0.1:${api.port}`;
  };

  it("binds to 127.0.0.1 only", async () => {
    await boot({ n: 1 });
    const addr = api?.server.address();
    expect(typeof addr === "object" && addr?.address).toBe("127.0.0.1");
  });

  it("refuses a request without the launch token", async () => {
    const base = await boot({ n: 1 });
    expect((await fetch(`${base}/api/v1/state`)).status).toBe(401);
    const wrong = await fetch(`${base}/api/v1/state`, {
      headers: { authorization: `Bearer ${"x".repeat(48)}` },
    });
    expect(wrong.status).toBe(401);
  });

  it("answers with the token: state, start, stop, refresh", async () => {
    const calls: string[] = [];
    const base = await boot({ n: 7 }, calls);
    const auth = { authorization: `Bearer ${TOKEN}` };
    const state = await fetch(`${base}/api/v1/state`, { headers: auth });
    expect(await state.json()).toEqual({ n: 7 });
    for (const p of ["start", "stop", "refresh"]) {
      const r = await fetch(`${base}/api/v1/${p}`, { method: "POST", headers: auth });
      expect(r.ok).toBe(true);
    }
    expect(calls).toEqual(["start", "stop", "refresh"]);
  });

  it("steers a running card's agent, and says so when none runs it", async () => {
    const calls: string[] = [];
    const base = await boot({ n: 1 }, calls);
    const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const send = (id: string, body: string) =>
      fetch(`${base}/api/v1/cards/${id}/message`, { method: "POST", headers: auth, body });
    expect((await send("abc-1", JSON.stringify({ text: "use the old API" }))).status).toBe(200);
    const idle = await send("abc-2", JSON.stringify({ text: "hello" }));
    expect(idle.status).toBe(409);
    expect(await idle.json()).toEqual({
      ok: false,
      problem: "No agent is working this card right now.",
    });
    expect((await send("abc-1", JSON.stringify({ text: "  " }))).status).toBe(400);
    expect(
      (await fetch(`${base}/api/v1/cards/abc-1/message`, { method: "POST", body: "{}" })).status,
    ).toBe(401);
    expect(calls).toEqual(["steer abc-1 use the old API", "steer abc-2 hello"]);
  });

  it("takes the wheel of a running card and hands it back", async () => {
    const calls: string[] = [];
    const base = await boot({ n: 1 }, calls);
    const auth = { authorization: `Bearer ${TOKEN}` };
    const post = (p: string) =>
      fetch(`${base}/api/v1/cards/${p}`, { method: "POST", headers: auth });
    expect((await post("abc-1/stop-turn")).status).toBe(200);
    expect((await post("abc-2/stop-turn")).status).toBe(409);
    const back = await post("abc-1/hand-back");
    expect(back.status).toBe(409);
    expect(await back.json()).toEqual({ ok: false, problem: "Forge already has this card." });
    expect(calls).toEqual(["take abc-1", "take abc-2", "back abc-1"]);
  });

  it("moves a card when asked, and refuses a move without a column", async () => {
    const calls: string[] = [];
    const base = await boot({ n: 1 }, calls);
    const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const ok = await fetch(`${base}/api/v1/cards/abc-1/move`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ to: "Merging" }),
    });
    expect(ok.status).toBe(200);
    const refused = await fetch(`${base}/api/v1/cards/abc-1/move`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ to: "Done" }),
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, problem: "no" });
    const empty = await fetch(`${base}/api/v1/cards/abc-1/move`, {
      method: "POST",
      headers: auth,
      body: "{}",
    });
    expect(empty.status).toBe(400);
    expect(
      (await fetch(`${base}/api/v1/cards/abc-1/move`, { method: "POST", body: "{}" })).status,
    ).toBe(401);
    expect(calls).toEqual(["move abc-1 Merging", "move abc-1 Done"]);
  });

  it("runs the next step the person picked for a card", async () => {
    const calls: string[] = [];
    const base = await boot({ n: 1 }, calls);
    const headers = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };
    const ok = await fetch(`${base}/api/v1/cards/abc-1/next-step`, {
      method: "POST",
      headers,
      body: JSON.stringify({ to: "QA" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, ran: "here" });
    const refused = await fetch(`${base}/api/v1/cards/abc-1/next-step`, {
      method: "POST",
      headers,
      body: JSON.stringify({ to: "simplify" }),
    });
    expect(refused.status).toBe(409);
    expect(calls).toEqual(["next abc-1 QA", "next abc-1 simplify"]);
  });

  it("refuses a live connection without the token", async () => {
    const base = await boot({ n: 1 });
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/v1/live`);
    const failed = await new Promise<boolean>((r) => {
      ws.on("error", () => r(true));
      ws.on("open", () => r(false));
    });
    expect(failed).toBe(true);
  });

  it("pushes the state at once and again whenever it changes", async () => {
    const state = { n: 1 };
    const base = await boot(state);
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/v1/live`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const first = await nextMessage(ws);
    expect(first).toEqual({ type: "state", state: { n: 1 } });
    const second = nextMessage(ws);
    state.n = 2;
    expect((await second).state.n).toBe(2);
    ws.close();
  });
});

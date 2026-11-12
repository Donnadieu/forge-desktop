import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionsHost } from "../../../src/sessions/host.js";
import { SessionStore } from "../../../src/sessions/store.js";
import type { EventRecord, SessionRecord } from "../../../src/sessions/types.js";

// The agent's questions, Stop, and messages that can't reach the agent (Omar's ATC-1742 "Chat 2", Nov 12): the
// stand-in agent behaves like Claude Code 2.1.322 does while an AskUserQuestion waits (fake-claude.mjs).
const FAKE = join(import.meta.dirname, "../../fixtures/sessions/fake-claude.mjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BOTH = (a: string) => `answered: Which colour?=${a}; Which size?=${a}`;

describe("a chat whose agent asks a question (stand-in agent)", () => {
  let dir: string;
  let store: SessionStore;
  let host: SessionsHost;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-questions-"));
    const folder = join(dir, "work");
    execFileSync("git", ["init", "-q", "-b", "main", folder]);
    execFileSync("git", [
      "-C",
      folder,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "start",
    ]);
    store = new SessionStore(join(dir, "s.sqlite"));
    host = new SessionsHost(store, {
      home: dir,
      command: FAKE,
      notify: () => {},
      chatTimings: { deliveryMs: 300, stopGraceMs: 300 },
    });
    const now = new Date().toISOString();
    const s: SessionRecord = {
      id: "s1",
      workspaceId: "w",
      origin: "person",
      repo: "acme/app",
      folder,
      branch: "main",
      base: "main",
      title: "t",
      titleByHand: false,
      githubLogin: null,
      prNumber: null,
      prState: null,
      prTitle: null,
      unread: false,
      archived: false,
      archiveRef: null,
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(s);
  });

  afterEach(async () => {
    await host.chats.closeAll();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function events(chatId: string): EventRecord[] {
    return store.turns(chatId, null, 20).flatMap((t) => t.events);
  }

  async function until<T>(f: () => T | undefined | false, what: string, ms = 3000): Promise<T> {
    for (let i = 0; i < ms / 20; i++) {
      const v = f();
      if (v) return v;
      await sleep(20);
    }
    throw new Error(`never happened: ${what}`);
  }

  const idle = (chatId: string, ms = 3000) =>
    until(
      () => ["idle", "failed"].includes(store.chat(chatId)?.state ?? ""),
      "the chat went idle",
      ms,
    );
  const question = (chatId: string) =>
    until(() => events(chatId).find((e) => e.kind === "question"), "the agent asked its question");

  it("sends a message written while the question waits as its answer, shown as the answer", async () => {
    const c = host.newChat("s1", "opus", "high", "Chat");
    await host.chats.send(c.id, "ask me", "steer");
    await question(c.id);
    expect(store.chat(c.id)?.state).toBe("needs_you");
    await host.chats.send(c.id, "blue", "steer");
    await idle(c.id);
    const [t] = store.turns(c.id, null, 10);
    expect(t.status).toBe("done");
    // The agent got it as the answer to both questions (the tool's answer, not a message stuck in its queue).
    expect(t.events.at(-1)?.text).toBe(BOTH("blue"));
    expect(t.events.find((e) => e.kind === "question")?.data).toMatchObject({
      answered: true,
      typed: "blue",
      answers: { "Which colour?": "blue", "Which size?": "blue" },
    });
    expect(t.events.filter((e) => e.name === "steered")).toEqual([]);
  });

  it("answers the question with the options picked", async () => {
    const c = host.newChat("s1", "opus", "high", "Chat");
    await host.chats.send(c.id, "ask me", "steer");
    const q = await question(c.id);
    const r = await host.chats.answer(c.id, q.id, {
      allow: true,
      answers: { "Which colour?": "Red", "Which size?": "Large" },
    });
    expect(r).toEqual({ ok: true });
    await idle(c.id);
    expect(events(c.id).at(-1)?.text).toBe("answered: Which colour?=Red; Which size?=Large");
  });

  it("delivers several messages sent while the question waits, in order", async () => {
    const c = host.newChat("s1", "opus", "high", "Chat");
    await host.chats.send(c.id, "ask me", "steer");
    await question(c.id);
    await host.chats.send(c.id, "a", "steer");
    await host.chats.send(c.id, "b", "steer");
    await host.chats.send(c.id, "c", "steer");
    await idle(c.id);
    const all = events(c.id);
    expect(all.at(-1)?.text).toBe(`${BOTH("a")}; steered: b, c`);
    const steers = all.filter((e) => e.name === "steered");
    expect(steers.map((e) => [e.text, e.data])).toEqual([
      ["b", { delivery: "delivered" }],
      ["c", { delivery: "delivered" }],
    ]);
  });

  it("runs messages queued for after the turn one turn each, in order", async () => {
    const c = host.newChat("s1", "opus", "high", "Chat");
    await host.chats.send(c.id, "first", "steer");
    for (const m of ["one", "two", "three"]) await host.chats.send(c.id, m, "queue");
    await until(
      () => store.turns(c.id, null, 10).length === 4 && store.chat(c.id)?.state === "idle",
      "four turns ran",
      8000,
    );
    expect(store.turns(c.id, null, 10).map((t) => [t.userText, t.status])).toEqual([
      ["first", "done"],
      ["one", "done"],
      ["two", "done"],
      ["three", "done"],
    ]);
  });

  it("Stop while the question waits ends the turn and closes the question", async () => {
    const c = host.newChat("s1", "opus", "high", "Chat");
    await host.chats.send(c.id, "ask me", "steer");
    await question(c.id);
    host.chats.stop(c.id);
    await idle(c.id, 1500);
    const [t] = store.turns(c.id, null, 10);
    expect(t.status).toBe("stopped");
    expect(t.events.find((e) => e.kind === "question")?.data).toMatchObject({
      answered: true,
      stopped: true,
    });
  });

  it("Stop ends the turn even when the agent never answers it", async () => {
    const c = host.newChat("s1", "opus", "high", "Chat");
    await host.chats.send(c.id, "ask me and hang", "steer");
    await question(c.id);
    host.chats.stop(c.id);
    await idle(c.id, 2000);
    expect(store.turns(c.id, null, 10)[0].status).toBe("stopped");
    // The chat works again afterwards.
    await host.chats.send(c.id, "hello", "steer");
    await idle(c.id);
    expect(events(c.id).at(-1)?.text).toBe("answer: hello");
  });

  it("says Not delivered when the agent can't read a message in time, and Delivered once it does", async () => {
    const c = host.newChat("s1", "opus", "high", "Chat");
    await host.chats.send(c.id, "think slowly", "steer");
    await sleep(50);
    await host.chats.send(c.id, "are you there?", "steer");
    const steer = () => events(c.id).find((e) => e.name === "steered");
    await until(() => steer()?.data?.delivery === "failed", "the steer said Not delivered", 1500);
    // The agent reads it after its long step (Claude Code runs it as a turn of its own): Delivered after all.
    await until(
      () => events(c.id).some((e) => e.text === "answer: are you there?"),
      "the agent answered it",
      6000,
    );
    expect(steer()?.data).toEqual({ delivery: "delivered" });
  });

  it("doesn't call a message undelivered while the agent runs a long tool call", async () => {
    const c = host.newChat("s1", "opus", "high", "Chat");
    await host.chats.send(c.id, "work slowly", "steer");
    await sleep(100);
    await host.chats.send(c.id, "also this", "steer");
    await sleep(900);
    const steer = () => events(c.id).find((e) => e.name === "steered");
    expect(steer()?.data).toEqual({ delivery: "sending" });
    await idle(c.id);
    expect(steer()?.data).toEqual({ delivery: "delivered" });
  });

  it("a message in flight when Stop is pressed says Not delivered, and Retry sends it again", async () => {
    const c = host.newChat("s1", "opus", "high", "Chat");
    await host.chats.send(c.id, "think slowly", "steer");
    await sleep(50);
    await host.chats.send(c.id, "then this", "steer");
    host.chats.stop(c.id);
    await idle(c.id, 2000);
    const failed = await until(
      () => events(c.id).find((e) => e.name === "steered" && e.data?.delivery === "failed"),
      "the message in flight said Not delivered",
    );
    expect(failed.text).toBe("then this");
    // Stop means stop: the agent doesn't run it as a turn of its own afterwards.
    await sleep(500);
    expect(store.chat(c.id)?.state).toBe("idle");
    expect(events(c.id).some((e) => e.text === "answer: then this")).toBe(false);
    const r = await host.chats.retry(c.id, failed.id);
    expect(r).toEqual({ ok: true });
    await until(
      () => events(c.id).some((e) => e.text === "answer: then this"),
      "Retry sent it again",
    );
    await idle(c.id);
    expect(events(c.id).filter((e) => e.text === "then this").length).toBe(1);
  });
});

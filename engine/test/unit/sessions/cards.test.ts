import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardWatcher, type WatchedCard } from "../../../src/sessions/cards.js";
import { transcriptPath } from "../../../src/sessions/checkpoints.js";
import { SessionStore } from "../../../src/sessions/store.js";

describe("card sessions (a card's agent followed from its transcript)", () => {
  let dir: string;
  let store: SessionStore;
  let watcher: CardWatcher;
  const frames: Record<string, unknown>[] = [];
  const card: WatchedCard = {
    key: "proj-1:abc-1",
    workspaceId: "ws",
    identifier: "CE-142",
    title: "Fix the invoice total",
    folder: "/tmp/forge-workspaces/CE-142",
    sessionId: "11111111-2222-3333-4444-555555555555",
    branch: "ce-142-fix",
    repo: "acme/app",
    model: "opus[1m]",
  };
  const write = (line: Record<string, unknown>) => {
    const p = transcriptPath(card.folder, card.sessionId, join(dir, "claude"));
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify(line)}\n`);
  };
  const assistant = (content: Record<string, unknown>[], stop = "tool_use") => ({
    type: "assistant",
    message: { role: "assistant", content, stop_reason: stop },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-cards-"));
    store = new SessionStore(join(dir, "s.sqlite"));
    frames.length = 0;
    watcher = new CardWatcher(
      store,
      (f) => frames.push(f),
      () => {},
      join(dir, "claude"),
    );
  });
  afterEach(() => {
    watcher.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows a running card as a session with its turns, steers and tool calls", () => {
    expect(watcher.watch([card])).toEqual(["card-proj-1-abc-1"]);
    const s = store.session("card-proj-1-abc-1");
    expect(s?.origin).toBe("card");
    expect(s?.title).toBe("CE-142 Fix the invoice total");
    write({ type: "user", message: { role: "user", content: "Work on CE-142" } });
    write(
      assistant([
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "app/models/invoice.rb" } },
      ]),
    );
    write({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    });
    write({ type: "user", message: { role: "user", content: "use the old API" } });
    write({
      type: "assistant",
      isSidechain: true,
      message: { content: [{ type: "text", text: "helper" }] },
    });
    write(assistant([{ type: "text", text: "Done." }], "end_turn"));
    watcher.poll();
    const turns = store.turns("card-proj-1-abc-1-chat", null, 50);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.userText).toBe("Work on CE-142");
    expect(turns[0]?.status).toBe("done");
    const kinds = turns[0]?.events.map((e) => e.kind);
    expect(kinds).toEqual(["user", "tool", "tool_result", "user", "text"]);
    expect(turns[0]?.events.some((e) => e.text === "helper")).toBe(false);
    expect(store.chat("card-proj-1-abc-1-chat")?.state).toBe("working");
  });

  // Claude Code 2.1.32x writes a message sent mid-turn as a queue entry (`queue-operation` enqueue), then a
  // `queued_command` attachment and a `remove … absorbed_mid_turn` once the agent reads it: never a `user` line.
  it("shows the person's steer at once, before the agent's reply, and keeps it after a restart", () => {
    const chat = "card-proj-1-abc-1-chat";
    watcher.watch([card]);
    write({ type: "user", message: { role: "user", content: "Work on CE-142" } });
    write(assistant([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.rb" } }]));
    write({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-11-11T19:58:21.607Z",
      content: "Why do we have 17961 files changed?",
    });
    watcher.poll();
    const steers = () =>
      store
        .turns(chat, null, 50)
        .flatMap((t) => t.events)
        .filter((e) => e.kind === "user" && e.name === "steered");
    expect(steers().map((e) => [e.text, (e.data as { delivery?: string })?.delivery])).toEqual([
      ["Why do we have 17961 files changed?", "sending"],
    ]);
    write({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    });
    write({
      type: "attachment",
      attachment: {
        type: "queued_command",
        prompt: "Why do we have 17961 files changed?",
        commandMode: "prompt",
      },
    });
    write({
      type: "queue-operation",
      operation: "remove",
      content: "Why do we have 17961 files changed?",
      reason: "absorbed_mid_turn",
    });
    write(assistant([{ type: "text", text: "Good catch — let me check what's going on." }]));
    write({
      type: "queue-operation",
      operation: "enqueue",
      content: "<task-notification>\n<task-id>b1</task-id>\n</task-notification>",
    });
    write({
      type: "attachment",
      attachment: {
        type: "queued_command",
        prompt: "<task-notification>…",
        commandMode: "task-notification",
      },
    });
    watcher.poll();
    const order = (turns: ReturnType<typeof store.turns>) =>
      turns[0]?.events.map((e) => `${e.kind}${e.name === "steered" ? ":steered" : ""}`);
    expect(order(store.turns(chat, null, 50))).toEqual([
      "user",
      "tool",
      "user:steered",
      "tool_result",
      "text",
    ]);
    expect(steers().map((e) => (e.data as { delivery?: string })?.delivery)).toEqual(["delivered"]);

    // The host restarts: a new watcher reads the same transcript into the same store.
    watcher.close();
    watcher = new CardWatcher(
      store,
      (f) => frames.push(f),
      () => {},
      join(dir, "claude"),
    );
    watcher.watch([card]);
    expect(store.turnCount(chat)).toBe(1);
    expect(steers().map((e) => [e.text, (e.data as { delivery?: string })?.delivery])).toEqual([
      ["Why do we have 17961 files changed?", "delivered"],
    ]);
    expect(order(store.turns(chat, null, 50))).toEqual([
      "user",
      "tool",
      "user:steered",
      "tool_result",
      "text",
    ]);
  });

  it("a steer that arrives as the turn ends becomes the next turn, shown once", () => {
    const chat = "card-proj-1-abc-1-chat";
    watcher.watch([card]);
    write({ type: "user", message: { role: "user", content: "Work on CE-142" } });
    write({ type: "queue-operation", operation: "enqueue", content: "and the tests" });
    watcher.poll();
    write(assistant([{ type: "text", text: "Done." }], "end_turn"));
    write({ type: "queue-operation", operation: "dequeue" });
    write({ type: "user", message: { role: "user", content: "and the tests" } });
    write(assistant([{ type: "text", text: "Tests added." }], "end_turn"));
    watcher.poll();
    const turns = store.turns(chat, null, 50);
    expect(turns.map((t) => t.userText)).toEqual(["Work on CE-142", "and the tests"]);
    const mine = turns.flatMap((t) => t.events).filter((e) => e.text === "and the tests");
    expect(mine).toHaveLength(1);
  });

  it("reads only what's new, and goes idle when the card stops running", () => {
    watcher.watch([card]);
    write({ type: "user", message: { role: "user", content: "Work on CE-142" } });
    watcher.poll();
    write(assistant([{ type: "text", text: "Half" }], "end_turn"));
    watcher.poll();
    watcher.poll();
    expect(store.turnCount("card-proj-1-abc-1-chat")).toBe(1);
    expect(store.turns("card-proj-1-abc-1-chat", null, 50)[0]?.events).toHaveLength(2);
    watcher.watch([]);
    expect(store.chat("card-proj-1-abc-1-chat")?.state).toBe("idle");
  });
});

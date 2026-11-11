import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeArgs } from "../../../src/sessions/claude-chat.js";
import { claudeModel, repoFromRemote } from "../../../src/sessions/conductor.js";
import { branchName, slug } from "../../../src/sessions/git.js";
import { SessionsHost, titleFrom } from "../../../src/sessions/host.js";
import { toolSummary } from "../../../src/sessions/recorder.js";
import { SessionStore } from "../../../src/sessions/store.js";
import type { SessionRecord } from "../../../src/sessions/types.js";

const FAKE = join(import.meta.dirname, "../../fixtures/sessions/fake-claude.mjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("session names", () => {
  it("never doubles the branch prefix", () => {
    expect(branchName("donnadieu", "Fix the updater crash")).toBe(
      "donnadieu/fix-the-updater-crash",
    );
    expect(branchName("Donnadieu", "donnadieu fix it")).toBe("donnadieu/fix-it");
    expect(branchName("", "Add tests")).toBe("add-tests");
    expect(slug("!!!")).toBe("session");
  });

  it("titles a session from its first message", () => {
    expect(titleFrom("Add a Sessions screen to the workspace. Start with the list")).toBe(
      "Add a Sessions screen to the workspace. Start…",
    );
  });

  it("reads Conductor's repos and models", () => {
    expect(repoFromRemote("git@github.com:acme/app.git")).toBe("acme/app");
    expect(repoFromRemote("https://github.com/acme/app")).toBe("acme/app");
    expect(claudeModel("opus-1m")).toBe("opus[1m]");
    expect(claudeModel("opus-5-5-1m")).toBe("opus[1m]");
    expect(claudeModel("sonnet")).toBe("sonnet");
  });

  it("starts Claude Code streaming both ways, with questions routed back", () => {
    const a = claudeArgs({
      model: "opus[1m]",
      effort: "high",
      sessionId: "s1",
      resume: false,
      permissionMode: "bypassPermissions",
    });
    expect(a).toEqual(
      expect.arrayContaining([
        "--input-format",
        "stream-json",
        "--permission-prompt-tool",
        "stdio",
        "--effort",
        "high",
        "--session-id",
        "s1",
      ]),
    );
    expect(
      claudeArgs({
        model: "m",
        effort: "low",
        sessionId: "s1",
        resume: true,
        permissionMode: "plan",
      }),
    ).toContain("--resume");
  });

  it("sums a tool call up in one line", () => {
    expect(
      toolSummary("Edit", { file_path: "/r/src/ui/a.swift", old_string: "a\nb", new_string: "c" }),
    ).toBe("Edited src/ui/a.swift  +1 −2");
    expect(toolSummary("Bash", { command: "make lint", description: "Run the linter" })).toBe(
      "Ran Run the linter",
    );
  });
});

describe("a chat (stand-in agent)", () => {
  let dir: string;
  let store: SessionStore;
  let host: SessionsHost;
  let frames: Record<string, unknown>[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-sessions-"));
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
    frames = [];
    host = new SessionsHost(store, { home: dir, command: FAKE, notify: (f) => frames.push(f) });
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

  async function idle(chatId: string) {
    for (let i = 0; i < 100; i++) {
      if (store.chat(chatId)?.state === "idle" || store.chat(chatId)?.state === "failed") return;
      await sleep(50);
    }
    throw new Error("the chat never went idle");
  }

  it("runs a turn, keeps a steer in the same turn, and stores every event", async () => {
    const c = host.newChat("s1", "opus[1m]", "high", "Chat");
    await host.chats.send(c.id, "hello", "steer");
    for (
      let i = 0;
      i < 100 && !frames.some((f) => (f.event as { kind?: string })?.kind === "tool");
      i++
    )
      await sleep(20);
    await host.chats.send(c.id, "change course", "steer");
    await idle(c.id);
    const [t] = store.turns(c.id, null, 10);
    expect(t.status).toBe("done");
    expect(t.events.map((e) => e.kind)).toEqual(["user", "tool", "user", "tool_result", "text"]);
    expect(t.events[2].name).toBe("steered");
    // Claude Code echoes the message back when the agent reads it (--replay-user-messages): delivered.
    expect(t.events[2].data).toEqual({ delivery: "delivered" });
    expect(t.events.at(-1)?.text).toBe("steered: change course");
    const sending = frames.find((f) => (f.event as { name?: string })?.name === "steered")
      ?.event as { data?: unknown };
    expect(sending?.data).toEqual({ delivery: "sending" });
    expect(frames.some((f) => f.type === "event")).toBe(true);
  });

  it("stops a turn at once and clears the queue", async () => {
    const c = host.newChat("s1", "opus[1m]", "high", "Chat");
    await host.chats.send(c.id, "work", "steer");
    await host.chats.send(c.id, "later", "queue");
    expect(store.queued(c.id)).toHaveLength(1);
    host.chats.stop(c.id);
    await idle(c.id);
    expect(store.turns(c.id, null, 10).map((t) => t.status)).toEqual(["stopped"]);
    expect(store.queued(c.id)).toHaveLength(0);
  });

  it("sends a queued message as the next turn", async () => {
    const c = host.newChat("s1", "opus[1m]", "high", "Chat");
    await host.chats.send(c.id, "first", "steer");
    await host.chats.send(c.id, "second", "queue");
    // Waiting its turn, it already shows in the chat, in order.
    const s1 = store.session("s1");
    expect(s1 && host.view(s1).chats[0]?.queue).toEqual(["second"]);
    expect(frames.filter((f) => f.type === "chat").at(-1)?.queue).toEqual(["second"]);
    await sleep(1500);
    await idle(c.id);
    const turns = store.turns(c.id, null, 10);
    expect(turns.map((t) => t.userText)).toEqual(["first", "second"]);
    expect(turns.at(-1)?.events.at(-1)?.text).toBe("answer: second");
  });

  it("goes back to before a turn: the file it wrote is gone and the turn leaves the chat", async () => {
    const c = host.newChat("s1", "opus[1m]", "high", "Chat");
    await host.chats.send(c.id, "one", "steer");
    await idle(c.id);
    const folder = store.session("s1")?.folder ?? "";
    await host.chats.send(c.id, "two", "steer");
    writeFileSync(join(folder, "made-in-turn-two.txt"), "x");
    await idle(c.id);
    const two = store.turns(c.id, null, 10)[1];
    expect(two.files).toBe(1);
    const r = await host.revert(c.id, two.id);
    expect(r).toEqual({ ok: true });
    expect(store.turnCount(c.id)).toBe(1);
    expect(execFileSync("git", ["-C", folder, "status", "--porcelain"]).toString()).toBe("");
  });
});

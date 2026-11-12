import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeArgs } from "../../../src/sessions/claude-chat.js";
import { SessionsHost } from "../../../src/sessions/host.js";
import { SessionStore } from "../../../src/sessions/store.js";
import type { SessionRecord } from "../../../src/sessions/types.js";

// Omar's Andela chats (Nov 12): his Linear server lives in ~/.claude.json under his own checkout's path, and a
// session's folder is a worktree somewhere else, so the chat's agent never had it.

const FAKE = join(import.meta.dirname, "../../fixtures/sessions/fake-claude.mjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const g = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf-8" },
  ).trim();

describe("a chat's agent gets the person's own MCP servers", { timeout: 30_000 }, () => {
  let dir: string;
  let home: string;
  let local: string;
  let store: SessionStore;
  let host: SessionsHost;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-person-mcp-chat-"));
    home = join(dir, "forge", "sessions");
    mkdirSync(home, { recursive: true });
    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    local = join(dir, "local");
    execFileSync("git", ["clone", "-q", origin, local]);
    g(local, "commit", "-q", "--allow-empty", "-m", "start");
    g(local, "push", "-q", "origin", "HEAD:main");
    // The person's own checkout of acme/app, with a Linear server of his in ~/.claude.json.
    const checkout = join(dir, "Repos", "app");
    execFileSync("git", ["init", "-q", checkout]);
    execFileSync("git", ["-C", checkout, "remote", "add", "origin", "git@github.com:acme/app.git"]);
    const claudeHome = join(dir, "person");
    mkdirSync(claudeHome);
    writeFileSync(
      join(claudeHome, ".claude.json"),
      JSON.stringify({
        mcpServers: { memory: { command: "npx", args: ["-y", "m"] } },
        projects: {
          [checkout]: {
            mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
          },
        },
      }),
    );
    store = new SessionStore(join(home, "sessions.sqlite"));
    host = new SessionsHost(store, {
      home,
      command: FAKE,
      notify: () => {},
      account: async () => null,
      claudeHome,
      forgeHome: join(dir, "forge"),
    });
  });

  afterEach(async () => {
    await host.chats.closeAll();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function answer(message: string): Promise<string> {
    const r = await host.create({
      workspaceId: "w1",
      repo: "acme/app",
      local,
      base: "main",
      prefix: "",
      message,
      model: "haiku",
      effort: "low",
    });
    expect(r.problem).toBeUndefined();
    const s = r.session as SessionRecord;
    for (let i = 0; i < 160; i++) {
      const chat = store.chats(s.id)[0];
      const t = chat ? store.turns(chat.id, null, 10)[0] : undefined;
      if (t?.status === "done") return t.events.at(-1)?.text ?? "";
      await sleep(50);
    }
    throw new Error("the first turn never ended");
  }

  it("passes them with --mcp-config, so Claude Code keeps what it finds itself too", async () => {
    expect(await answer("mcp servers")).toBe("mcp linear,memory");
  });

  it("never tells Claude Code to drop the servers it finds itself", () => {
    const a = claudeArgs({
      model: "m",
      effort: "low",
      sessionId: "s1",
      resume: false,
      permissionMode: "default",
      mcpConfig: "/x/mcp.json",
    });
    expect(a.slice(a.indexOf("--mcp-config"), a.indexOf("--mcp-config") + 2)).toEqual([
      "--mcp-config",
      "/x/mcp.json",
    ]);
    expect(a).not.toContain("--strict-mcp-config");
  });
});

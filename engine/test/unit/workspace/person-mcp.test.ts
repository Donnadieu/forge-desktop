import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "../../../src/workspace/manager.js";
import {
  mergeMcpServers,
  personMcpServers,
  shareWithTerminal,
} from "../../../src/workspace/person-mcp.js";

// Omar's Andela case (Nov 12): his Linear server is a project ("local") entry in ~/.claude.json keyed by his own
// checkout's path, while a card runs in Forge's own clone of the same repo and a session in a worktree of Forge's
// clone. The paths never match, so Claude Code never loaded it there.

const LINEAR = { type: "http", url: "https://mcp.linear.app/mcp" };
const MEMORY = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-memory"],
};

function repo(path: string, origin: string): string {
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  execFileSync("git", ["-C", path, "remote", "add", "origin", origin]);
  return path;
}

describe("the person's own MCP servers for a folder Forge runs Claude Code in", () => {
  let dir: string;
  let home: string;
  let checkout: string;
  let card: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-person-mcp-"));
    home = join(dir, "home");
    mkdirSync(home);
    // His checkout uses an SSH host alias; Forge clones over https.
    checkout = repo(
      join(dir, "Repos", "andela"),
      "git@github.com-andela:andela-technology/andela.git",
    );
    card = repo(
      join(dir, "forge", "workspaces", "ATC-1744"),
      "https://github.com/andela-technology/andela.git",
    );
    const other = repo(join(dir, "Repos", "other"), "git@github.com:acme/other.git");
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "never read" },
        mcpServers: { memory: MEMORY },
        projects: {
          [checkout]: {
            mcpServers: { linear: LINEAR, sentry: { type: "http", url: "https://s" } },
            disabledMcpServers: ["sentry"],
          },
          [other]: { mcpServers: { notion: { type: "http", url: "https://n" } } },
          [join(dir, "gone")]: { mcpServers: { ghost: { type: "http", url: "https://g" } } },
        },
      }),
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a card's own clone gets the main checkout's project servers (same GitHub repo, another path) and the user ones", () => {
    const servers = personMcpServers(card, { home });
    expect(Object.keys(servers).sort()).toEqual(["linear", "memory"]);
    expect(servers.linear).toEqual(LINEAR);
  });

  it("matches on the session's repo when it's given, and leaves other repos' servers out", () => {
    const folder = join(dir, "plain");
    mkdirSync(folder);
    expect(
      Object.keys(personMcpServers(folder, { home, repo: "andela-technology/andela" })).sort(),
    ).toEqual(["linear", "memory"]);
    expect(Object.keys(personMcpServers(folder, { home, repo: "acme/other" })).sort()).toEqual([
      "memory",
      "notion",
    ]);
  });

  it("brings the repo's .mcp.json, without the ones the person turned off", () => {
    writeFileSync(
      join(card, ".mcp.json"),
      JSON.stringify({
        mcpServers: { figma: { type: "http", url: "https://f" }, off: { command: "x" } },
      }),
    );
    const cfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
    cfg.projects[checkout].disabledMcpjsonServers = ["off"];
    writeFileSync(join(home, ".claude.json"), JSON.stringify(cfg));
    expect(Object.keys(personMcpServers(card, { home })).sort()).toEqual([
      "figma",
      "linear",
      "memory",
    ]);
  });

  it("is empty, not an error, without a ~/.claude.json", () => {
    expect(personMcpServers(card, { home: join(dir, "nobody") })).toEqual({});
  });

  it("never lets Forge's own Linear tool shadow a server of the person's with the same name", () => {
    const forge = { "forge-linear": { command: "node" }, linear: { command: "forge's" } };
    const merged = mergeMcpServers(forge, { linear: LINEAR });
    expect(merged.linear).toEqual(LINEAR);
    expect(merged["forge-linear"]).toEqual({ command: "node" });
  });

  describe("a card's MCP config (WorkspaceManager.writeMcpConfig)", () => {
    it("holds the person's servers next to Forge's tracker tool, readable only by the person", async () => {
      const manager = new WorkspaceManager({
        root: join(dir, "forge", "workspaces"),
        hooks: {},
        claudeHome: home,
      });
      const path = await manager.writeMcpConfig(card, { "forge-linear": { command: "node" } });
      const servers = JSON.parse(readFileSync(path, "utf-8")).mcpServers;
      expect(Object.keys(servers).sort()).toEqual(["forge-linear", "linear", "memory"]);
      expect(statSync(path).mode & 0o077).toBe(0);
    });

    it("is written for a board with no tracker tool too", async () => {
      const manager = new WorkspaceManager({
        root: join(dir, "forge", "workspaces"),
        hooks: {},
        claudeHome: home,
      });
      const path = await manager.writeMcpConfig(card, {});
      expect(Object.keys(JSON.parse(readFileSync(path, "utf-8")).mcpServers).sort()).toEqual([
        "linear",
        "memory",
      ]);
    });
  });

  describe("the session terminal (claude started by the person in the folder)", () => {
    it("finds them as the folder's .mcp.json, approved, and git never sees either file", () => {
      expect(shareWithTerminal(card, { linear: LINEAR }, join(dir, "forge"))).toBe(true);
      expect(JSON.parse(readFileSync(join(card, ".mcp.json"), "utf-8")).mcpServers.linear).toEqual(
        LINEAR,
      );
      const settings = JSON.parse(
        readFileSync(join(card, ".claude", "settings.local.json"), "utf-8"),
      );
      expect(settings.enabledMcpjsonServers).toEqual(["linear"]);
      expect(execFileSync("git", ["-C", card, "status", "--porcelain"]).toString()).toBe("");
    });

    it("follows the person's config: Forge's own copy is replaced, and never read back as the repo's", () => {
      shareWithTerminal(card, { linear: LINEAR, old: { command: "x" } }, join(dir, "forge"));
      expect(Object.keys(personMcpServers(card, { home })).sort()).toEqual(["linear", "memory"]);
      expect(shareWithTerminal(card, { memory: MEMORY }, join(dir, "forge"))).toBe(true);
      expect(
        Object.keys(JSON.parse(readFileSync(join(card, ".mcp.json"), "utf-8")).mcpServers),
      ).toEqual(["memory"]);
      const settings = JSON.parse(
        readFileSync(join(card, ".claude", "settings.local.json"), "utf-8"),
      );
      expect(settings.enabledMcpjsonServers).toEqual(["memory"]);
    });

    it("keeps the folder's other local settings", () => {
      mkdirSync(join(card, ".claude"));
      writeFileSync(
        join(card, ".claude", "settings.local.json"),
        JSON.stringify({ attribution: { commit: "" } }),
      );
      shareWithTerminal(card, { linear: LINEAR }, join(dir, "forge"));
      const settings = JSON.parse(
        readFileSync(join(card, ".claude", "settings.local.json"), "utf-8"),
      );
      expect(settings.attribution).toEqual({ commit: "" });
    });

    it("never writes into a checkout that isn't Forge's (a worktree of the person's own repo resolves by itself)", () => {
      const worktree = join(dir, "forge", "sessions", "folders", "wt");
      execFileSync("git", [
        "-C",
        checkout,
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
        "s",
      ]);
      execFileSync("git", ["-C", checkout, "worktree", "add", "-q", "-b", "wt", worktree]);
      expect(shareWithTerminal(worktree, { linear: LINEAR }, join(dir, "forge"))).toBe(false);
      expect(existsSync(join(worktree, ".mcp.json"))).toBe(false);
      expect(readFileSync(join(checkout, ".git", "info", "exclude"), "utf-8")).not.toContain(
        ".mcp.json",
      );
    });

    it("never replaces a .mcp.json the repo has", () => {
      writeFileSync(join(card, ".mcp.json"), '{"mcpServers":{}}');
      expect(shareWithTerminal(card, { linear: LINEAR }, join(dir, "forge"))).toBe(false);
      expect(readFileSync(join(card, ".mcp.json"), "utf-8")).toBe('{"mcpServers":{}}');
    });
  });
});

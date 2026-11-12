/**
 * The person's own MCP servers for a folder Forge runs Claude Code in (Omar, Nov 12 2026: an Andela card and its
 * session couldn't reach his Linear server).
 *
 * Claude Code finds a project's servers by the folder's path in `~/.claude.json` (`projects[<path>].mcpServers`,
 * its "local" scope). A git worktree resolves to its main checkout, but a card runs in Forge's own clone and a
 * session in a worktree of Forge's clone, so their paths are never there. Here: the person's user-scope servers (an
 * account with a login folder of its own, CLAUDE_CONFIG_DIR, doesn't read them), the folder's `.mcp.json`, and every
 * project entry whose checkout is the same GitHub repo, without the ones the person turned off. Agents get them with
 * `--mcp-config` and no `--strict-mcp-config`, so Claude Code still adds everything it finds itself (claude.ai
 * connectors included); the session terminal gets them as the folder's own `.mcp.json` ({@link shareWithTerminal}).
 *
 * New in Forge Desktop. Only reads the person's Claude config, never writes it.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { excludeFromGit } from "./copy-assets.js";

export type McpServers = Record<string, unknown>;

/**
 * "git@github.com:acme/app.git", "https://github.com/acme/app" or an SSH host alias
 * ("git@github.com-work:acme/app.git", one per GitHub account) -> "acme/app".
 */
export function repoFromRemote(url: string): string | null {
  const m = /github\.com[\w.-]*[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

interface ProjectEntry {
  mcpServers?: McpServers;
  disabledMcpServers?: string[];
  disabledMcpjsonServers?: string[];
}

/** The line Forge's own `.mcp.json` leaves in the checkout's `info/exclude`: the mark that the file is Forge's. */
const OWN_MCP_JSON = "/.mcp.json";

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function objectOf(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function git(cwd: string, args: string[]): string | null {
  if (!existsSync(cwd)) return null;
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** `owner/name` of a checkout's GitHub `origin`, lower case (GitHub's names aren't case sensitive). */
function repoOf(dir: string): string | null {
  const url = git(dir, ["config", "--get", "remote.origin.url"]);
  return url ? (repoFromRemote(url)?.toLowerCase() ?? null) : null;
}

/** A main checkout (`.git` is a folder), not a worktree: its servers win over a worktree's of the same name. */
function isMainCheckout(dir: string): boolean {
  try {
    return statSync(join(dir, ".git")).isDirectory();
  } catch {
    return false;
  }
}

/** The folder's `.mcp.json` is Forge's own copy for the terminal, not the repo's. */
function isForgesMcpJson(folder: string): boolean {
  if (!existsSync(join(folder, ".mcp.json"))) return false;
  if (git(folder, ["ls-files", "--", ".mcp.json"])) return false;
  const rel = git(folder, ["rev-parse", "--git-path", "info/exclude"]);
  if (!rel) return false;
  try {
    return readFileSync(resolve(folder, rel), "utf-8")
      .split("\n")
      .some((l) => l.trim() === OWN_MCP_JSON);
  } catch {
    return false;
  }
}

/**
 * The person's servers for `folder`: user scope, then the repo's `.mcp.json`, then the project entries of every
 * checkout of the same GitHub repo (main checkouts last, so theirs win), like Claude Code's own order
 * (local > project > user). `repo` is the session's `owner/name`; without it the folder's `origin` says.
 */
export function personMcpServers(
  folder: string,
  o: { home?: string; repo?: string | null } = {},
): McpServers {
  const config = readJson(join(o.home ?? homedir(), ".claude.json"));
  if (!config) return {};
  const repo = (o.repo ?? repoOf(folder))?.toLowerCase() ?? null;
  const entries = Object.entries(objectOf(config.projects)) as Array<[string, ProjectEntry]>;
  const matched = entries
    .filter(([path, p]) => {
      const relevant =
        Object.keys(objectOf(p?.mcpServers)).length > 0 ||
        (p?.disabledMcpServers ?? []).length > 0 ||
        (p?.disabledMcpjsonServers ?? []).length > 0;
      if (!relevant) return false;
      if (path === folder) return true;
      return repo !== null && repoOf(path) === repo;
    })
    .sort(([a], [b]) => Number(isMainCheckout(a)) - Number(isMainCheckout(b)))
    .map(([, p]) => p);

  const out: McpServers = { ...objectOf(config.mcpServers) };
  const offJson = new Set(matched.flatMap((p) => p.disabledMcpjsonServers ?? []));
  if (!isForgesMcpJson(folder)) {
    const own = objectOf(readJson(join(folder, ".mcp.json"))?.mcpServers);
    for (const [name, server] of Object.entries(own)) if (!offJson.has(name)) out[name] = server;
  }
  for (const p of matched) Object.assign(out, objectOf(p.mcpServers));
  for (const name of matched.flatMap((p) => p.disabledMcpServers ?? [])) delete out[name];
  return out;
}

/** Forge's own tools (the tracker's) and the person's: a server of the person's is never shadowed by Forge's. */
export function mergeMcpServers(forge: McpServers, person: McpServers): McpServers {
  return { ...forge, ...person };
}

/** `{mcpServers}` as a file only the person can read (a server's env or headers may hold a key). */
export function writeMcpFile(path: string, servers: McpServers): string {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function inside(dir: string, root: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(dir));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The person's servers for `claude` started by hand in the folder (the session terminal): written as the folder's
 * `.mcp.json` and approved in its `.claude/settings.local.json`, both kept out of git. Only in a checkout that is
 * Forge's own (folder and git store under `forgeHome`): a worktree of the person's checkout finds its servers by
 * itself, and a repo's own `.mcp.json` is never replaced. True when written.
 */
export function shareWithTerminal(
  folder: string,
  servers: McpServers,
  forgeHome?: string,
): boolean {
  if (
    !forgeHome ||
    !existsSync(forgeHome) ||
    !existsSync(folder) ||
    Object.keys(servers).length === 0
  ) {
    return false;
  }
  const common = git(folder, ["rev-parse", "--git-common-dir"]);
  if (!common || !inside(folder, forgeHome) || !inside(resolve(folder, common), forgeHome))
    return false;
  const file = join(folder, ".mcp.json");
  if (existsSync(file) && !isForgesMcpJson(folder)) return false;
  excludeFromGit(folder, [OWN_MCP_JSON, "/.claude/settings.local.json"]);
  writeMcpFile(file, servers);
  const settingsFile = join(folder, ".claude", "settings.local.json");
  const settings = readJson(settingsFile) ?? {};
  settings.enabledMcpjsonServers = Object.keys(servers);
  mkdirSync(join(folder, ".claude"), { recursive: true });
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

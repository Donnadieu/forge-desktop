/**
 * Import from Conductor: reads Conductor's database read-only (opened immutable, never written) and brings each
 * open workspace over as a session that keeps its folder where it is, with its visible chats and their history.
 * Conductor stored every agent line exactly as Claude Code printed it, so the history goes through the same
 * recorder a live chat uses. Each chat keeps its Claude Code session id, so the next message resumes it.
 *
 * New in Forge Desktop.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { contextWindow } from "./chats.js";
import { TurnRecorder } from "./recorder.js";
import type { SessionStore } from "./store.js";
import type { ChatRecord, SessionRecord, TurnRecord } from "./types.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

export const CONDUCTOR_DB = join(
  homedir(),
  "Library/Application Support/com.conductor.app/conductor.db",
);

interface Row {
  [k: string]: unknown;
}

/** "git@github.com:acme/app.git" or "https://github.com/acme/app" -> "acme/app". */
export function repoFromRemote(url: string): string | null {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Conductor's model names to Claude Code's. */
export function claudeModel(m: string | null): string {
  const s = (m ?? "").toLowerCase();
  const family = s.includes("sonnet") ? "sonnet" : s.includes("haiku") ? "haiku" : "opus";
  return s.includes("1m") ? `${family}[1m]` : family;
}

function open(path: string) {
  return new DatabaseSync(`file:${path}?mode=ro&immutable=1`, { readOnly: true } as never);
}

export interface ConductorRepo {
  repo: string;
  sessions: number;
  chats: number;
  messages: number;
}

export interface ConductorPreview {
  found: boolean;
  repos: ConductorRepo[];
  sessions: number;
  chats: number;
  messages: number;
  alreadyImported: number;
}

function openWorkspaces(db: InstanceType<typeof DatabaseSync>): Row[] {
  return db
    .prepare(
      `SELECT w.id, w.workspace_path, w.directory_name, w.branch, w.intended_target_branch, w.pr_title,
              w.workspace_name, r.remote_url, r.default_branch, r.name AS repo_name, r.root_path
       FROM workspaces w JOIN repos r ON r.id = w.repository_id WHERE w.state = 'ready'`,
    )
    .all() as Row[];
}

function visibleChats(db: InstanceType<typeof DatabaseSync>, workspaceId: string): Row[] {
  return db
    .prepare(
      "SELECT id, claude_session_id, model, claude_effort_level, title FROM sessions WHERE workspace_id = ? AND is_hidden = 0 AND (agent_type IS NULL OR agent_type = 'claude') ORDER BY created_at",
    )
    .all(workspaceId) as Row[];
}

export function previewImport(store: SessionStore, path = CONDUCTOR_DB): ConductorPreview {
  const empty = { found: false, repos: [], sessions: 0, chats: 0, messages: 0, alreadyImported: 0 };
  if (!existsSync(path)) return empty;
  const db = open(path);
  try {
    const byRepo = new Map<string, ConductorRepo>();
    let already = 0;
    const count = db.prepare("SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?");
    for (const w of openWorkspaces(db)) {
      if (store.session(`conductor-${w.id}`)) {
        already += 1;
        continue;
      }
      const repo = repoFromRemote(String(w.remote_url ?? "")) ?? String(w.repo_name ?? "repo");
      const r = byRepo.get(repo) ?? { repo, sessions: 0, chats: 0, messages: 0 };
      r.sessions += 1;
      for (const c of visibleChats(db, String(w.id))) {
        r.chats += 1;
        r.messages += (count.get(c.id as string) as { n: number }).n;
      }
      byRepo.set(repo, r);
    }
    const repos = [...byRepo.values()].sort((a, b) => b.sessions - a.sessions);
    return {
      found: true,
      repos,
      sessions: repos.reduce((n, r) => n + r.sessions, 0),
      chats: repos.reduce((n, r) => n + r.chats, 0),
      messages: repos.reduce((n, r) => n + r.messages, 0),
      alreadyImported: already,
    };
  } finally {
    db.close();
  }
}

/** Imports every open workspace not imported yet; `targets` maps a repo to the Forge workspace it goes into. */
export function runImport(
  store: SessionStore,
  targets: Record<string, string>,
  fallbackWorkspace: string,
  path = CONDUCTOR_DB,
): { sessions: number; chats: number } {
  if (!existsSync(path)) return { sessions: 0, chats: 0 };
  const db = open(path);
  let sessions = 0;
  let chats = 0;
  try {
    const messages = db.prepare(
      "SELECT role, content, turn_id, created_at, cancelled_at FROM session_messages WHERE session_id = ? ORDER BY created_at, rowid",
    );
    for (const w of openWorkspaces(db)) {
      const id = `conductor-${w.id}`;
      if (store.session(id)) continue;
      const repo = repoFromRemote(String(w.remote_url ?? "")) ?? String(w.repo_name ?? "repo");
      const folder = String(w.workspace_path ?? "");
      const now = new Date().toISOString();
      const s: SessionRecord = {
        id,
        workspaceId: targets[repo] ?? fallbackWorkspace,
        origin: "import",
        repo,
        folder,
        branch: String(w.branch ?? ""),
        base: String(w.intended_target_branch || w.default_branch || "main"),
        title: String(
          w.pr_title || w.workspace_name || w.branch || w.directory_name || "Imported session",
        ),
        titleByHand: false,
        githubLogin: null,
        prNumber: null,
        prState: null,
        prTitle: (w.pr_title as string | null) ?? null,
        unread: false,
        archived: false,
        archiveRef: null,
        createdAt: now,
        updatedAt: now,
      };
      store.putSession(s);
      sessions += 1;
      for (const c of visibleChats(db, String(w.id))) {
        const model = claudeModel(c.model as string | null);
        const chat: ChatRecord = {
          id: `conductor-${c.id}`,
          sessionId: id,
          title: String(c.title || "Chat"),
          provider: "claude",
          model,
          effort: String(c.claude_effort_level || "high"),
          planMode: false,
          askBeforeChanges: false,
          providerSessionId: (c.claude_session_id as string | null) ?? null,
          state: "idle",
          contextTokens: 0,
          contextWindow: contextWindow(model),
          hidden: false,
          createdAt: now,
        };
        store.putChat(chat);
        importHistory(store, chat, messages.all(c.id as string) as Row[]);
        chats += 1;
      }
    }
  } finally {
    db.close();
  }
  return { sessions, chats };
}

function importHistory(store: SessionStore, chat: ChatRecord, rows: Row[]): void {
  let turn: TurnRecord | null = null;
  let seq = 0;
  let tokens = 0;
  const close = (status: TurnRecord["status"]) => {
    if (turn) store.putTurn({ ...turn, status: turn.status === "working" ? status : turn.status });
  };
  const rec = new TurnRecorder(
    store,
    chat.id,
    {
      emit: () => {},
      ask: () => {},
      allow: () => {},
      done: (r) => {
        if (turn) turn = { ...turn, status: r.isError ? "stopped" : "done" };
      },
      usage: (t) => {
        tokens = t;
      },
      sessionId: () => {},
    },
    () => false,
  );
  let lastTurnKey: unknown = null;
  for (const m of rows) {
    if (m.role === "user") {
      const text = String(m.content ?? "");
      if (turn && m.turn_id && m.turn_id === lastTurnKey) {
        rec.add("user", text, { name: "steered" });
        continue;
      }
      close("done");
      seq += 1;
      turn = {
        id: `${chat.id}-${seq}`,
        chatId: chat.id,
        seq,
        userText: text,
        status: m.cancelled_at ? "stopped" : "working",
        checkpointBefore: null,
        checkpointAfter: null,
        added: 0,
        removed: 0,
        files: 0,
        startedAt: String(m.created_at ?? ""),
        endedAt: String(m.created_at ?? ""),
      };
      store.putTurn(turn);
      rec.begin(turn.id);
      rec.add("user", text);
      lastTurnKey = m.turn_id;
      continue;
    }
    if (!turn) continue;
    try {
      rec.line(JSON.parse(String(m.content ?? "")) as Record<string, unknown>);
    } catch {
      // not a JSON line: skip it
    }
  }
  close("done");
  store.putChat({ ...chat, contextTokens: tokens });
}

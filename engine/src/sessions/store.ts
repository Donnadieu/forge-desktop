/**
 * The sessions host's file, `sessions.sqlite` in its folder: sessions, chats, turns, events and the
 * outbox of messages waiting to be sent. Written only by the sessions host. Every event is written
 * before the app is told, and every message before it goes to the agent, so a restart loses nothing.
 *
 * New in Forge Desktop. Uses Node's built-in SQLite, like store/local-store.ts.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type {
  ChatRecord,
  EventRecord,
  SessionRecord,
  TurnRecord,
  TurnWithEvents,
} from "./types.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
type Db = InstanceType<typeof DatabaseSync>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chats_session ON chats(session_id);
CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS turns_chat ON turns(chat_id, seq);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, turn_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_turn ON events(turn_id, seq);
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS outbox_chat ON outbox(chat_id, ord);
`;

export interface OutboxItem {
  id: string;
  chatId: string;
  ord: number;
  text: string;
  state: "queued" | "sent" | "cancelled";
}

export class SessionStore {
  private db: Db;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // Sessions

  putSession(s: SessionRecord): void {
    this.db
      .prepare(
        "INSERT INTO sessions (id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
      )
      .run(s.id, JSON.stringify(s), s.updatedAt);
  }

  session(id: string): SessionRecord | null {
    const row = this.db.prepare("SELECT body FROM sessions WHERE id = ?").get(id) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as SessionRecord) : null;
  }

  sessions(): SessionRecord[] {
    return (
      this.db.prepare("SELECT body FROM sessions ORDER BY updated_at DESC").all() as {
        body: string;
      }[]
    ).map((r) => JSON.parse(r.body) as SessionRecord);
  }

  // Chats

  putChat(c: ChatRecord): void {
    this.db
      .prepare(
        "INSERT INTO chats (id, session_id, body) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      )
      .run(c.id, c.sessionId, JSON.stringify(c));
  }

  chat(id: string): ChatRecord | null {
    const row = this.db.prepare("SELECT body FROM chats WHERE id = ?").get(id) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as ChatRecord) : null;
  }

  chats(sessionId?: string): ChatRecord[] {
    const rows = (
      sessionId
        ? this.db
            .prepare("SELECT body FROM chats WHERE session_id = ? ORDER BY rowid")
            .all(sessionId)
        : this.db.prepare("SELECT body FROM chats ORDER BY rowid").all()
    ) as { body: string }[];
    return rows.map((r) => JSON.parse(r.body) as ChatRecord);
  }

  // Turns and events

  putTurn(t: TurnRecord): void {
    this.db
      .prepare(
        "INSERT INTO turns (id, chat_id, seq, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      )
      .run(t.id, t.chatId, t.seq, JSON.stringify(t));
  }

  turn(id: string): TurnRecord | null {
    const row = this.db.prepare("SELECT body FROM turns WHERE id = ?").get(id) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as TurnRecord) : null;
  }

  lastTurnSeq(chatId: string): number {
    const row = this.db
      .prepare("SELECT MAX(seq) AS m FROM turns WHERE chat_id = ?")
      .get(chatId) as {
      m: number | null;
    };
    return row.m ?? 0;
  }

  turnCount(chatId: string): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM turns WHERE chat_id = ?").get(chatId) as {
        n: number;
      }
    ).n;
  }

  /** Up to `limit` turns before `beforeSeq` (newest last), each with its events. */
  turns(chatId: string, beforeSeq: number | null, limit: number): TurnWithEvents[] {
    const rows = this.db
      .prepare("SELECT body FROM turns WHERE chat_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
      .all(chatId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit) as { body: string }[];
    const events = this.db.prepare("SELECT body FROM events WHERE turn_id = ? ORDER BY seq");
    return rows
      .map((r) => JSON.parse(r.body) as TurnRecord)
      .reverse()
      .map((t) => ({
        ...t,
        events: (events.all(t.id) as { body: string }[]).map(
          (e) => JSON.parse(e.body) as EventRecord,
        ),
      }));
  }

  /** Removes a turn and every later one, with their events (revert). */
  dropTurnsFrom(chatId: string, seq: number): void {
    const ids = (
      this.db.prepare("SELECT id FROM turns WHERE chat_id = ? AND seq >= ?").all(chatId, seq) as {
        id: string;
      }[]
    ).map((r) => r.id);
    const delEvents = this.db.prepare("DELETE FROM events WHERE turn_id = ?");
    for (const id of ids) delEvents.run(id);
    this.db.prepare("DELETE FROM turns WHERE chat_id = ? AND seq >= ?").run(chatId, seq);
  }

  dropEvent(id: string): void {
    this.db.prepare("DELETE FROM events WHERE id = ?").run(id);
  }

  putEvent(e: EventRecord): void {
    this.db
      .prepare(
        "INSERT INTO events (id, chat_id, turn_id, seq, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      )
      .run(e.id, e.chatId, e.turnId, e.seq, JSON.stringify(e));
  }

  event(id: string): EventRecord | null {
    const row = this.db.prepare("SELECT body FROM events WHERE id = ?").get(id) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as EventRecord) : null;
  }

  nextEventSeq(turnId: string): number {
    const row = this.db
      .prepare("SELECT MAX(seq) AS m FROM events WHERE turn_id = ?")
      .get(turnId) as {
      m: number | null;
    };
    return (row.m ?? 0) + 1;
  }

  // Outbox

  enqueue(item: OutboxItem): void {
    this.db
      .prepare("INSERT INTO outbox (id, chat_id, ord, text, state) VALUES (?, ?, ?, ?, ?)")
      .run(item.id, item.chatId, item.ord, item.text, item.state);
  }

  queued(chatId: string): OutboxItem[] {
    return (
      this.db
        .prepare(
          "SELECT id, chat_id AS chatId, ord, text, state FROM outbox WHERE chat_id = ? AND state = 'queued' ORDER BY ord",
        )
        .all(chatId) as unknown as OutboxItem[]
    ).map((r) => ({ ...r }));
  }

  nextOrd(chatId: string): number {
    const row = this.db
      .prepare("SELECT MAX(ord) AS m FROM outbox WHERE chat_id = ?")
      .get(chatId) as {
      m: number | null;
    };
    return (row.m ?? 0) + 1;
  }

  markOutbox(id: string, state: OutboxItem["state"]): void {
    this.db.prepare("UPDATE outbox SET state = ? WHERE id = ?").run(state, id);
  }
}

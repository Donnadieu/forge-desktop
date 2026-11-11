/**
 * Card sessions: the sessions Forge starts by itself from tracker cards, shown like any other session. The app
 * tells the host which cards run (their folder and Claude Code session); the host follows each one's Claude Code
 * transcript (~/.claude/projects/…/<session>.jsonl) as it grows and records it with the same recorder a chat uses.
 * Steering a card goes to the card's own engine, which holds its agent (server/local-api.ts, cards/<id>/message).
 * Claude Code 2.1.32x writes such a message as a queue entry (`queue-operation` enqueue, then a `queued_command`
 * attachment once the agent reads it), never as a `user` line: the steer bubble comes from those.
 *
 * New in Forge Desktop.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { transcriptPath } from "./checkpoints.js";
import { TurnRecorder } from "./recorder.js";
import type { SessionStore } from "./store.js";
import type { ChatRecord, SessionRecord, TurnRecord } from "./types.js";

export interface WatchedCard {
  /** `<project id>:<card id>`: unique across every engine. */
  key: string;
  workspaceId: string;
  identifier: string;
  title: string;
  folder: string;
  sessionId: string;
  branch: string;
  repo: string;
  model: string;
}

interface Follow {
  card: WatchedCard;
  offset: number;
  rest: string;
  rec: TurnRecorder;
  turn: TurnRecord | null;
  /** Steers shown but not read by the agent yet ("sending"), oldest first. */
  pending: { id: string; text: string }[];
}

const MAX_READ = 4 * 1024 * 1024;

export class CardWatcher {
  private follows = new Map<string, Follow>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: SessionStore,
    private readonly notify: (frame: Record<string, unknown>) => void,
    private readonly touched: (sessionId: string) => void,
    private readonly claudeHome?: string,
  ) {}

  static sessionId(key: string): string {
    return `card-${key.replace(/[^\w-]/g, "-")}`;
  }

  /** The cards running now: new ones are followed, gone ones go idle. */
  watch(cards: WatchedCard[]): string[] {
    const keep = new Set(cards.map((c) => c.key));
    for (const [key, f] of this.follows) {
      if (keep.has(key)) continue;
      this.follows.delete(key);
      this.setState(f, "idle");
    }
    for (const c of cards) {
      const f = this.follows.get(c.key);
      if (f && f.card.sessionId === c.sessionId) continue;
      this.follow(c);
    }
    if (this.follows.size > 0 && !this.timer) {
      this.timer = setInterval(() => this.poll(), 1000);
      this.timer.unref();
    }
    if (this.follows.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.poll();
    return cards.map((c) => CardWatcher.sessionId(c.key));
  }

  private follow(c: WatchedCard): void {
    const id = CardWatcher.sessionId(c.key);
    const chatId = `${id}-chat`;
    const now = new Date().toISOString();
    const prev = this.store.session(id);
    const s: SessionRecord = {
      ...(prev ?? {
        id,
        origin: "card" as const,
        titleByHand: false,
        githubLogin: null,
        prNumber: null,
        prState: null,
        prTitle: null,
        unread: false,
        archived: false,
        archiveRef: null,
        createdAt: now,
      }),
      workspaceId: c.workspaceId,
      repo: c.repo,
      folder: c.folder,
      branch: c.branch,
      base: prev?.base ?? "main",
      title: `${c.identifier} ${c.title}`.trim(),
      updatedAt: now,
    };
    this.store.putSession(s);
    // The transcript is read again from its start (a new run of the card, or the host restarted): its history is
    // rebuilt from it, so nothing shows twice.
    this.store.dropTurnsFrom(chatId, 1);
    this.notify({ type: "reverted", chatId, seq: 1 });
    const chat: ChatRecord = {
      id: chatId,
      sessionId: id,
      title: c.identifier,
      provider: "claude",
      model: c.model,
      effort: "high",
      planMode: false,
      askBeforeChanges: false,
      providerSessionId: c.sessionId,
      state: "working",
      contextTokens: this.store.chat(chatId)?.contextTokens ?? 0,
      contextWindow: /\[1m\]|-1m/i.test(c.model) ? 1_000_000 : 200_000,
      hidden: false,
      createdAt: now,
    };
    this.store.putChat(chat);
    const rec = new TurnRecorder(
      this.store,
      chatId,
      {
        emit: (e) => this.notify({ type: "event", event: e }),
        ask: () => {},
        allow: () => {},
        done: () => {},
        usage: (tokens) => {
          const cur = this.store.chat(chatId);
          if (cur && tokens > 0) this.store.putChat({ ...cur, contextTokens: tokens });
        },
        sessionId: () => {},
      },
      () => false,
    );
    this.follows.set(c.key, { card: c, offset: 0, rest: "", rec, turn: null, pending: [] });
    this.touched(id);
  }

  private setState(f: Follow, state: ChatRecord["state"]): void {
    const chatId = `${CardWatcher.sessionId(f.card.key)}-chat`;
    const c = this.store.chat(chatId);
    if (f.turn)
      this.store.putTurn({ ...f.turn, status: "done", endedAt: new Date().toISOString() });
    if (c) this.store.putChat({ ...c, state });
    this.touched(CardWatcher.sessionId(f.card.key));
  }

  poll(): void {
    for (const f of this.follows.values()) this.read(f);
  }

  private read(f: Follow): void {
    const path = transcriptPath(f.card.folder, f.card.sessionId, this.claudeHome);
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size <= f.offset) return;
    const length = Math.min(size - f.offset, MAX_READ);
    const buf = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, length, f.offset);
    } finally {
      closeSync(fd);
    }
    f.offset += length;
    const text = f.rest + buf.toString("utf8");
    const lines = text.split("\n");
    f.rest = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.line(f, JSON.parse(line) as Record<string, unknown>);
      } catch {
        // half a line or not JSON: skip it
      }
    }
  }

  /** A message the person sent mid-turn (`queue-operation`, `queued_command`): their own prompts, not Forge's
   *  task notifications. */
  private steer(f: Follow, raw: Record<string, unknown>): boolean {
    const prompt = (t: unknown): string | null =>
      typeof t === "string" && t.trim() && !t.trimStart().startsWith("<task-notification>")
        ? t
        : null;
    if (raw.type === "queue-operation") {
      const text = prompt(raw.content);
      if (raw.operation === "enqueue" && text && f.turn?.status === "working") {
        // Shown as soon as Claude Code takes it in, before the agent reads it.
        const e = f.rec.add("user", text, { name: "steered", data: { delivery: "sending" } });
        f.pending.push({ id: e.id, text });
      } else if (raw.operation === "remove" && raw.reason === "absorbed_mid_turn" && text) {
        this.delivered(f, text, false);
      }
      return true;
    }
    if (raw.type === "attachment") {
      const a = raw.attachment as Record<string, unknown> | undefined;
      if (a?.type !== "queued_command") return false;
      const text = prompt(a.prompt);
      if (text && (a.commandMode === undefined || a.commandMode === "prompt"))
        this.delivered(f, text, true);
      return true;
    }
    return false;
  }

  /** The agent read the steer: its bubble says delivered. The `queued_command` attachment also shows it when its
   *  queue entry was missed (`add`); the `remove` line that follows it never adds a second one. */
  private delivered(f: Follow, text: string, add: boolean): void {
    const i = f.pending.findIndex((e) => e.text === text);
    if (i >= 0) {
      const [e] = f.pending.splice(i, 1);
      if (e) f.rec.mark(e.id, { delivery: "delivered" });
      return;
    }
    if (add && f.turn?.status === "working")
      f.rec.add("user", text, { name: "steered", data: { delivery: "delivered" } });
  }

  /** A transcript line: a person's or Forge's message starts a turn; the rest goes to the recorder. */
  private line(f: Follow, raw: Record<string, unknown>): void {
    if (raw.isSidechain === true) return; // a helper's own conversation: the lead's line about it is enough
    if (this.steer(f, raw)) return;
    const chatId = `${CardWatcher.sessionId(f.card.key)}-chat`;
    const msg = raw.message as { content?: unknown } | undefined;
    const isPrompt =
      raw.type === "user" &&
      (typeof msg?.content === "string" ||
        (Array.isArray(msg?.content) &&
          !(msg.content as Record<string, unknown>[]).some((b) => b.type === "tool_result")));
    if (isPrompt) {
      const text =
        typeof msg?.content === "string"
          ? msg.content
          : (msg?.content as Record<string, unknown>[])
              .map((b) => (typeof b.text === "string" ? b.text : ""))
              .join("");
      if (f.turn && f.turn.status === "working" && raw.isMeta !== true) {
        // Written while the agent works: the person's steer (or Forge's continuation) inside the same turn.
        f.rec.add("user", text, { name: "steered" });
        return;
      }
      if (f.turn)
        this.store.putTurn({ ...f.turn, status: "done", endedAt: new Date().toISOString() });
      // A steer that came too late for the last turn starts this one: its bubble moves here.
      const late = f.pending.findIndex((e) => e.text === text);
      if (late >= 0) {
        const [e] = f.pending.splice(late, 1);
        if (e) f.rec.drop(e.id);
      }
      const seq = this.store.lastTurnSeq(chatId) + 1;
      f.turn = {
        id: `${chatId}-${f.card.sessionId.slice(0, 8)}-${seq}`,
        chatId,
        seq,
        userText: text,
        status: "working",
        checkpointBefore: null,
        checkpointAfter: null,
        added: 0,
        removed: 0,
        files: 0,
        startedAt: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
        endedAt: null,
      };
      this.store.putTurn(f.turn);
      this.notify({ type: "turn", turn: f.turn });
      f.rec.begin(f.turn.id);
      f.rec.add("user", text);
      return;
    }
    if (!f.turn) return;
    f.rec.line(raw);
    // The transcript has no result line: an assistant message that ends with plain text and no tool call ends the turn.
    if (raw.type === "assistant") {
      const content =
        (raw.message as { content?: Record<string, unknown>[] } | undefined)?.content ?? [];
      const stop = (raw.message as { stop_reason?: string } | undefined)?.stop_reason;
      if (stop === "end_turn" && !content.some((b) => b.type === "tool_use")) {
        f.turn = { ...f.turn, status: "done", endedAt: new Date().toISOString() };
        this.store.putTurn(f.turn);
        this.notify({ type: "turn", turn: f.turn });
      }
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

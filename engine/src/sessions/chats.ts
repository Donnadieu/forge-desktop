/**
 * The chats of every session: one Claude Code process per live chat, turns that start, steer, stop and end,
 * the queue of messages sent while the agent works, questions and plans waiting on the person, and a
 * snapshot of the folder before and after each turn (checkpoints).
 *
 * New in Forge Desktop.
 */
import { randomUUID } from "node:crypto";
import { changesBetween, snapshot } from "./checkpoints.js";
import { ClaudeChat, type PermissionMode } from "./claude-chat.js";
import { TurnRecorder } from "./recorder.js";
import type { SessionStore } from "./store.js";
import type { ChatRecord, EventRecord, SessionRecord, TurnRecord } from "./types.js";

export interface ChatsOptions {
  command: string;
  /** The environment an agent of this session runs with. */
  envFor: (s: SessionRecord) => Promise<NodeJS.ProcessEnv>;
  /** Something changed: tell the app (already stored). */
  notify: (frame: Record<string, unknown>) => void;
  /** The session's status may have changed. */
  touched: (sessionId: string) => void;
}

interface Live {
  proc: ClaudeChat;
  rec: TurnRecorder;
  stopping: boolean;
  closing: boolean;
}

export function contextWindow(model: string): number {
  return /\[1m\]|-1m/i.test(model) ? 1_000_000 : 200_000;
}

function permissionMode(c: ChatRecord): PermissionMode {
  if (c.planMode) return "plan";
  return c.askBeforeChanges ? "default" : "bypassPermissions";
}

export class Chats {
  private live = new Map<string, Live>();
  private pendingText = new Map<string, EventRecord>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: SessionStore,
    private readonly o: ChatsOptions,
  ) {}

  private save(c: ChatRecord): void {
    this.store.putChat(c);
    this.o.notify({ type: "chat", chat: c, queued: this.store.queued(c.id).length });
    this.o.touched(c.sessionId);
  }

  private emitEvent(e: EventRecord, live: boolean): void {
    if (!live) {
      this.pendingText.delete(e.id);
      this.o.notify({ type: "event", event: e });
      return;
    }
    // Text being written reaches the app at most every 50 ms.
    this.pendingText.set(e.id, e);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        for (const p of this.pendingText.values()) this.o.notify({ type: "event", event: p });
        this.pendingText.clear();
      }, 50);
    }
  }

  private async open(c: ChatRecord): Promise<Live> {
    const existing = this.live.get(c.id);
    if (existing) return existing;
    const s = this.store.session(c.sessionId);
    if (!s) throw new Error("no such session");
    const env = await this.o.envFor(s);
    let l!: Live;
    const rec = new TurnRecorder(
      this.store,
      c.id,
      {
        emit: (e, live) => this.emitEvent(e, live),
        ask: () => this.setState(c.id, "needs_you"),
        allow: (id, input) => l.proc.answer(id, true, input),
        done: (r) => void this.finish(c.id, r),
        usage: (tokens) => {
          const cur = this.store.chat(c.id);
          if (cur && tokens > 0) this.save({ ...cur, contextTokens: tokens });
        },
        sessionId: () => {},
      },
      () => this.store.chat(c.id)?.askBeforeChanges === true,
    );
    const proc = new ClaudeChat({
      command: this.o.command,
      cwd: s.folder,
      env,
      model: c.model,
      effort: c.effort,
      sessionId: c.startSessionId ?? c.providerSessionId ?? c.id,
      resume: !c.startSessionId && c.providerSessionId !== null,
      permissionMode: permissionMode(c),
      onLine: (raw) => rec.line(raw),
      onExit: (code, stderr) => this.exited(c.id, code, stderr),
    });
    l = { proc, rec, stopping: false, closing: false };
    this.live.set(c.id, l);
    return l;
  }

  private setState(chatId: string, state: ChatRecord["state"]): void {
    const c = this.store.chat(chatId);
    if (c && c.state !== state) this.save({ ...c, state });
  }

  /** A message from the person: starts a turn, steers the running one, or waits in the queue. */
  async send(chatId: string, text: string, mode: "steer" | "queue"): Promise<void> {
    const c = this.store.chat(chatId);
    if (!c) throw new Error("no such chat");
    const working = c.state === "working" || c.state === "needs_you";
    if (working && mode === "queue") {
      this.store.enqueue({
        id: randomUUID(),
        chatId,
        ord: this.store.nextOrd(chatId),
        text,
        state: "queued",
      });
      this.save(c);
      return;
    }
    if (working) {
      const l = await this.open(c);
      l.rec.add("user", text, { name: "steered" });
      l.proc.send(text);
      return;
    }
    await this.startTurn(c, text);
  }

  private async startTurn(c: ChatRecord, text: string): Promise<void> {
    const s = this.store.session(c.sessionId);
    if (!s) throw new Error("no such session");
    const seq = this.store.lastTurnSeq(c.id) + 1;
    const before = await snapshot(s.folder, `refs/forge/checkpoints/${c.id}/${seq}-before`);
    const turn: TurnRecord = {
      id: randomUUID(),
      chatId: c.id,
      seq,
      userText: text,
      status: "working",
      checkpointBefore: before,
      checkpointAfter: null,
      added: 0,
      removed: 0,
      files: 0,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.store.putTurn(turn);
    this.o.notify({ type: "turn", turn });
    const l = await this.open(c);
    l.stopping = false;
    l.rec.begin(turn.id);
    l.rec.add("user", text);
    const fresh = this.store.chat(c.id) ?? c;
    this.save({
      ...fresh,
      state: "working",
      providerSessionId: fresh.startSessionId ?? fresh.providerSessionId ?? fresh.id,
      startSessionId: null,
    });
    l.proc.send(text);
    l.proc.markStarted();
  }

  private async finish(
    chatId: string,
    r: { isError: boolean; subtype: string; text: string },
  ): Promise<void> {
    const l = this.live.get(chatId);
    const c = this.store.chat(chatId);
    if (!l || !c) return;
    const t = this.store.turn(l.rec.currentTurn);
    if (!t || t.status !== "working") return;
    const s = this.store.session(c.sessionId);
    const status: TurnRecord["status"] = l.stopping ? "stopped" : r.isError ? "failed" : "done";
    if (status === "failed")
      l.rec.add("error", r.text || `The agent stopped (${r.subtype}).`, { isError: true });
    const after = s
      ? await snapshot(s.folder, `refs/forge/checkpoints/${chatId}/${t.seq}-after`)
      : null;
    const stats =
      s && t.checkpointBefore && after
        ? await changesBetween(s.folder, t.checkpointBefore, after)
        : null;
    const done: TurnRecord = {
      ...t,
      status,
      checkpointAfter: after,
      added: stats?.added ?? 0,
      removed: stats?.removed ?? 0,
      files: stats?.files ?? 0,
      endedAt: new Date().toISOString(),
    };
    this.store.putTurn(done);
    this.o.notify({ type: "turn", turn: done });
    if (s) this.store.putSession({ ...s, unread: true, updatedAt: new Date().toISOString() });
    this.save({
      ...(this.store.chat(chatId) ?? c),
      state: status === "failed" ? "failed" : "idle",
    });
    // The next queued message starts the next turn (unless the person pressed Stop).
    const next = l.stopping ? undefined : this.store.queued(chatId)[0];
    l.stopping = false;
    if (next) {
      this.store.markOutbox(next.id, "sent");
      await this.startTurn(this.store.chat(chatId) ?? c, next.text);
    }
  }

  private exited(chatId: string, code: number | null, stderr: string): void {
    const l = this.live.get(chatId);
    this.live.delete(chatId);
    if (!l || l.closing) return;
    const t = this.store.turn(l.rec.currentTurn);
    if (t && t.status === "working") {
      const why = /log ?in|authenticat|OAuth|expired|401/i.test(stderr)
        ? "Claude Code is signed out on this Mac. Sign in to Claude Code, then send again."
        : `The agent stopped unexpectedly${code !== null ? ` (exit ${code})` : ""}. ${stderr.split("\n").slice(-3).join(" ")}`;
      l.rec.add("error", why.trim(), { isError: true });
      const failed: TurnRecord = { ...t, status: "failed", endedAt: new Date().toISOString() };
      this.store.putTurn(failed);
      this.o.notify({ type: "turn", turn: failed });
    }
    this.setState(chatId, "idle");
  }

  /** Stop: ends the running turn at once; the chat stays open and the queue is cleared. */
  stop(chatId: string): void {
    const l = this.live.get(chatId);
    for (const q of this.store.queued(chatId)) this.store.markOutbox(q.id, "cancelled");
    if (!l) {
      this.setState(chatId, "idle");
      return;
    }
    l.stopping = true;
    l.proc.interrupt();
  }

  /** The person answered a question, a plan or a permission request. */
  async answer(
    chatId: string,
    eventId: string,
    a: { allow: boolean; answers?: Record<string, string>; feedback?: string },
  ) {
    const c = this.store.chat(chatId);
    const e = this.store.event(eventId);
    const l = this.live.get(chatId);
    if (!c || !e || !l) return { ok: false, problem: "That question isn't waiting any more." };
    const d = (e.data ?? {}) as {
      requestId?: string;
      input?: Record<string, unknown>;
      answered?: boolean;
    };
    if (!d.requestId || d.answered)
      return { ok: false, problem: "That question was already answered." };
    if (e.kind === "question")
      l.proc.answer(d.requestId, true, { ...d.input, answers: a.answers ?? {} });
    else l.proc.answer(d.requestId, a.allow, d.input ?? {}, a.feedback);
    if (e.kind === "plan" && a.allow) {
      const next = { ...c, planMode: false };
      this.store.putChat(next);
      l.proc.setPermissionMode(permissionMode(next));
    }
    const answered = {
      ...e,
      data: { ...d, answered: true, allow: a.allow, answers: a.answers, feedback: a.feedback },
    };
    this.store.putEvent(answered);
    this.o.notify({ type: "event", event: answered });
    this.setState(chatId, "working");
    return { ok: true };
  }

  async change(
    chatId: string,
    p: Partial<
      Pick<ChatRecord, "model" | "effort" | "planMode" | "askBeforeChanges" | "title" | "hidden">
    >,
  ) {
    const c = this.store.chat(chatId);
    if (!c) return;
    const next = { ...c, ...p, contextWindow: contextWindow(p.model ?? c.model) };
    this.save(next);
    const l = this.live.get(chatId);
    if (!l) return;
    if (p.model && p.model !== c.model) l.proc.setModel(p.model);
    if (p.planMode !== undefined || p.askBeforeChanges !== undefined)
      l.proc.setPermissionMode(permissionMode(next));
    if (p.effort && p.effort !== c.effort && c.state === "idle") {
      l.closing = true;
      l.proc.setEffort(p.effort);
      this.live.delete(chatId);
    }
  }

  /** After a restart: a turn that was running is marked interrupted; queued messages go out. */
  async recover(): Promise<void> {
    for (const c of this.store.chats()) {
      const last = this.store.turns(c.id, null, 1)[0];
      if (last && last.status === "working") {
        const t: TurnRecord = { ...last, status: "interrupted", endedAt: new Date().toISOString() };
        this.store.putTurn(t);
      }
      if (c.state !== "idle") this.store.putChat({ ...c, state: "idle" });
      const next = this.store.queued(c.id)[0];
      if (next) {
        this.store.markOutbox(next.id, "sent");
        await this.startTurn(this.store.chat(c.id) ?? c, next.text);
      }
    }
  }

  async closeAll(): Promise<void> {
    for (const l of this.live.values()) l.closing = true;
    await Promise.all([...this.live.values()].map((l) => l.proc.close()));
    this.live.clear();
  }

  async closeChat(chatId: string): Promise<void> {
    const l = this.live.get(chatId);
    if (!l) return;
    l.closing = true;
    this.live.delete(chatId);
    await l.proc.close();
  }
}

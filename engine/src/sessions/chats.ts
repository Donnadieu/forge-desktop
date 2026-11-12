/**
 * The chats of every session: one Claude Code process per live chat, turns that start, steer, stop and end,
 * the queue of messages sent while the agent works, questions and plans waiting on the person, and a
 * snapshot of the folder before and after each turn (checkpoints).
 *
 * New in Forge Desktop.
 */

import { randomUUID } from "node:crypto";
import { thinkingDisplayArgs } from "../process/thinking-display.js";
import { changesBetween, snapshot } from "./checkpoints.js";
import { ClaudeChat, type PermissionMode } from "./claude-chat.js";
import { TurnRecorder } from "./recorder.js";
import type { SessionStore } from "./store.js";
import type { ChatRecord, EventRecord, SessionRecord, TurnRecord } from "./types.js";

export interface ChatsOptions {
  command: string;
  /** The environment an agent of this session runs with. */
  envFor: (s: SessionRecord) => Promise<NodeJS.ProcessEnv>;
  /** The file with the person's own MCP servers for the session's folder, if they have any. */
  mcpConfigFor?: (s: SessionRecord) => string | undefined;
  /** Something changed: tell the app (already stored). */
  notify: (frame: Record<string, unknown>) => void;
  /** The session's status may have changed. */
  touched: (sessionId: string) => void;
  /** How long a message may wait while the agent is silent and runs no tool before it says Not delivered. */
  deliveryMs?: number;
  /** How long Stop waits for the agent to end its turn before it closes the agent (the next message resumes it). */
  stopGraceMs?: number;
}

/** A message written to the agent mid-turn and not read yet. */
interface Steer {
  id: string;
  text: string;
  at: number;
  failed: boolean;
}

interface Live {
  proc: ClaudeChat;
  rec: TurnRecorder;
  stopping: boolean;
  closing: boolean;
  /** Steers written to the agent and not echoed back yet ("sending", or "failed" when it can't read them), oldest first. */
  steers: Steer[];
  /** Questions, plans and permission requests waiting on the person (event ids), oldest first. */
  asks: string[];
  /** The tool calls running now: the agent reads a message when its step ends, however long the tool takes. */
  tools: Set<string>;
  /** When the agent last wrote anything. */
  activeAt: number;
  deliveryTimer: NodeJS.Timeout | null;
  stopTimer: NodeJS.Timeout | null;
}

const INTERACTIVE = new Set(["AskUserQuestion", "ExitPlanMode"]);

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
  /** Full text of each message that said Not delivered, for Retry (an event keeps only a preview). */
  private unsent = new Map<string, string>();
  private readonly deliveryMs: number;
  private readonly stopGraceMs: number;

  constructor(
    private readonly store: SessionStore,
    private readonly o: ChatsOptions,
  ) {
    this.deliveryMs = o.deliveryMs ?? 10_000;
    this.stopGraceMs = o.stopGraceMs ?? 5_000;
  }

  private save(c: ChatRecord): void {
    this.store.putChat(c);
    const queue = this.store.queued(c.id).map((q) => q.text);
    this.o.notify({ type: "chat", chat: c, queued: queue.length, queue });
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
    const thinkingDisplay = await thinkingDisplayArgs(this.o.command);
    let l!: Live;
    const rec = new TurnRecorder(
      this.store,
      c.id,
      {
        emit: (e, live) => this.emitEvent(e, live),
        ask: (_requestId, e) => {
          l.asks.push(e.id);
          this.setState(c.id, "needs_you");
        },
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
      thinkingDisplay,
      mcpConfig: this.o.mcpConfigFor?.(s),
      onLine: (raw) => {
        l.activeAt = Date.now();
        if (raw.type === "user" && raw.isReplay === true) return this.delivered(l, raw);
        this.step(l, raw);
        rec.line(raw);
      },
      onExit: (code, stderr) => this.exited(c.id, l, code, stderr),
    });
    l = {
      proc,
      rec,
      stopping: false,
      closing: false,
      steers: [],
      asks: [],
      tools: new Set(),
      activeAt: Date.now(),
      deliveryTimer: null,
      stopTimer: null,
    };
    this.live.set(c.id, l);
    return l;
  }

  /** Claude Code echoed a message back: the agent has read it, so its steer bubble says delivered. */
  private delivered(l: Live, raw: Record<string, unknown>): void {
    const content = (raw.message as { content?: unknown } | undefined)?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? (content as Record<string, unknown>[])
              .map((b) => (typeof b.text === "string" ? b.text : ""))
              .join("")
          : "";
    const i = l.steers.findIndex((s) => s.text === text);
    if (i < 0) return;
    const [s] = l.steers.splice(i, 1);
    if (!s) return;
    this.unsent.delete(s.id);
    l.rec.mark(s.id, { delivery: "delivered" });
  }

  /** Which tool calls run now (a tool call can take minutes; the agent reads a message only when it ends). */
  private step(l: Live, raw: Record<string, unknown>): void {
    if (raw.type === "assistant") {
      const content = (raw.message as { content?: unknown } | undefined)?.content;
      for (const b of Array.isArray(content) ? (content as Record<string, unknown>[]) : [])
        if (b.type === "tool_use" && !INTERACTIVE.has(String(b.name))) l.tools.add(String(b.id));
    } else if (raw.type === "user") {
      const content = (raw.message as { content?: unknown } | undefined)?.content;
      for (const b of Array.isArray(content) ? (content as Record<string, unknown>[]) : [])
        if (b.type === "tool_result") l.tools.delete(String(b.tool_use_id));
    } else if (raw.type === "result") {
      l.tools.clear();
    }
  }

  /** A message the agent hasn't read while it's silent and runs no tool can't reach it: it says Not delivered (and
   *  still turns Delivered if the agent reads it later). */
  private checkDelivery(l: Live): void {
    const now = Date.now();
    for (const s of l.steers) {
      if (s.failed || l.tools.size > 0 || now - Math.max(s.at, l.activeAt) < this.deliveryMs)
        continue;
      this.failSteer(l, s);
    }
    if (!l.steers.some((s) => !s.failed)) this.stopDeliveryCheck(l);
  }

  private failSteer(l: Live, s: Steer): void {
    s.failed = true;
    this.unsent.set(s.id, s.text);
    l.rec.mark(s.id, { delivery: "failed" });
  }

  /** Every message still waiting says Not delivered (the agent stopped or closed before reading them). */
  private failSteers(l: Live): void {
    for (const s of l.steers) if (!s.failed) this.failSteer(l, s);
    l.steers = [];
    this.stopDeliveryCheck(l);
  }

  private stopDeliveryCheck(l: Live): void {
    if (l.deliveryTimer) clearInterval(l.deliveryTimer);
    l.deliveryTimer = null;
  }

  /** An agent going away leaves no timer behind. */
  private quiet(l: Live): void {
    this.stopDeliveryCheck(l);
    if (l.stopTimer) clearTimeout(l.stopTimer);
    l.stopTimer = null;
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
      // The agent waits on the person: a message written now is their answer ("Or write your own answer below").
      // Claude Code doesn't read anything else until its question is answered (checked live, 2.1.322).
      const ask = l.asks.map((id) => this.store.event(id)).find((e) => e !== null);
      if (ask) {
        await this.answerWith(chatId, ask, text);
        return;
      }
      const e = l.rec.add("user", text, { name: "steered", data: { delivery: "sending" } });
      l.steers.push({ id: e.id, text, at: Date.now(), failed: false });
      if (!l.deliveryTimer) {
        l.deliveryTimer = setInterval(
          () => this.checkDelivery(l),
          Math.min(1000, this.deliveryMs / 4),
        );
        l.deliveryTimer.unref();
      }
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

  /** A typed message answers what the agent asked: every question gets the text, a plan or a permission request
   *  is sent back with it. */
  private async answerWith(chatId: string, e: EventRecord, text: string) {
    const input = ((e.data ?? {}) as { input?: { questions?: { question?: unknown }[] } }).input;
    if (e.kind !== "question")
      return this.answer(chatId, e.id, { allow: false, feedback: text, typed: text });
    const answers: Record<string, string> = {};
    for (const q of input?.questions ?? [])
      if (typeof q.question === "string") answers[q.question] = text;
    return this.answer(chatId, e.id, { allow: true, answers, typed: text });
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
    if (l.stopTimer) clearTimeout(l.stopTimer);
    l.stopTimer = null;
    l.asks = [];
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
    // Stop means stop: messages the agent hasn't read would run as a turn of their own, so the agent closes (the
    // next message resumes the chat) and they say Not delivered, with Retry.
    if (l.stopping && l.steers.length > 0) {
      this.failSteers(l);
      await this.closeChat(chatId);
      return;
    }
    // The next queued message starts the next turn (unless the person pressed Stop).
    const next = l.stopping ? undefined : this.store.queued(chatId)[0];
    l.stopping = false;
    if (next) {
      this.store.markOutbox(next.id, "sent");
      await this.startTurn(this.store.chat(chatId) ?? c, next.text);
    }
  }

  private exited(chatId: string, l: Live, code: number | null, stderr: string): void {
    // Only this agent's own entry goes: a chat that Retry or a new message already opened again keeps its new one.
    if (this.live.get(chatId) === l) this.live.delete(chatId);
    this.quiet(l);
    if (l.closing) return;
    this.failSteers(l);
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
    if (!l || this.store.turn(l.rec.currentTurn)?.status !== "working") {
      this.setState(chatId, "idle");
      return;
    }
    l.stopping = true;
    // What the agent asked closes with the turn.
    for (const id of l.asks.splice(0)) {
      const e = this.store.event(id);
      if (!e) continue;
      const closed = { ...e, data: { ...(e.data ?? {}), answered: true, stopped: true } };
      this.store.putEvent(closed);
      this.o.notify({ type: "event", event: closed });
    }
    // Claude Code runs a message it hasn't read as a turn of its own right after an interrupt (checked live, 2.1.322):
    // with one waiting, the agent closes at once instead, and the message says Not delivered, with Retry.
    if (l.steers.length > 0) {
      void this.forceStop(chatId, l);
      return;
    }
    l.proc.interrupt();
    // Stop always works: an agent that doesn't end its turn in time is closed, and the turn ends stopped.
    if (l.stopTimer) clearTimeout(l.stopTimer);
    l.stopTimer = setTimeout(() => void this.forceStop(chatId, l), this.stopGraceMs);
    l.stopTimer.unref();
  }

  private async forceStop(chatId: string, l: Live): Promise<void> {
    if (this.live.get(chatId) !== l) return;
    l.stopTimer = null;
    l.closing = true;
    await this.finish(chatId, { isError: false, subtype: "interrupted", text: "" });
    this.failSteers(l);
    if (this.live.get(chatId) === l) this.live.delete(chatId);
    await l.proc.close();
    this.setState(chatId, "idle");
  }

  /** Retry on a message that said Not delivered: its bubble goes and it's sent again, as if just written. */
  async retry(chatId: string, eventId: string): Promise<{ ok: boolean; problem?: string }> {
    const e = this.store.event(eventId);
    const d = (e?.data ?? {}) as { delivery?: string };
    if (!e || e.chatId !== chatId || e.name !== "steered" || d.delivery !== "failed")
      return { ok: false, problem: "That message isn't waiting to be sent again." };
    const text = this.unsent.get(eventId) ?? e.text;
    this.unsent.delete(eventId);
    const l = this.live.get(chatId);
    if (l) l.steers = l.steers.filter((s) => s.id !== eventId);
    this.store.dropEvent(eventId);
    this.o.notify({ type: "event", event: { ...e, kind: "dropped" } });
    await this.send(chatId, text, "steer");
    return { ok: true };
  }

  /** The person answered a question, a plan or a permission request. */
  async answer(
    chatId: string,
    eventId: string,
    a: { allow: boolean; answers?: Record<string, string>; feedback?: string; typed?: string },
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
      data: {
        ...d,
        answered: true,
        allow: a.allow,
        answers: a.answers,
        feedback: a.feedback,
        ...(a.typed ? { typed: a.typed } : {}),
      },
    };
    this.store.putEvent(answered);
    this.o.notify({ type: "event", event: answered });
    l.asks = l.asks.filter((id) => id !== eventId);
    this.setState(chatId, l.asks.length > 0 ? "needs_you" : "working");
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
    for (const l of this.live.values()) {
      l.closing = true;
      this.quiet(l);
    }
    await Promise.all([...this.live.values()].map((l) => l.proc.close()));
    this.live.clear();
  }

  async closeChat(chatId: string): Promise<void> {
    const l = this.live.get(chatId);
    if (!l) return;
    l.closing = true;
    this.quiet(l);
    this.live.delete(chatId);
    await l.proc.close();
  }
}

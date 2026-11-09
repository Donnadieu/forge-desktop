/**
 * Turns Claude Code's JSON lines into the events a chat shows: text as it's written, thinking, folded tool
 * calls with a one-line summary, tool results cut to a preview, and the agent's questions, plans and
 * permission requests. Each event is written to the store before the app hears about it.
 *
 * New in Forge Desktop.
 */
import { randomUUID } from "node:crypto";
import type { SessionStore } from "./store.js";
import { type EventKind, type EventRecord, preview } from "./types.js";

export interface RecorderHooks {
  /** An event was added or changed (already stored). `live` = a text still being written. */
  emit: (e: EventRecord, live: boolean) => void;
  /** Claude Code asked something only the person can answer (a question, a plan, a permission). */
  ask: (requestId: string, e: EventRecord) => void;
  /** A tool needs a yes and the chat doesn't ask: allow it at once. */
  allow: (requestId: string, input: unknown) => void;
  /** The turn ended: `result` line. */
  done: (r: { isError: boolean; subtype: string; text: string; sessionId: string | null }) => void;
  /** Context use from the latest assistant message. */
  usage: (tokens: number) => void;
  sessionId: (id: string) => void;
}

const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function lines(s: string): number {
  return s ? s.split("\n").length : 0;
}

/** One plain line for a tool call ("Edited src/a.ts +12 −3", "Ran make lint"). */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const path = str(input.file_path) || str(input.path) || str(input.notebook_path);
  const short = path.split("/").slice(-3).join("/");
  switch (name) {
    case "Read":
      return `Read ${short}`;
    case "Write":
      return `Wrote ${short}  +${lines(str(input.content))}`;
    case "Edit":
      return `Edited ${short}  +${lines(str(input.new_string))} −${lines(str(input.old_string))}`;
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
      const add = edits.reduce((n, e) => n + lines(str(e.new_string)), 0);
      const del = edits.reduce((n, e) => n + lines(str(e.old_string)), 0);
      return `Edited ${short}  +${add} −${del}`;
    }
    case "Bash":
      return `Ran ${str(input.description) || str(input.command).split("\n")[0].slice(0, 120)}`;
    case "Grep":
      return `Searched ${str(input.pattern).slice(0, 80)}`;
    case "Glob":
      return `Listed ${str(input.pattern).slice(0, 80)}`;
    case "Task":
    case "Agent":
      return `Sent a helper: ${str(input.description) || str(input.prompt).slice(0, 80)}`;
    case "WebFetch":
      return `Read ${str(input.url)}`;
    case "WebSearch":
      return `Searched the web: ${str(input.query)}`;
    case "TodoWrite":
      return "Updated the to-do list";
    default:
      return name.replace(/^mcp__/, "").replace(/__/g, " · ");
  }
}

export class TurnRecorder {
  private turnId = "";
  /** Text events still being written, by message id, in block order. */
  private streaming = new Map<string, string[]>();
  private streamByBlock = new Map<string, string>();
  private messageId = "";

  constructor(
    private readonly store: SessionStore,
    private readonly chatId: string,
    private readonly hooks: RecorderHooks,
    private readonly askBeforeChanges: () => boolean,
  ) {}

  begin(turnId: string): void {
    this.turnId = turnId;
    this.streaming.clear();
    this.streamByBlock.clear();
  }

  get currentTurn(): string {
    return this.turnId;
  }

  add(
    kind: EventKind,
    text: string,
    extra: Partial<Pick<EventRecord, "name" | "data" | "ref" | "isError" | "size" | "id">> = {},
  ): EventRecord {
    const p = preview(text);
    const e: EventRecord = {
      id: extra.id ?? randomUUID(),
      chatId: this.chatId,
      turnId: this.turnId,
      seq: this.store.nextEventSeq(this.turnId),
      kind,
      text: p.text,
      name: extra.name ?? null,
      data: extra.data ?? null,
      size: extra.size ?? p.size,
      ref: extra.ref ?? null,
      isError: extra.isError ?? false,
      at: new Date().toISOString(),
    };
    this.store.putEvent(e);
    this.hooks.emit(e, false);
    return e;
  }

  private update(id: string, text: string, live: boolean): void {
    const e = this.store.event(id);
    if (!e) return;
    const p = preview(text);
    const next = { ...e, text: p.text, size: p.size };
    this.store.putEvent(next);
    this.hooks.emit(next, live);
  }

  line(raw: Record<string, unknown>): void {
    if (!this.turnId) return;
    switch (raw.type) {
      case "system":
        if (raw.subtype === "init" && typeof raw.session_id === "string")
          this.hooks.sessionId(raw.session_id);
        return;
      case "stream_event":
        this.stream(raw.event as Record<string, unknown>);
        return;
      case "assistant":
        this.assistant(raw.message as Record<string, unknown>);
        return;
      case "user":
        this.toolResults(raw.message as Record<string, unknown>);
        return;
      case "control_request":
        this.request(raw);
        return;
      case "result":
        this.hooks.done({
          isError: raw.is_error === true,
          subtype: str(raw.subtype),
          text: str(raw.result),
          sessionId: typeof raw.session_id === "string" ? raw.session_id : null,
        });
        return;
    }
  }

  private stream(ev: Record<string, unknown> | undefined): void {
    if (!ev) return;
    if (ev.type === "message_start") {
      this.messageId = str((ev.message as Record<string, unknown> | undefined)?.id);
      return;
    }
    const key = `${this.messageId}:${ev.index}`;
    if (ev.type === "content_block_start") {
      const block = ev.content_block as Record<string, unknown> | undefined;
      if (block?.type !== "text") return;
      const e = this.add("text", "");
      this.streamByBlock.set(key, e.id);
      const list = this.streaming.get(this.messageId) ?? [];
      list.push(e.id);
      this.streaming.set(this.messageId, list);
      return;
    }
    if (ev.type === "content_block_delta") {
      const delta = ev.delta as Record<string, unknown> | undefined;
      const id = this.streamByBlock.get(key);
      if (!id || delta?.type !== "text_delta") return;
      const e = this.store.event(id);
      if (e) this.update(id, e.text + str(delta.text), true);
    }
  }

  private assistant(message: Record<string, unknown> | undefined): void {
    if (!message) return;
    const id = str(message.id);
    const usage = message.usage as Record<string, number> | undefined;
    if (usage) {
      this.hooks.usage(
        (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.output_tokens ?? 0),
      );
    }
    const content = Array.isArray(message.content)
      ? (message.content as Record<string, unknown>[])
      : [];
    for (const block of content) {
      if (block.type === "text") {
        const open = this.streaming.get(id);
        const streamed = open?.shift();
        if (streamed) this.update(streamed, str(block.text), false);
        else if (str(block.text).trim()) this.add("text", str(block.text));
      } else if (block.type === "thinking") {
        this.add("thinking", str(block.thinking));
      } else if (block.type === "tool_use") {
        const name = str(block.name);
        if (INTERACTIVE_TOOLS.has(name)) continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        this.add("tool", toolSummary(name, input), {
          id: str(block.id) || undefined,
          name,
          data: input,
        });
      }
    }
  }

  private toolResults(message: Record<string, unknown> | undefined): void {
    const content = Array.isArray(message?.content)
      ? (message?.content as Record<string, unknown>[])
      : [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const ref = str(block.tool_use_id);
      if (!this.store.event(ref)) continue; // an answer to a question or plan: the event already shows it
      const body = Array.isArray(block.content)
        ? (block.content as Record<string, unknown>[]).map((c) => str(c.text)).join("\n")
        : str(block.content);
      this.add("tool_result", body, { ref, isError: block.is_error === true });
    }
  }

  private request(raw: Record<string, unknown>): void {
    const req = raw.request as Record<string, unknown> | undefined;
    const requestId = str(raw.request_id);
    if (req?.subtype !== "can_use_tool") return;
    const tool = str(req.tool_name);
    const input = req.input ?? {};
    if (tool === "AskUserQuestion") {
      const e = this.add("question", "", { name: tool, data: { requestId, input } });
      this.hooks.ask(requestId, e);
      return;
    }
    if (tool === "ExitPlanMode") {
      const plan = str((input as Record<string, unknown>).plan);
      const e = this.add("plan", plan, { name: tool, data: { requestId, input } });
      this.hooks.ask(requestId, e);
      return;
    }
    if (!this.askBeforeChanges()) {
      this.hooks.allow(requestId, input);
      return;
    }
    const summary = toolSummary(tool, input as Record<string, unknown>);
    const e = this.add("permission", summary, {
      name: tool,
      data: { requestId, input, reason: str(req.decision_reason) || str(req.description) },
    });
    this.hooks.ask(requestId, e);
  }
}

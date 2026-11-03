import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Logger } from "pino";
import pino from "pino";
import { spawnProcessGroup, terminateChild } from "../process/process-tree.js";
import { nonClaudeAgentEnv, scrubAgentEnv } from "./child-env.js";
import { flushUsage } from "./kimi-usage.js";
import type { AgentAdapter, AgentEvent, SessionHandle, StartSessionParams } from "./types.js";

interface SessionState {
  workspacePath: string;
  model: string;
  abortController: AbortController;
  /** kimi-code's own session id, captured from the `session.resume_hint` stdout line on
   *  the first turn; used with `-r` to resume the session on later turns. */
  kimiSessionId: string | null;
  /** The session directory `<wd_*>/<sessionId>` under `$KIMI_CODE_HOME/sessions`; set once
   *  discoverable. Usage lives in per-agent wire.jsonl files UNDER `agents/*` here. */
  sessionDir: string | null;
  /** Bytes already consumed per agent wire.jsonl path — kimi-code spawns parallel
   *  sub-agents (`agents/agent-N`) each with their own append-only wire.jsonl, and all
   *  of them bill tokens, so every file is offset-tracked independently across turns. */
  wireOffsets: Map<string, number>;
  /** The session's `KIMI_CODE_HOME` under a per-session env (see UsageWireState). */
  kimiCodeHome?: string;
  /** The turn's child process, so abort can kill it. */
  activeChild: ChildProcess | null;
  /** Fail-loud latch: true once we've warned that the kimi-code stdout/on-disk contract
   *  couldn't be resolved for this session (missing resume_hint or unreadable wire.jsonl),
   *  so the diagnostic fires once per session instead of every turn. */
  contractWarned: boolean;
}

/**
 * Kimi Code CLI agent adapter.
 *
 * Spawns the standalone `kimi` binary directly (`kimi -p <prompt> --output-format stream-json`)
 * rather than driving the retired kimi-cli "Wire" protocol through the SDK. Each turn is a fresh
 * `kimi -p` invocation; turns after the first resume the session with `-r <sessionId>` (the id is
 * captured from the `session.resume_hint` stdout line). Credentials come from the provisioned
 * `$KIMI_CODE_HOME/config.toml` (the CLI ignores KIMI_API_KEY in the shell env); forge still
 * requires KIMI_API_KEY at session start because the boot scripts use it to WRITE that config.
 */
export class KimiAdapter implements AgentAdapter {
  readonly name = "kimi";
  readonly persistentSession = true;
  private sessions = new Map<string, SessionState>();
  private model: string | undefined;
  private executable: string;
  private logger: Logger;
  private env: NodeJS.ProcessEnv | undefined;
  private envDenylist: string[] | undefined;

  /**
   * `env` replaces `process.env` as the child's base env (a per-tenant session);
   * its `KIMI_CODE_HOME` must already hold that tenant's config.toml.
   * `envDenylist` names vars scrubbed from it at spawn (see child-env.ts).
   */
  constructor(options?: {
    command?: string;
    model?: string;
    logger?: Logger;
    env?: NodeJS.ProcessEnv;
    envDenylist?: string[];
  }) {
    this.model = options?.model;
    this.executable = options?.command || "kimi";
    // Silent default mirrors runner.ts — usage/resume drift diagnostics stay quiet
    // unless a real logger is threaded in (createAgent forwards the orchestrator's).
    this.logger = options?.logger ?? pino({ level: "silent" });
    this.env = options?.env;
    this.envDenylist = options?.envDenylist;
  }

  async startSession(params: StartSessionParams): Promise<SessionHandle> {
    const sessionId = params.sessionId || randomUUID();

    // Persistent session continuation — reuse existing state (kimi session id + wire offset).
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return { id: sessionId, abortController: existing.abortController };
    }

    // Checked per session, not at construction: a held BYOK Smith (FRG-4532)
    // builds this adapter with no KIMI_API_KEY and must still boot.
    if (!scrubAgentEnv(this.env ?? process.env, this.envDenylist).KIMI_API_KEY) {
      throw new Error("KimiAdapter requires KIMI_API_KEY to be set.");
    }

    const model = this.model ?? process.env.FORGE_WORKER_MODEL;
    if (!model) {
      throw new Error(
        "KimiAdapter requires a model — pass it via options or set FORGE_WORKER_MODEL.",
      );
    }

    const abortController = new AbortController();
    const state: SessionState = {
      workspacePath: params.workspacePath,
      model,
      abortController,
      kimiSessionId: null,
      sessionDir: null,
      wireOffsets: new Map(),
      activeChild: null,
      contractWarned: false,
      kimiCodeHome: this.kimiCodeHome(),
    };
    this.sessions.set(sessionId, state);

    abortController.signal.addEventListener(
      "abort",
      () => {
        const child = state.activeChild;
        if (child) void terminateChild(child);
      },
      { once: true },
    );

    return { id: sessionId, abortController };
  }

  // KimiAdapter is runTurn-only: prompts always flow through runTurn(). streamEvents()
  // exists for the AgentAdapter contract but yields done immediately — runner.ts always
  // takes the runTurn fast-path for adapters that implement it.
  async *streamEvents(handle: SessionHandle): AsyncIterable<AgentEvent> {
    const state = this.sessions.get(handle.id);
    if (!state) {
      yield { type: "error", message: "No session found for handle" };
      return;
    }
    yield { type: "done", success: true };
  }

  async *runTurn(handle: SessionHandle, prompt: string): AsyncIterable<AgentEvent> {
    const state = this.sessions.get(handle.id);
    if (!state) {
      yield { type: "error", message: "No session found for handle" };
      yield { type: "done", success: false };
      return;
    }
    yield* this.consumeTurn(state, prompt);
  }

  /**
   * The child's KIMI_CODE_HOME, pinned so the usage read walks the tree kimi
   * writes. Unset leaves both kimi and the usage read on the process's own.
   */
  private kimiCodeHome(): string | undefined {
    return this.env?.KIMI_CODE_HOME;
  }

  /** Usage appended since the last flush. */
  private *usage(state: SessionState): Generator<AgentEvent> {
    yield* flushUsage(state, this.logger);
  }

  private async *consumeTurn(state: SessionState, prompt: string): AsyncIterable<AgentEvent> {
    const args = ["-p", prompt, "--output-format", "stream-json", "-m", state.model];
    // Turns after the first resume the existing kimi-code session.
    if (state.kimiSessionId) args.unshift("-r", state.kimiSessionId);

    const baseEnv = this.env ?? process.env;
    const child = spawnProcessGroup(
      this.executable,
      args,
      {
        cwd: state.workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...nonClaudeAgentEnv(baseEnv, this.envDenylist),
          KIMI_CODE_NO_AUTO_UPDATE: "1",
          ...(state.kimiCodeHome ? { KIMI_CODE_HOME: state.kimiCodeHome } : {}),
        },
      },
      { workspace: state.workspacePath },
    );
    state.activeChild = child;
    // Abort may have fired between startSession and here.
    if (state.abortController.signal.aborted) void terminateChild(child);

    // Suppress unhandled error events from the child process (e.g. ENOENT).
    child.on("error", () => {});

    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const exitPromise = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.on("error", () => resolve(null));
    });

    let meaningfulEventCount = 0;
    let usageEmitted = 0;

    try {
      if (child.stdout) {
        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
        for await (const line of rl) {
          if (line.trim()) {
            let raw: Record<string, unknown> | null = null;
            try {
              raw = JSON.parse(line) as Record<string, unknown>;
            } catch {
              raw = null; // skip non-JSON lines
            }
            if (raw) {
              for (const e of this.mapLine(raw, state)) {
                meaningfulEventCount++;
                yield e;
              }
            }
          }
          // Stream usage LIVE: kimi-code appends usage.record to wire.jsonl as each LLM call
          // completes (right alongside the assistant/tool stdout line). Flushing after every
          // line surfaces those tokens as the turn runs (offset-tracked, so the final flush
          // below never double-counts) — restoring the ongoing token count instead of a single
          // jump at turn end.
          for (const e of this.usage(state)) {
            usageEmitted++;
            yield e;
          }
        }
      }

      const exitCode = await exitPromise;

      // Fail loud (once per session) if a turn produced events but never yielded a
      // `session.resume_hint` — kimi-code's stdout contract may have changed. Without the
      // id, later turns can't resume (cold sessions) AND usage/cost telemetry goes silent.
      // We warn rather than emit an `error` event because the turn itself succeeded and an
      // `error` would flip turnSuccess to false in the runner.
      if (meaningfulEventCount > 0 && !state.kimiSessionId && !state.contractWarned) {
        state.contractWarned = true;
        this.logger.warn(
          "kimi-code produced no `session.resume_hint` stdout line — the session cannot resume " +
            "and usage/cost telemetry is unavailable. The kimi-code stdout contract may have " +
            "changed; verify the `-m` model and the pinned kimi-code version.",
        );
      }

      // Final flush: catch any usage.record appended after the last stdout line (e.g. the
      // closing assistant message's usage) that the per-line flush above didn't see.
      for (const e of this.usage(state)) {
        usageEmitted++;
        yield e;
      }

      // Aborted mid-turn: swallow the noisy failure and yield only done(false).
      if (state.abortController.signal.aborted) {
        yield { type: "done", success: false };
        return;
      }

      // Only diagnose "no events" when the turn produced NEITHER stdout events NOR
      // usage — a usage-only turn clearly reached the model, and an `error` here
      // would wrongly flip turnSuccess to false in the runner.
      if (meaningfulEventCount === 0 && usageEmitted === 0) {
        const stderr = Buffer.concat(stderrChunks).toString().trim();
        yield {
          type: "error",
          message: stderr
            ? `Kimi turn produced no events. stderr: ${stderr.slice(0, 2000)}`
            : "Kimi turn produced no events — likely auth or config error",
        };
      }

      yield { type: "done", success: exitCode === 0 };
    } finally {
      // Sweep the turn's process group: background processes the turn left
      // running must not outlive it (FRG-4527). A no-op wait when none remain.
      await terminateChild(child);
      state.activeChild = null;
    }
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    handle.abortController.abort();
    const state = this.sessions.get(handle.id);
    if (state) {
      if (state.activeChild) await terminateChild(state.activeChild);
      this.sessions.delete(handle.id);
    }
  }

  /** Map one stream-json stdout line to zero or more AgentEvents. */
  private mapLine(raw: Record<string, unknown>, state: SessionState): AgentEvent[] {
    const role = raw.role as string | undefined;

    if (role === "assistant") {
      const events: AgentEvent[] = [];
      if (typeof raw.content === "string" && raw.content) {
        events.push({ type: "text", content: raw.content });
      } else if (raw.content != null && typeof raw.content !== "string" && !state.contractWarned) {
        // kimi-code delivers assistant text as a plain string today; a non-string
        // shape would be silently dropped, so surface it once as drift rather than
        // losing model output invisibly.
        state.contractWarned = true;
        this.logger.warn(
          { contentType: typeof raw.content },
          "kimi-code assistant `content` is not a string — text may be dropped; the " +
            "stdout content shape may have changed.",
        );
      }
      const toolCalls = raw.tool_calls as
        | Array<{ function?: { name?: string; arguments?: unknown } }>
        | undefined;
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          const fn = call.function;
          if (!fn) continue;
          let input: unknown = fn.arguments ?? null;
          // The CLI delivers `arguments` as a JSON string — parse for downstream consumers,
          // leaving a non-JSON string as-is.
          if (typeof input === "string") {
            try {
              input = JSON.parse(input);
            } catch {
              // keep raw string
            }
          }
          events.push({ type: "tool_use", tool: fn.name || "unknown", input });
        }
      }
      return events;
    }

    if (role === "tool") {
      // stdout carries no structured is_error flag — the failure text is embedded in
      // `content` (e.g. "Command failed with exit code: 1."), so pass it through as-is.
      return [{ type: "tool_result", output: raw.content }];
    }

    if (role === "meta") {
      if (raw.type === "session.resume_hint" && typeof raw.session_id === "string") {
        state.kimiSessionId ??= raw.session_id;
      }
      return [];
    }

    return [];
  }
}

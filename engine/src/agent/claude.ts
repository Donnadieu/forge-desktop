import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { hasExited, spawnProcessGroup, terminateChild } from "../process/process-tree.js";
import { scrubAgentEnv } from "./child-env.js";
import { claudeChildEnv, claudeModelArg } from "./claude-env.js";
import type { UsageAccountingState } from "./claude-usage.js";
import { accountUsage, newUsageState, resetTurnUsage } from "./claude-usage.js";
import type { AgentAdapter, AgentEvent, SessionHandle, StartSessionParams } from "./types.js";

interface SessionState {
  process: ChildProcess;
  abortController: AbortController;
  readline: ReturnType<typeof createInterface> | null;
  resultReceived: boolean;
  meaningfulEventCount: number;
  // Per-turn token accounting for the live-stream-then-reconcile scheme in
  // claude-usage.ts. Reset at each turn start via resetTurnUsage().
  usage: UsageAccountingState;
  stderrBuffers: Buffer[];
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude";
  readonly persistentSession = true;
  private sessions = new Map<string, SessionState>();
  private command: string;
  private model: string | undefined;
  private env: NodeJS.ProcessEnv | undefined;
  private envDenylist: string[] | undefined;

  /**
   * `env` replaces `process.env` as the child's base env (a per-tenant session);
   * `envDenylist` names vars scrubbed from it at spawn (see child-env.ts).
   */
  constructor(options?: {
    command?: string;
    model?: string;
    env?: NodeJS.ProcessEnv;
    envDenylist?: string[];
  }) {
    this.command = options?.command || "claude";
    this.model = options?.model;
    this.env = options?.env;
    this.envDenylist = options?.envDenylist;
  }

  async startSession(params: StartSessionParams): Promise<SessionHandle> {
    const sessionId = params.sessionId || randomUUID();

    // Reuse existing persistent process for continuation turns
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.process.killed && !hasExited(existing.process)) {
      const msg = JSON.stringify({
        type: "user",
        message: { role: "user", content: params.prompt },
      });
      existing.process.stdin?.write(`${msg}\n`);
      existing.meaningfulEventCount = 0;
      existing.resultReceived = false;
      return {
        id: sessionId,
        pid: existing.process.pid ?? undefined,
        abortController: existing.abortController,
      };
    }

    // First turn: spawn persistent process
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ];

    args.push("--session-id", sessionId);

    const model = this.model ?? process.env.FORGE_WORKER_MODEL;
    if (!model) {
      throw new Error(
        "ClaudeCodeAdapter requires a model — pass it via options or set FORGE_WORKER_MODEL.",
      );
    }
    args.push("--model", claudeModelArg(model, this.env ?? process.env));

    if (params.mcpConfigPath && existsSync(params.mcpConfigPath)) {
      args.push("--mcp-config", params.mcpConfigPath);
    }

    if (params.approvalPolicy === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    }

    // Wire reasoning effort and thinking mode from env vars into Claude Code CLI.
    // FORGE_WORKER_REASONING_EFFORT is already validated by worker-handlers.ts
    // (xhigh|high|medium|low|off).  FORGE_WORKER_THINKING is optional;
    // valid values: enabled, adaptive, disabled.
    const effort = process.env.FORGE_WORKER_REASONING_EFFORT;
    if (effort && effort !== "off") {
      args.push("--effort", effort);
    }

    const thinking = process.env.FORGE_WORKER_THINKING;
    if (thinking) {
      args.push("--thinking", thinking);
    }

    const abortController = new AbortController();

    let child: ChildProcess;

    if (params.sshHost) {
      const sshSpawn = this.buildSshSpawn(
        params.sshHost,
        params.workspacePath,
        this.command,
        args,
        params.sshConfigPath,
      );
      child = spawnProcessGroup(sshSpawn.command, sshSpawn.args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      // Auth stripping reads FORGE_* vars, so it runs on the full env; the
      // denylist is applied last (it only ever removes vars).
      const baseEnv = claudeChildEnv(this.env ?? process.env);
      child = spawnProcessGroup(
        this.command,
        args,
        {
          cwd: params.workspacePath,
          stdio: ["pipe", "pipe", "pipe"],
          env: scrubAgentEnv(baseEnv, this.envDenylist),
        },
        { workspace: params.workspacePath },
      );
    }

    // Handle abort by killing the process instead of using signal option
    // (signal option throws unhandled AbortError). Escalates to SIGKILL, so a
    // process that ignores SIGTERM still exits and closes its stdout.
    abortController.signal.addEventListener("abort", () => {
      void terminateChild(child);
    });

    // Suppress unhandled error events from the child process
    child.on("error", () => {});

    // Capture stderr for diagnostics (auth errors, missing config, etc.)
    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    // Write first prompt as stream-json message
    const msg = JSON.stringify({
      type: "user",
      message: { role: "user", content: params.prompt },
    });
    child.stdin?.write(`${msg}\n`);

    this.sessions.set(sessionId, {
      process: child,
      abortController,
      readline: null,
      resultReceived: false,
      meaningfulEventCount: 0,
      usage: newUsageState(),
      stderrBuffers: stderrChunks,
    });

    return { id: sessionId, pid: child.pid ?? undefined, abortController };
  }

  async *streamEvents(handle: SessionHandle): AsyncIterable<AgentEvent> {
    const session = this.sessions.get(handle.id);
    if (!session || !session.process.stdout) {
      yield { type: "error", message: "No child process found for session" };
      return;
    }

    // Create readline once, reuse across turns for persistent sessions
    if (!session.readline) {
      session.readline = createInterface({
        input: session.process.stdout,
        crlfDelay: Infinity,
      });
    }

    session.resultReceived = false;
    session.meaningfulEventCount = 0;
    // Token accounting is per-turn: clear the running total and the dedup
    // snapshot so this turn's per-call usage sums from zero and reconciles
    // against this turn's own `result.usage`.
    resetTurnUsage(session.usage);

    try {
      for await (const line of session.readline) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line);
          // Usage is accounted separately from content mapping: the CLI reports
          // accurate input/cache but a partial `output_tokens` on `assistant`
          // lines, and the authoritative per-turn total only on `result`.
          const usage = accountUsage(session.usage, raw);
          if (usage) {
            session.meaningfulEventCount++;
            yield usage;
          }
          const mapped = this.mapEvent(raw);
          if (mapped) {
            const events = Array.isArray(mapped) ? mapped : [mapped];
            for (const event of events) {
              if (event.type === "done") session.resultReceived = true;
              session.meaningfulEventCount++;
              yield event;
            }
          }
        } catch {
          // Skip non-JSON lines (e.g. startup messages)
        }

        // Stop reading after result — leave readline open for next turn
        if (session.resultReceived) break;
      }
    } catch {
      // Process died or readline errored — yield fallback done
    }

    // Fallback done only if no result event was received AND process is dead
    if (!session.resultReceived) {
      if (session.meaningfulEventCount === 0) {
        const stderr = Buffer.concat(session.stderrBuffers).toString().trim();
        if (stderr) {
          yield {
            type: "error",
            message: `Agent produced no events. stderr: ${stderr.slice(0, 2000)}`,
          };
        }
        yield { type: "done", success: false };
      } else {
        yield { type: "done", success: true };
      }
    }
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    handle.abortController.abort();
    const session = this.sessions.get(handle.id);
    if (session) {
      session.readline?.close();
      session.readline = null;
      // `abort()` above started the termination; wait until the process exits.
      await terminateChild(session.process);
      this.sessions.delete(handle.id);
    }
  }

  /**
   * Build the command and args to spawn an SSH process that runs the agent remotely.
   * Inlined here to avoid cross-module imports (agent has no cross-module deps).
   */
  private buildSshSpawn(
    host: string,
    workspacePath: string,
    command: string,
    args: string[],
    sshConfigPath?: string,
  ): { command: string; args: string[] } {
    const sshArgs = ["-T"];

    if (sshConfigPath) sshArgs.push("-F", sshConfigPath);

    const colonIdx = host.lastIndexOf(":");
    if (colonIdx > 0 && /^\d+$/.test(host.slice(colonIdx + 1))) {
      sshArgs.push("-p", host.slice(colonIdx + 1));
      sshArgs.push(host.slice(0, colonIdx));
    } else {
      sshArgs.push(host);
    }

    const esc = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const escapedArgs = [command, ...args].map(esc).join(" ");
    sshArgs.push(`bash -lc ${esc(`cd ${esc(workspacePath)} && ${escapedArgs}`)}`);

    return { command: "ssh", args: sshArgs };
  }

  private mapEvent(raw: Record<string, unknown>): AgentEvent | AgentEvent[] | null {
    const type = raw.type as string;
    const subtype = raw.subtype as string | undefined;

    if (type === "assistant") {
      // Per-event streaming format: { type: "assistant", subtype: "text", text: "..." }
      if (subtype === "text" && typeof raw.text === "string") {
        return { type: "text", content: raw.text };
      }

      // Per-event streaming format: { type: "assistant", subtype: "tool_use", tool: {...}, input: {...} }
      if (subtype === "tool_use") {
        const tool = raw.tool as Record<string, unknown> | undefined;
        return {
          type: "tool_use",
          tool: (tool?.name as string) || "unknown",
          input: raw.input,
        };
      }

      // Batch format: { type: "assistant", message: { content: [...], usage: {...} } }
      const message = raw.message as Record<string, unknown> | undefined;
      if (message) {
        const events: AgentEvent[] = [];

        const content = message.content as Array<Record<string, unknown>> | undefined;
        if (content) {
          for (const item of content) {
            if (item.type === "text" && item.text) {
              events.push({ type: "text", content: item.text as string });
            }
            if (item.type === "tool_use") {
              events.push({
                type: "tool_use",
                tool: (item.name as string) || "unknown",
                input: item.input,
              });
            }
          }
        }

        // Token usage on assistant/result lines is handled by accountUsage(),
        // not here, so it can stream per-call live and reconcile at turn end.
        return events.length > 0 ? events : null;
      }
    }

    // Tool result events: { type: "tool_result", content: [...] }
    if (type === "tool_result") {
      return {
        type: "tool_result",
        output: raw.content,
      };
    }

    // system.usage is redundant with the per-call assistant usage accountUsage
    // already streams; drop it here so it isn't mapped to a content event.
    if (type === "system" && subtype === "usage") {
      return null;
    }

    if (type === "result") {
      // result.usage is consumed by accountUsage() (the end-of-turn reconcile);
      // mapEvent only turns the line into the terminal done event.
      if (!raw.is_error) return { type: "done", success: true };
      // A failed turn (e.g. `Failed to authenticate. API Error: 401 …`, a
      // usage limit) carries its reason in `result`; surface it so callers can
      // tell why rather than seeing a bare unsuccessful done.
      // `subtype` reads "success" even on a 401, so `terminal_reason` comes first.
      const reason =
        typeof raw.result === "string" && raw.result
          ? raw.result
          : String(raw.terminal_reason ?? raw.subtype ?? "error");
      const status = raw.api_error_status ? ` (API status ${raw.api_error_status})` : "";
      return [
        { type: "error", message: `${reason}${status}`.slice(0, 2000) },
        { type: "done", success: false },
      ];
    }

    if (type === "error") {
      const error = raw.error as { message?: string } | undefined;
      return { type: "error", message: error?.message || "Unknown error" };
    }

    return null;
  }
}

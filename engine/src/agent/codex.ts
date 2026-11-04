/**
 * Codex CLI agent adapter.
 *
 * Client for the Codex app-server protocol.
 * Speaks JSON-RPC 2.0 over stdio to `codex app-server`.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { hasExited, spawnProcessGroup, terminateChild } from "../process/process-tree.js";
import { nonClaudeAgentEnv } from "./child-env.js";
import {
  awaitResponse,
  type CodexRpcMessage,
  FIRST_TURN_START_ID,
  handleMessage,
  INITIALIZE_ID,
  type SessionState,
  sendJsonRpc,
  sendNotification,
  THREAD_START_ID,
  type ThreadStartParams,
  type TurnStartParams,
} from "./codex-protocol.js";
import { type CodexSandboxPolicy, DANGER_FULL_ACCESS } from "./codex-sandbox.js";
import { type DynamicToolSpec, McpBridge } from "./mcp-bridge.js";
import type { AgentAdapter, AgentEvent, SessionHandle, StartSessionParams } from "./types.js";

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";
  readonly persistentSession = true;
  private sessions = new Map<string, SessionState>();
  private command: string;
  private model: string | undefined;
  private env: NodeJS.ProcessEnv | undefined;
  private envDenylist: string[] | undefined;
  private sandboxPolicy: CodexSandboxPolicy;

  /**
   * `env` replaces `process.env` as the child's base env (a per-tenant session);
   * `envDenylist` names vars scrubbed from it at spawn (see child-env.ts).
   * `sandboxPolicy` applies to every turn (default: full access, codex-sandbox.ts).
   */
  constructor(options?: {
    command?: string;
    model?: string;
    env?: NodeJS.ProcessEnv;
    envDenylist?: string[];
    sandboxPolicy?: CodexSandboxPolicy;
  }) {
    this.command = options?.command || "codex";
    this.model = options?.model;
    this.env = options?.env;
    this.envDenylist = options?.envDenylist;
    this.sandboxPolicy = options?.sandboxPolicy ?? DANGER_FULL_ACCESS;
  }

  async startSession(params: StartSessionParams): Promise<SessionHandle> {
    const sessionId = params.sessionId || randomUUID();

    // Reuse existing process for continuation turns (same pattern as claude.ts)
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.process.killed && !hasExited(existing.process) && existing.threadId) {
      const turnId = existing.nextRequestId++;
      sendJsonRpc(
        existing,
        "turn/start",
        this.turnStartParams(existing.threadId, params.prompt, params.workspacePath),
        turnId,
      );
      await awaitResponse(existing, turnId, params.signal);
      existing.resultReceived = false;
      existing.meaningfulEventCount = 0;
      return {
        id: sessionId,
        pid: existing.process.pid ?? undefined,
        abortController: existing.abortController,
      };
    }

    // First turn: spawn process and perform handshake
    const abortController = new AbortController();

    const baseEnv = nonClaudeAgentEnv(this.env ?? process.env, this.envDenylist);

    // Initialize MCP bridge if config exists
    let mcpBridge: McpBridge | null = null;
    let dynamicTools: DynamicToolSpec[] = [];
    if (params.mcpConfigPath && existsSync(params.mcpConfigPath)) {
      mcpBridge = new McpBridge();
      try {
        dynamicTools = await mcpBridge.initialize(params.mcpConfigPath, baseEnv);
      } catch {
        await mcpBridge.close();
        mcpBridge = null;
      }
    }
    if (params.signal?.aborted) {
      await mcpBridge?.close();
      throw new Error("CodexAdapter startSession was aborted before spawn");
    }

    // An OpenAI key is passed through when the person chose one; otherwise Codex uses its own
    // sign-in on this Mac (`codex login`, ~/.codex), so no key is required.
    const env = { ...baseEnv };
    const child = spawnProcessGroup(
      this.command,
      ["app-server"],
      {
        cwd: params.workspacePath,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      },
      { workspace: params.workspacePath },
    );

    abortController.signal.addEventListener("abort", () => {
      void terminateChild(child);
    });

    child.on("error", () => {});

    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const session: SessionState = {
      process: child,
      abortController,
      readline: null,
      lineIterator: null,
      resultReceived: false,
      meaningfulEventCount: 0,
      stderrBuffers: stderrChunks,
      threadId: null,
      nextRequestId: FIRST_TURN_START_ID + 1,
      mcpBridge,
      dynamicTools,
      workspacePath: params.workspacePath,
    };

    this.sessions.set(sessionId, session);

    if (child.stdout) {
      session.readline = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });
      session.lineIterator = session.readline[Symbol.asyncIterator]();
    }

    try {
      await this.handshake(session, params);
    } catch (err) {
      // No handle reaches the caller, so nothing else would stop the detached
      // app-server (and its process group): stop it before rethrowing. An abort
      // of `params.signal` rejects the pending handshake read and lands here.
      await this.stopSession({ id: sessionId, abortController });
      throw err;
    }

    return { id: sessionId, pid: child.pid ?? undefined, abortController };
  }

  /** JSON-RPC handshake: initialize, thread/start, turn/start. */
  private async handshake(session: SessionState, params: StartSessionParams): Promise<void> {
    // 1. initialize
    sendJsonRpc(
      session,
      "initialize",
      {
        capabilities: { experimentalApi: true },
        clientInfo: {
          name: "forge-orchestrator",
          title: "Forge Orchestrator",
          version: "0.1.0",
        },
      },
      INITIALIZE_ID,
    );
    await awaitResponse(session, INITIALIZE_ID, params.signal);

    // Send initialized notification (no id)
    sendNotification(session, "initialized", {});

    const model = this.model ?? process.env.FORGE_WORKER_MODEL;
    if (!model) {
      throw new Error(
        "CodexAdapter requires a model — pass it via options or set FORGE_WORKER_MODEL.",
      );
    }
    const threadStartParams: ThreadStartParams = {
      approvalPolicy: "never",
      // Every turn/start overrides this with `sandboxPolicy`.
      sandbox: "workspace-write",
      cwd: params.workspacePath,
      dynamicTools: session.dynamicTools,
      model,
    };

    sendJsonRpc(session, "thread/start", threadStartParams, THREAD_START_ID);
    const threadResult = (await awaitResponse(session, THREAD_START_ID, params.signal)) as {
      thread?: { id?: string };
    };
    session.threadId = threadResult?.thread?.id || `thread-${randomUUID()}`;

    // 3. turn/start (skip if handshakeOnly — caller will use runTurn)
    if (!params.handshakeOnly) {
      sendJsonRpc(
        session,
        "turn/start",
        this.turnStartParams(session.threadId, params.prompt, params.workspacePath),
        FIRST_TURN_START_ID,
      );
      await awaitResponse(session, FIRST_TURN_START_ID, params.signal);
    }
  }

  /** The `turn/start` params shared by the first, continuation and `runTurn` turns. */
  private turnStartParams(threadId: string, prompt: string, cwd: string): TurnStartParams {
    return {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd,
      approvalPolicy: "never",
      sandboxPolicy: this.sandboxPolicy,
    };
  }

  async *streamEvents(handle: SessionHandle): AsyncIterable<AgentEvent> {
    const session = this.sessions.get(handle.id);
    if (!session || !session.process.stdout) {
      yield { type: "error", message: "No child process found for session" };
      return;
    }

    if (!session.readline) {
      session.readline = createInterface({
        input: session.process.stdout,
        crlfDelay: Infinity,
      });
      session.lineIterator = session.readline[Symbol.asyncIterator]();
    }

    if (!session.lineIterator && session.readline) {
      session.lineIterator = session.readline[Symbol.asyncIterator]();
    }

    session.resultReceived = false;
    session.meaningfulEventCount = 0;

    try {
      while (true) {
        if (!session.lineIterator) break;

        const { value: line, done } = await session.lineIterator.next();
        if (done) break;
        if (!line.trim()) continue;

        let msg: CodexRpcMessage;
        try {
          msg = JSON.parse(line) as CodexRpcMessage;
        } catch {
          continue; // Skip non-JSON lines
        }

        const events = await handleMessage(session, msg);
        if (events) {
          for (const event of events) {
            if (event.type === "done") session.resultReceived = true;
            session.meaningfulEventCount++;
            yield event;
          }
        }

        if (session.resultReceived) break;
      }
    } catch {
      // Process died or readline errored
    }

    // Fallback done (same pattern as claude.ts)
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

      if (session.mcpBridge) {
        await session.mcpBridge.close();
        session.mcpBridge = null;
      }

      await terminateChild(session.process);
      this.sessions.delete(handle.id);
    }
  }

  async *runTurn(handle: SessionHandle, prompt: string): AsyncIterable<AgentEvent> {
    const session = this.sessions.get(handle.id);
    if (!session || !session.threadId) {
      yield { type: "error", message: "No active session for runTurn" };
      yield { type: "done", success: false };
      return;
    }

    // Send turn/start with a new request ID
    const turnId = session.nextRequestId++;
    sendJsonRpc(
      session,
      "turn/start",
      this.turnStartParams(session.threadId, prompt, session.workspacePath),
      turnId,
    );
    await awaitResponse(session, turnId);

    session.resultReceived = false;
    session.meaningfulEventCount = 0;

    // Stream events until turn/completed or turn/failed
    try {
      while (true) {
        if (!session.lineIterator) break;

        const { value: line, done } = await session.lineIterator.next();
        if (done) break;
        if (!line.trim()) continue;

        let msg: CodexRpcMessage;
        try {
          msg = JSON.parse(line) as CodexRpcMessage;
        } catch {
          continue;
        }

        const events = await handleMessage(session, msg);
        if (events) {
          for (const event of events) {
            if (event.type === "done") session.resultReceived = true;
            session.meaningfulEventCount++;
            yield event;
          }
        }

        if (session.resultReceived) break;
      }
    } catch {
      // Process died or readline errored
    }

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
}

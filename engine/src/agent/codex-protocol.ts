/**
 * Codex JSON-RPC 2.0 protocol helpers.
 *
 * Extracted from CodexAdapter to keep file sizes under the 400-line limit.
 * All functions are standalone — they operate on SessionState directly.
 */

import type { ChildProcess } from "node:child_process";
import type { createInterface } from "node:readline";
import { settleBefore } from "./abortable-wait.js";
import type { DynamicToolSpec, McpBridge } from "./mcp-bridge.js";
import type { AgentEvent } from "./types.js";

// --- Formal JSON-RPC protocol types (Codex app-server) ---

export interface CodexRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  [key: string]: unknown;
}

export interface InitializeParams {
  capabilities: Record<string, unknown>;
  clientInfo: { name: string; version: string; title?: string };
}

export interface ThreadStartParams {
  approvalPolicy: string;
  sandbox: string;
  cwd: string;
  dynamicTools: DynamicToolSpec[];
  model?: string;
}

/** A `turn/start` sandbox policy; the builders are in codex-sandbox.ts. */
export type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeSlashTmp: boolean;
      excludeTmpdirEnvVar: boolean;
      readOnlyAccess: {
        type: "restricted";
        includePlatformDefaults: boolean;
        readableRoots: string[];
      };
    };

export interface TurnStartParams {
  threadId: string;
  input: Array<{ type: "text"; text: string }>;
  cwd: string;
  approvalPolicy: string;
  sandboxPolicy: CodexSandboxPolicy;
}

export interface TurnCompletedParams {
  usage?: { input_tokens: number; output_tokens: number };
}

export interface TurnFailedParams {
  error?: string;
  message?: string;
}

// Fixed IDs for the handshake sequence
export const INITIALIZE_ID = 1;
export const THREAD_START_ID = 2;
export const FIRST_TURN_START_ID = 3;

export const NON_INTERACTIVE_ANSWER =
  "This is a non-interactive session. Operator input is unavailable.";

export const HANDSHAKE_TIMEOUT_MS = 30_000;

export interface SessionState {
  process: ChildProcess;
  abortController: AbortController;
  readline: ReturnType<typeof createInterface> | null;
  /** Persistent iterator — avoids for-await closing the readline between calls. */
  lineIterator: AsyncIterableIterator<string> | null;
  resultReceived: boolean;
  meaningfulEventCount: number;
  stderrBuffers: Buffer[];
  threadId: string | null;
  nextRequestId: number;
  mcpBridge: McpBridge | null;
  dynamicTools: DynamicToolSpec[];
  workspacePath: string;
}

// --- JSON-RPC send helpers ---

export function sendJsonRpc(
  session: SessionState,
  method: string,
  params: unknown,
  id: number,
): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  session.process.stdin?.write(`${msg}\n`);
}

export function sendNotification(session: SessionState, method: string, params: unknown): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
  session.process.stdin?.write(`${msg}\n`);
}

export function sendResponse(session: SessionState, id: unknown, result: unknown): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  session.process.stdin?.write(`${msg}\n`);
}

/**
 * Read lines from readline until a response with matching ID arrives.
 * Await a response with a timeout. Rejects, aborting
 * the session, once `HANDSHAKE_TIMEOUT_MS` passes (even if the child prints
 * nothing) or `signal` aborts.
 */
export async function awaitResponse(
  session: SessionState,
  requestId: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const lineIterator = session.lineIterator;
  if (!lineIterator) throw new Error("No readline available for awaiting response");

  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  const waiting = `waiting for response id=${requestId}`;

  // Use a persistent async iterator instead of `for await` which calls
  // iterator.return() on break — closing the readline and breaking
  // subsequent awaitResponse calls.
  while (true) {
    let next: IteratorResult<string>;
    try {
      // Also checked inline: lines that are already buffered win the race against the timer.
      if (Date.now() >= deadline) throw new Error(`Timed out ${waiting}`);
      next = await settleBefore(lineIterator.next(), deadline, waiting, signal);
    } catch (err) {
      // A lost `next()` stays pending and would swallow the session's next
      // line, so a timeout or abort ends the session (kills the child) too.
      session.abortController.abort();
      throw err;
    }
    const { value: line, done } = next;
    if (done) break;
    if (!line.trim()) continue;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    if (msg.id === requestId && !msg.method) {
      if (msg.error) {
        const err = msg.error as { message?: string };
        throw new Error(
          `JSON-RPC error for ${requestId}: ${err.message || JSON.stringify(msg.error)}`,
        );
      }
      return msg.result;
    }
  }

  throw new Error(`Readline ended while waiting for response id=${requestId}`);
}

// --- Message handling (incoming messages and turn methods) ---

export async function handleMessage(
  session: SessionState,
  msg: CodexRpcMessage,
): Promise<AgentEvent[] | null> {
  const method = msg.method;
  const params = (msg.params || {}) as Record<string, unknown>;
  const id = msg.id;

  if (!method) return null;

  // Terminal events
  if (method === "turn/completed") {
    const events: AgentEvent[] = [];
    const usage = extractUsage(msg);
    if (usage) events.push(usage);
    // Forge Desktop: a failed turn (a usage limit, a quota) arrives here with `turn.status: "failed"` and its
    // reason in `turn.error` (app-server v2 `TurnCompletedNotification`), not as `turn/failed`.
    const turn = params.turn as
      | { status?: string; error?: { message?: string } | null }
      | undefined;
    if (turn?.status === "failed") {
      events.push({ type: "error", message: turn.error?.message || "Turn failed" });
      events.push({ type: "done", success: false });
      return events;
    }
    events.push({ type: "done", success: true });
    return events;
  }

  if (method === "turn/failed") {
    const errorMsg = (params.error as string) || (params.message as string) || "Turn failed";
    return [
      { type: "error", message: errorMsg },
      { type: "done", success: false },
    ];
  }

  if (method === "turn/cancelled") {
    return [
      { type: "error", message: "Turn cancelled" },
      { type: "done", success: false },
    ];
  }

  // Text streaming. Codex 0.117 (the pinned CLI, FRG-4085) streams the agent's
  // reply as item/agentMessage/delta; the older name is kept for compat.
  if (method === "item/agentMessage/delta" || method === "item/assistantMessage/streamTextDelta") {
    const delta = params.delta as string;
    if (delta) return [{ type: "text", content: delta }];
    return null;
  }

  // Codex 0.117 reports usage once per model call, outside turn/completed.
  if (method === "thread/tokenUsage/updated") {
    const usage = extractTokenUsageUpdate(params);
    return usage ? [usage] : null;
  }

  // Approval requests
  if (method === "item/commandExecution/requestApproval" && id !== undefined) {
    sendResponse(session, id, { decision: "acceptForSession" });
    return null;
  }

  if (method === "item/fileChange/requestApproval" && id !== undefined) {
    sendResponse(session, id, { decision: "acceptForSession" });
    return null;
  }

  // Older approval methods (kept for compat with the original protocol)
  if (method === "execCommandApproval" && id !== undefined) {
    sendResponse(session, id, { decision: "approved_for_session" });
    return null;
  }

  if (method === "applyPatchApproval" && id !== undefined) {
    sendResponse(session, id, { decision: "approved_for_session" });
    return null;
  }

  // Dynamic tool call
  if (method === "item/tool/call" && id !== undefined) {
    return await handleToolCall(session, id, params);
  }

  // User input request
  if (method === "item/tool/requestUserInput" && id !== undefined) {
    handleRequestUserInput(session, id, params);
    return null;
  }

  // Unrecognized method — ignore
  return null;
}

async function handleToolCall(
  session: SessionState,
  id: unknown,
  params: Record<string, unknown>,
): Promise<AgentEvent[]> {
  const toolName = extractToolName(params);
  const args = extractToolArguments(params);

  const events: AgentEvent[] = [{ type: "tool_use", tool: toolName || "unknown", input: args }];

  if (!session.mcpBridge || !toolName) {
    const msg = toolName
      ? `No MCP bridge available to execute tool: ${toolName}`
      : "No tool name provided in call";
    const result = {
      success: false,
      output: msg,
      contentItems: [{ type: "inputText", text: msg }],
    };
    sendResponse(session, id, result);
    events.push({ type: "tool_result", output: result });
    return events;
  }

  const result = await session.mcpBridge.callTool(toolName, args);
  sendResponse(session, id, result);
  events.push({ type: "tool_result", output: result });
  return events;
}

function handleRequestUserInput(
  session: SessionState,
  id: unknown,
  params: Record<string, unknown>,
): void {
  const questions = params.questions as
    | Array<{ id?: string; options?: Array<{ label?: string }> }>
    | undefined;

  if (!questions || !Array.isArray(questions)) {
    sendResponse(session, id, { answers: {} });
    return;
  }

  const answers: Record<string, { answers: string[] }> = {};

  for (const question of questions) {
    const qId = question.id;
    if (!qId) continue;

    const approvalLabel = findApprovalLabel(question.options);
    answers[qId] = { answers: [approvalLabel || NON_INTERACTIVE_ANSWER] };
  }

  sendResponse(session, id, { answers });
}

// --- Utility functions ---

function extractToolName(params: Record<string, unknown>): string | null {
  const name = (params.tool as string) || (params.name as string) || null;
  if (typeof name === "string") {
    const trimmed = name.trim();
    return trimmed || null;
  }
  return null;
}

function extractToolArguments(params: Record<string, unknown>): Record<string, unknown> {
  const args = params.arguments;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

function extractUsage(msg: Record<string, unknown>): AgentEvent | null {
  const usage =
    (msg.usage as Record<string, number>) ||
    ((msg.params as Record<string, unknown>)?.usage as Record<string, number>);

  if (!usage) return null;

  return {
    type: "usage",
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
  };
}

/**
 * `thread/tokenUsage/updated` carries the thread's running `total` and the
 * `last` model call. Usage events are increments, so emit `last`, with cached
 * input split out of the fresh input count.
 */
function extractTokenUsageUpdate(params: Record<string, unknown>): AgentEvent | null {
  const last = (params.tokenUsage as { last?: Record<string, number> } | undefined)?.last;
  if (!last) return null;
  const cached = last.cachedInputTokens || 0;
  return {
    type: "usage",
    inputTokens: Math.max(0, (last.inputTokens || 0) - cached),
    outputTokens: last.outputTokens || 0,
    cacheReadTokens: cached,
  };
}

function findApprovalLabel(options?: Array<{ label?: string }>): string | null {
  if (!options || !Array.isArray(options)) return null;

  const labels = options.map((o) => o.label).filter((l): l is string => typeof l === "string");

  const sessionApproval = labels.find((l) => l === "Approve this Session");
  if (sessionApproval) return sessionApproval;

  const onceApproval = labels.find((l) => l === "Approve Once");
  if (onceApproval) return onceApproval;

  return (
    labels.find((l) => {
      const normalized = l.trim().toLowerCase();
      return normalized.startsWith("approve") || normalized.startsWith("allow");
    }) || null
  );
}

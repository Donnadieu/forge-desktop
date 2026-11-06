import { EventEmitter, Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitResponse,
  type CodexRpcMessage,
  HANDSHAKE_TIMEOUT_MS,
  handleMessage,
  INITIALIZE_ID,
  type SessionState,
  sendJsonRpc,
  sendNotification,
  sendResponse,
  THREAD_START_ID,
} from "../../../src/agent/codex-protocol.js";

function createMockSession(): SessionState & { _writtenChunks: string[] } {
  const writtenChunks: string[] = [];

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writtenChunks.push(chunk.toString());
      callback();
    },
  });

  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout: new Readable({ read() {} }),
    stderr: new Readable({ read() {} }),
    pid: 12345,
    killed: false,
    kill: vi.fn(),
  });

  return {
    process: proc as any,
    abortController: new AbortController(),
    readline: null,
    lineIterator: null,
    resultReceived: false,
    meaningfulEventCount: 0,
    stderrBuffers: [],
    threadId: null,
    nextRequestId: 4,
    mcpBridge: null,
    dynamicTools: [],
    workspacePath: "/tmp/ws",
    _writtenChunks: writtenChunks,
  };
}

function makeLineIterator(lines: string[]): AsyncIterableIterator<string> {
  let index = 0;
  return {
    async next() {
      if (index < lines.length) {
        return { value: lines[index++], done: false };
      }
      return { value: undefined, done: true } as IteratorResult<string>;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

describe("sendJsonRpc", () => {
  it("writes a JSON-RPC request with id to stdin", () => {
    const session = createMockSession();
    sendJsonRpc(session, "initialize", { capabilities: {} }, 1);

    const written = JSON.parse(session._writtenChunks[0].trim());
    expect(written).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: {} },
    });
  });
});

describe("sendNotification", () => {
  it("writes a JSON-RPC notification without id to stdin", () => {
    const session = createMockSession();
    sendNotification(session, "initialized", {});

    const written = JSON.parse(session._writtenChunks[0].trim());
    expect(written).toEqual({
      jsonrpc: "2.0",
      method: "initialized",
      params: {},
    });
    expect(written).not.toHaveProperty("id");
  });
});

describe("sendResponse", () => {
  it("writes a JSON-RPC response with result to stdin", () => {
    const session = createMockSession();
    sendResponse(session, 10, { decision: "acceptForSession" });

    const written = JSON.parse(session._writtenChunks[0].trim());
    expect(written).toEqual({
      jsonrpc: "2.0",
      id: 10,
      result: { decision: "acceptForSession" },
    });
  });
});

/** A live child that never prints: every `next()` stays pending. */
function silentLineIterator(): AsyncIterableIterator<string> {
  return {
    next: () => new Promise<IteratorResult<string>>(() => {}),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

describe("awaitResponse", () => {
  it("returns the result for a matching response id", async () => {
    const session = createMockSession();
    session.lineIterator = makeLineIterator([
      JSON.stringify({ jsonrpc: "2.0", id: INITIALIZE_ID, result: { protocolVersion: "1" } }),
    ]);

    const result = await awaitResponse(session, INITIALIZE_ID);
    expect(result).toEqual({ protocolVersion: "1" });
  });

  it("throws when the response contains an error", async () => {
    const session = createMockSession();
    session.lineIterator = makeLineIterator([
      JSON.stringify({
        jsonrpc: "2.0",
        id: INITIALIZE_ID,
        error: { code: -32600, message: "Invalid request" },
      }),
    ]);

    await expect(awaitResponse(session, INITIALIZE_ID)).rejects.toThrow(/Invalid request/);
  });

  it("ignores messages with non-matching ids", async () => {
    const session = createMockSession();
    session.lineIterator = makeLineIterator([
      JSON.stringify({ jsonrpc: "2.0", id: 999, result: { ignored: true } }),
      JSON.stringify({ jsonrpc: "2.0", id: THREAD_START_ID, result: { thread: { id: "th_1" } } }),
    ]);

    const result = await awaitResponse(session, THREAD_START_ID);
    expect(result).toEqual({ thread: { id: "th_1" } });
  });

  it("ignores requests (messages with method) while waiting for a response", async () => {
    const session = createMockSession();
    session.lineIterator = makeLineIterator([
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "turn/completed", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: INITIALIZE_ID, result: { ok: true } }),
    ]);

    const result = await awaitResponse(session, INITIALIZE_ID);
    expect(result).toEqual({ ok: true });
  });

  it("throws when the iterator ends without a matching response", async () => {
    const session = createMockSession();
    session.lineIterator = makeLineIterator([]);

    await expect(awaitResponse(session, INITIALIZE_ID)).rejects.toThrow(/Readline ended/);
  });

  it("throws when no line iterator is available", async () => {
    const session = createMockSession();
    session.lineIterator = null;

    await expect(awaitResponse(session, INITIALIZE_ID)).rejects.toThrow(/No readline available/);
  });

  it("times out a silent child after HANDSHAKE_TIMEOUT_MS (FRG-5682)", async () => {
    vi.useFakeTimers();
    try {
      const session = createMockSession();
      session.lineIterator = silentLineIterator();
      let settled = false;
      const waiting = awaitResponse(session, INITIALIZE_ID).finally(() => (settled = true));
      const rejected = expect(waiting).rejects.toThrow(
        `Timed out waiting for response id=${INITIALIZE_ID}`,
      );

      await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      // The lost read would swallow a later line, so the session is ended too.
      expect(session.abortController.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out when only non-matching lines arrive past the deadline", async () => {
    const session = createMockSession();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      let reads = 0;
      session.lineIterator = {
        async next() {
          // Each line lands after the deadline has already passed.
          clock.mockReturnValue(now + HANDSHAKE_TIMEOUT_MS * ++reads);
          return { value: JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }), done: false };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      await expect(awaitResponse(session, INITIALIZE_ID)).rejects.toThrow(/Timed out/);
      expect(reads).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects promptly when the signal aborts mid-wait (FRG-5682)", async () => {
    const session = createMockSession();
    session.lineIterator = silentLineIterator();
    const controller = new AbortController();
    const waiting = awaitResponse(session, INITIALIZE_ID, controller.signal);

    controller.abort("cancelled");
    await expect(waiting).rejects.toThrow(`Aborted waiting for response id=${INITIALIZE_ID}`);
    await expect(waiting).rejects.toMatchObject({ cause: "cancelled" });
    expect(session.abortController.signal.aborted).toBe(true);
  });

  it("rejects without reading when the signal is already aborted", async () => {
    const session = createMockSession();
    session.lineIterator = silentLineIterator();
    await expect(awaitResponse(session, INITIALIZE_ID, AbortSignal.abort())).rejects.toThrow(
      /Aborted/,
    );
  });
});

describe("handleMessage", () => {
  let session: SessionState;

  beforeEach(() => {
    session = createMockSession();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for messages without a method", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      id: 1,
      result: {},
    } as CodexRpcMessage);
    expect(result).toBeNull();
  });

  it("maps turn/completed to usage + done events", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { usage: { input_tokens: 10, output_tokens: 5 } },
    } as CodexRpcMessage);

    expect(result).toContainEqual({ type: "usage", inputTokens: 10, outputTokens: 5 });
    expect(result).toContainEqual({ type: "done", success: true });
  });

  it("maps turn/completed without usage to done event only", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {},
    } as CodexRpcMessage);

    expect(result).toEqual([{ type: "done", success: true }]);
  });

  it("maps a failed turn/completed (a usage limit) to error + done(false) (Forge Desktop)", async () => {
    // app-server v2: the turn's status and error ride on turn/completed (codex-rs 0.153 TurnCompletedNotification).
    const message =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:05 PM.";
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "t1",
        turn: {
          id: "u1",
          items: [],
          status: "failed",
          error: { message, codexErrorInfo: "usageLimitExceeded" },
        },
      },
    } as CodexRpcMessage);
    expect(result).toEqual([
      { type: "error", message },
      { type: "done", success: false },
    ]);
  });

  it("maps turn/failed to error + done events", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      method: "turn/failed",
      params: { error: "Something went wrong" },
    } as CodexRpcMessage);

    expect(result).toContainEqual({ type: "error", message: "Something went wrong" });
    expect(result).toContainEqual({ type: "done", success: false });
  });

  it("maps turn/failed with message param to error + done events", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      method: "turn/failed",
      params: { message: "Turn failed message" },
    } as CodexRpcMessage);

    expect(result).toContainEqual({ type: "error", message: "Turn failed message" });
  });

  it("maps turn/cancelled to error + done events", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      method: "turn/cancelled",
      params: {},
    } as CodexRpcMessage);

    expect(result).toContainEqual({ type: "error", message: "Turn cancelled" });
    expect(result).toContainEqual({ type: "done", success: false });
  });

  it("maps item/assistantMessage/streamTextDelta to text event", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      method: "item/assistantMessage/streamTextDelta",
      params: { delta: "Hello world" },
    } as CodexRpcMessage);

    expect(result).toEqual([{ type: "text", content: "Hello world" }]);
  });

  it("ignores empty streamTextDelta", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      method: "item/assistantMessage/streamTextDelta",
      params: { delta: "" },
    } as CodexRpcMessage);

    expect(result).toBeNull();
  });

  it("maps codex 0.117 item/agentMessage/delta to text event", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "t", turnId: "u", itemId: "m", delta: "Hello" },
    } as CodexRpcMessage);

    expect(result).toEqual([{ type: "text", content: "Hello" }]);
  });

  it("maps thread/tokenUsage/updated to the last call's usage increment", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "t",
        turnId: "u",
        tokenUsage: {
          total: { totalTokens: 300, inputTokens: 250, cachedInputTokens: 100, outputTokens: 50 },
          last: { totalTokens: 49, inputTokens: 42, cachedInputTokens: 10, outputTokens: 7 },
        },
      },
    } as CodexRpcMessage);

    expect(result).toEqual([
      { type: "usage", inputTokens: 32, outputTokens: 7, cacheReadTokens: 10 },
    ]);
  });

  it("ignores thread/tokenUsage/updated without a last call", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: { tokenUsage: {} },
    } as CodexRpcMessage);

    expect(result).toBeNull();
  });

  it("auto-approves commandExecution/requestApproval with acceptForSession", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      id: 10,
      method: "item/commandExecution/requestApproval",
      params: { command: "npm test" },
    } as CodexRpcMessage);

    expect(result).toBeNull();
    const written = JSON.parse((session as any)._writtenChunks[0].trim());
    expect(written).toEqual({
      jsonrpc: "2.0",
      id: 10,
      result: { decision: "acceptForSession" },
    });
  });

  it("auto-approves fileChange/requestApproval with acceptForSession", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      id: 11,
      method: "item/fileChange/requestApproval",
      params: { path: "/tmp/ws/file.ts" },
    } as CodexRpcMessage);

    expect(result).toBeNull();
    const written = JSON.parse((session as any)._writtenChunks[0].trim());
    expect(written).toEqual({
      jsonrpc: "2.0",
      id: 11,
      result: { decision: "acceptForSession" },
    });
  });

  it("handles older-protocol execCommandApproval with approved_for_session", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      id: 12,
      method: "execCommandApproval",
      params: {},
    } as CodexRpcMessage);

    expect(result).toBeNull();
    const written = JSON.parse((session as any)._writtenChunks[0].trim());
    expect(written).toEqual({
      jsonrpc: "2.0",
      id: 12,
      result: { decision: "approved_for_session" },
    });
  });

  it("handles older-protocol applyPatchApproval with approved_for_session", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      id: 13,
      method: "applyPatchApproval",
      params: {},
    } as CodexRpcMessage);

    expect(result).toBeNull();
    const written = JSON.parse((session as any)._writtenChunks[0].trim());
    expect(written).toEqual({
      jsonrpc: "2.0",
      id: 13,
      result: { decision: "approved_for_session" },
    });
  });

  it("handles item/tool/call without MCP bridge", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      id: 20,
      method: "item/tool/call",
      params: { tool: "linear_graphql", arguments: { query: "{ viewer { id } }" } },
    } as CodexRpcMessage);

    expect(result).toContainEqual({
      type: "tool_use",
      tool: "linear_graphql",
      input: { query: "{ viewer { id } }" },
    });

    const toolResult = result?.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();

    const written = JSON.parse((session as any)._writtenChunks[0].trim());
    expect(written).toMatchObject({
      jsonrpc: "2.0",
      id: 20,
      result: { success: false },
    });
  });

  it("auto-answers requestUserInput with session approval option", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      id: 30,
      method: "item/tool/requestUserInput",
      params: {
        questions: [
          {
            id: "q1",
            options: [
              { label: "Deny" },
              { label: "Approve Once" },
              { label: "Approve this Session" },
            ],
          },
        ],
      },
    } as CodexRpcMessage);

    expect(result).toBeNull();
    const written = JSON.parse((session as any)._writtenChunks[0].trim());
    expect(written.result.answers.q1.answers[0]).toBe("Approve this Session");
  });

  it("auto-answers requestUserInput with non-interactive fallback", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      id: 31,
      method: "item/tool/requestUserInput",
      params: {
        questions: [{ id: "q1" }],
      },
    } as CodexRpcMessage);

    expect(result).toBeNull();
    const written = JSON.parse((session as any)._writtenChunks[0].trim());
    expect(written.result.answers.q1.answers[0]).toBe(
      "This is a non-interactive session. Operator input is unavailable.",
    );
  });

  it("returns null for unrecognized methods", async () => {
    const result = await handleMessage(session, {
      jsonrpc: "2.0",
      method: "unknown/method",
      params: {},
    } as CodexRpcMessage);

    expect(result).toBeNull();
  });
});

describe("protocol constants", () => {
  it("has expected handshake IDs", () => {
    expect(INITIALIZE_ID).toBe(1);
    expect(THREAD_START_ID).toBe(2);
  });

  it("has a non-zero handshake timeout", () => {
    expect(HANDSHAKE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

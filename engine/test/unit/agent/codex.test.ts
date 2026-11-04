import * as child_process from "node:child_process";
import { EventEmitter, Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../../../src/agent/codex.js";
import { HANDSHAKE_TIMEOUT_MS } from "../../../src/agent/codex-protocol.js";
import type { AgentEvent } from "../../../src/agent/types.js";
import { agentTreeMarkers } from "../../support/agent-tree.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
}));

// --- Helpers ---

/**
 * JSON-RPC response for a given request ID.
 */
function rpcResponse(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

/**
 * JSON-RPC notification (no id).
 */
function rpcNotification(method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

/**
 * JSON-RPC request from server (has id + method).
 */
function rpcRequest(id: number, method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

/**
 * The 3 handshake responses that startSession expects.
 */
function handshakeResponses(): string[] {
  return [
    rpcResponse(1, { protocolVersion: "2025-01-01", serverInfo: { name: "codex" } }),
    rpcResponse(2, { thread: { id: "th_test" } }),
    rpcResponse(3, { turn: { id: "turn_test" } }),
  ];
}

/**
 * Create a mock process whose stdout emits the given lines sequentially.
 * Lines are pushed in microtask batches to simulate async I/O.
 */
function createMockProcess(lines: string[]): any {
  const writtenChunks: string[] = [];

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writtenChunks.push(chunk.toString());
      callback();
    },
  });

  let lineIndex = 0;
  const stdout = new Readable({
    read() {
      while (lineIndex < lines.length) {
        this.push(`${lines[lineIndex]}\n`);
        lineIndex++;
      }
      // Don't push null — process stays alive for multi-turn
    },
  });

  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new Readable({
      read() {
        this.push(null);
      },
    }),
    stdin,
    pid: 54321,
    exitCode: null as number | null,
    killed: false,
    kill: vi.fn(() => {
      (proc as any).killed = true;
      proc.emit("exit", 0);
    }),
    _writtenChunks: writtenChunks,
  });

  return proc;
}

/**
 * Create a mock process that ends stdout after lines are consumed.
 */
function createTerminatingMockProcess(lines: string[]): any {
  const writtenChunks: string[] = [];

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writtenChunks.push(chunk.toString());
      callback();
    },
  });

  const stdout = new Readable({
    read() {
      for (const line of lines) {
        this.push(`${line}\n`);
      }
      this.push(null);
    },
  });

  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new Readable({
      read() {
        this.push(null);
      },
    }),
    stdin,
    pid: 54321,
    exitCode: null as number | null,
    killed: false,
    kill: vi.fn(() => {
      (proc as any).killed = true;
      proc.emit("exit", 0);
    }),
    _writtenChunks: writtenChunks,
  });

  return proc;
}

describe("CodexAdapter", () => {
  let adapter: CodexAdapter;
  const originalWorkerModel = process.env.FORGE_WORKER_MODEL;
  const originalOpenAIKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.FORGE_WORKER_MODEL = "gpt-5.3-codex";
    process.env.OPENAI_API_KEY = "sk-test-openai-key";
    adapter = new CodexAdapter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalWorkerModel === undefined) delete process.env.FORGE_WORKER_MODEL;
    else process.env.FORGE_WORKER_MODEL = originalWorkerModel;
    if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAIKey;
  });

  it("spawns codex app-server with correct args", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcNotification("turn/completed", { usage: { input_tokens: 10, output_tokens: 5 } }),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Fix the bug",
      workspacePath: "/tmp/workspace",
    });

    expect(child_process.spawn).toHaveBeenCalledWith(
      "codex",
      ["app-server"],
      expect.objectContaining({
        cwd: "/tmp/workspace",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  });

  it("stops the app-server when the handshake fails (FRG-4527)", async () => {
    const mockProc = createTerminatingMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc);
    await expect(
      adapter.startSession({ prompt: "Test", workspacePath: "/tmp/ws" }),
    ).rejects.toThrow();
    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("kills the child and rejects when the signal aborts mid-handshake (FRG-5682)", async () => {
    // A live child that never answers `initialize`.
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc);
    const controller = new AbortController();
    const starting = adapter.startSession({
      prompt: "Test",
      workspacePath: "/tmp/ws",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(child_process.spawn).toHaveBeenCalled());

    controller.abort();
    await expect(starting).rejects.toThrow("Aborted waiting for response id=1");
    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects without spawning when the signal is already aborted (FRG-5682)", async () => {
    await expect(
      adapter.startSession({
        prompt: "Test",
        workspacePath: "/tmp/ws",
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("aborted before spawn");
    expect(child_process.spawn).not.toHaveBeenCalled();
  });

  it("times out and kills a silent child during the handshake (FRG-5682)", async () => {
    vi.useFakeTimers();
    try {
      const mockProc = createMockProcess([]);
      vi.mocked(child_process.spawn).mockReturnValue(mockProc);
      const rejected = expect(
        adapter.startSession({ prompt: "Test", workspacePath: "/tmp/ws" }),
      ).rejects.toThrow("Timed out waiting for response id=1");

      await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
      await rejected;
      expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawns on an explicit per-session env and takes its key from it (FRG-2239)", async () => {
    const scoped = new CodexAdapter({
      model: "gpt-5.3-codex",
      env: { PATH: "/usr/bin", CODEX_HOME: "/tmp/gate/.codex", OPENAI_API_KEY: "sk-user" },
    });
    vi.mocked(child_process.spawn).mockReturnValue(
      createMockProcess([...handshakeResponses(), rpcNotification("turn/completed")]) as any,
    );

    await scoped.startSession({ prompt: "Test", workspacePath: "/tmp/ws" });

    // process.env carries the platform key (beforeEach) — none of it reaches the child.
    const spawnEnv = vi.mocked(child_process.spawn).mock.calls[0][2]?.env;
    expect(spawnEnv).toEqual({
      PATH: "/usr/bin",
      CODEX_HOME: "/tmp/gate/.codex",
      OPENAI_API_KEY: "sk-user",
      ...agentTreeMarkers("/tmp/ws"),
    });
  });

  it("scrubs env_denylist matches from the child env (FRG-4081)", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://staging");
    vi.stubEnv("DATABASE_URL_PROD_RO", "postgres://prod-ro");
    try {
      const scrubbed = new CodexAdapter({ envDenylist: ["*DATABASE_URL*"] });
      vi.mocked(child_process.spawn).mockReturnValue(
        createMockProcess([...handshakeResponses(), rpcNotification("turn/completed")]) as any,
      );
      await scrubbed.startSession({ prompt: "Test", workspacePath: "/tmp/ws" });
      const spawnEnv = vi.mocked(child_process.spawn).mock.calls[0][2]?.env as NodeJS.ProcessEnv;
      expect(spawnEnv.DATABASE_URL).toBeUndefined();
      expect(spawnEnv.DATABASE_URL_PROD_RO).toBeUndefined();
      expect(spawnEnv.OPENAI_API_KEY).toBe("sk-test-openai-key");
      expect(spawnEnv.PATH).toBe(process.env.PATH);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("withholds the owner's Claude subscription token from the child env (FRG-3009)", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-owner");
    try {
      vi.mocked(child_process.spawn).mockReturnValue(
        createMockProcess([...handshakeResponses(), rpcNotification("turn/completed")]) as any,
      );
      await new CodexAdapter().startSession({ prompt: "Test", workspacePath: "/tmp/ws" });
      const spawnEnv = vi.mocked(child_process.spawn).mock.calls[0][2]?.env as NodeJS.ProcessEnv;
      expect(spawnEnv).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
      expect(spawnEnv.OPENAI_API_KEY).toBe("sk-test-openai-key");
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-owner");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("starts without OPENAI_API_KEY and never borrows one from process.env (Codex's own sign-in)", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-not-for-this-agent";
    try {
      const mockProc = createMockProcess([
        ...handshakeResponses(),
        rpcNotification("turn/completed"),
      ]);
      vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);
      const scoped = new CodexAdapter({ model: "gpt-5.3-codex", env: { PATH: "/usr/bin" } });
      await scoped.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
      const spawnEnv = vi.mocked(child_process.spawn).mock.calls.at(-1)?.[2]?.env as Record<
        string,
        string
      >;
      expect(spawnEnv.OPENAI_API_KEY).toBeUndefined();
    } finally {
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
    }
  });

  it("passes OPENAI_API_KEY in env", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-key";

    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcNotification("turn/completed"),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Test",
      workspacePath: "/tmp/ws",
    });

    const spawnEnv = vi.mocked(child_process.spawn).mock.calls[0][2]?.env as Record<string, string>;
    expect(spawnEnv.OPENAI_API_KEY).toBe("sk-test-key");

    process.env.OPENAI_API_KEY = originalKey;
  });

  it("performs JSON-RPC handshake and sends correct messages", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcNotification("turn/completed"),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Fix the bug",
      workspacePath: "/tmp/ws",
    });

    const written = mockProc._writtenChunks.map((c: string) => JSON.parse(c.trim()));

    // Message 1: initialize
    expect(written[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        capabilities: { experimentalApi: true },
        clientInfo: { name: "forge-orchestrator" },
      },
    });

    // Message 2: initialized notification (no id)
    expect(written[1]).toMatchObject({
      jsonrpc: "2.0",
      method: "initialized",
      params: {},
    });
    expect(written[1]).not.toHaveProperty("id");

    // Message 3: thread/start
    expect(written[2]).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      method: "thread/start",
      params: {
        approvalPolicy: "never",
        sandbox: "workspace-write",
        cwd: "/tmp/ws",
        dynamicTools: [],
      },
    });

    // Message 4: turn/start
    expect(written[3]).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      method: "turn/start",
      params: {
        threadId: "th_test",
        input: [{ type: "text", text: "Fix the bug" }],
        cwd: "/tmp/ws",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    });
  });

  it("maps streamTextDelta to text events", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcNotification("item/assistantMessage/streamTextDelta", { delta: "Hello world" }),
      rpcNotification("turn/completed"),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Hi",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toContainEqual({ type: "text", content: "Hello world" });
  });

  it("maps turn/completed to done event with usage", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcNotification("turn/completed", { usage: { input_tokens: 100, output_tokens: 50 } }),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Do it",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toContainEqual({
      type: "usage",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(collected).toContainEqual({ type: "done", success: true });
  });

  it("maps turn/failed to error + done events", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcNotification("turn/failed", { error: "Something went wrong" }),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Fail",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toContainEqual({
      type: "error",
      message: "Something went wrong",
    });
    expect(collected).toContainEqual({ type: "done", success: false });
  });

  it("maps turn/cancelled to error + done events", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcNotification("turn/cancelled", {}),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Cancel",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toContainEqual({
      type: "error",
      message: "Turn cancelled",
    });
    expect(collected).toContainEqual({ type: "done", success: false });
  });

  it("auto-approves commandExecution/requestApproval with acceptForSession", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcRequest(10, "item/commandExecution/requestApproval", { command: "npm test" }),
      rpcNotification("turn/completed"),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Test",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    // Verify approval response was sent
    const allWritten = mockProc._writtenChunks.map((c: string) => JSON.parse(c.trim()));
    const approvalResponse = allWritten.find(
      (m: any) => m.id === 10 && m.result?.decision === "acceptForSession",
    );
    expect(approvalResponse).toBeDefined();

    expect(collected).toContainEqual({ type: "done", success: true });
  });

  it("auto-approves fileChange/requestApproval with acceptForSession", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcRequest(11, "item/fileChange/requestApproval", { path: "/tmp/ws/file.ts" }),
      rpcNotification("turn/completed"),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Edit",
      workspacePath: "/tmp/ws",
    });

    for await (const _ of adapter.streamEvents(handle)) {
    }

    const allWritten = mockProc._writtenChunks.map((c: string) => JSON.parse(c.trim()));
    const approvalResponse = allWritten.find(
      (m: any) => m.id === 11 && m.result?.decision === "acceptForSession",
    );
    expect(approvalResponse).toBeDefined();
  });

  it("handles older-protocol execCommandApproval with approved_for_session", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcRequest(12, "execCommandApproval", {}),
      rpcNotification("turn/completed"),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "ApprovalTest",
      workspacePath: "/tmp/ws",
    });

    for await (const _ of adapter.streamEvents(handle)) {
    }

    const allWritten = mockProc._writtenChunks.map((c: string) => JSON.parse(c.trim()));
    const approvalResponse = allWritten.find(
      (m: any) => m.id === 12 && m.result?.decision === "approved_for_session",
    );
    expect(approvalResponse).toBeDefined();
  });

  it("handles item/tool/call and responds with result", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcRequest(20, "item/tool/call", {
        tool: "linear_graphql",
        arguments: { query: "{ viewer { id } }" },
      }),
      rpcNotification("turn/completed"),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Query Linear",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    // Should yield tool_use and tool_result events
    expect(collected).toContainEqual({
      type: "tool_use",
      tool: "linear_graphql",
      input: { query: "{ viewer { id } }" },
    });

    const toolResult = collected.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();

    // Verify response was sent back to Codex
    const allWritten = mockProc._writtenChunks.map((c: string) => JSON.parse(c.trim()));
    const toolResponse = allWritten.find((m: any) => m.id === 20 && m.result);
    expect(toolResponse).toBeDefined();
  });

  it("auto-answers requestUserInput with approval option", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcRequest(30, "item/tool/requestUserInput", {
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
      }),
      rpcNotification("turn/completed"),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Approve",
      workspacePath: "/tmp/ws",
    });

    for await (const _ of adapter.streamEvents(handle)) {
    }

    const allWritten = mockProc._writtenChunks.map((c: string) => JSON.parse(c.trim()));
    const inputResponse = allWritten.find(
      (m: any) => m.id === 30 && m.result?.answers?.q1?.answers?.[0] === "Approve this Session",
    );
    expect(inputResponse).toBeDefined();
  });

  it("auto-answers requestUserInput with non-interactive fallback", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcRequest(31, "item/tool/requestUserInput", {
        questions: [{ id: "q1" }],
      }),
      rpcNotification("turn/completed"),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "No options",
      workspacePath: "/tmp/ws",
    });

    for await (const _ of adapter.streamEvents(handle)) {
    }

    const allWritten = mockProc._writtenChunks.map((c: string) => JSON.parse(c.trim()));
    const inputResponse = allWritten.find(
      (m: any) =>
        m.id === 31 &&
        m.result?.answers?.q1?.answers?.[0] ===
          "This is a non-interactive session. Operator input is unavailable.",
    );
    expect(inputResponse).toBeDefined();
  });

  it("treats zero events as failure", async () => {
    const mockProc = createTerminatingMockProcess([
      ...handshakeResponses(),
      // No turn events — process ends
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Nothing",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    const doneEvents = collected.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toEqual({ type: "done", success: false });
  });

  it("yields error when no child process found", async () => {
    const handle = {
      id: "nonexistent-session",
      abortController: new AbortController(),
    };

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toEqual([{ type: "error", message: "No child process found for session" }]);
  });

  it("stops a session by killing the process", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcNotification("turn/completed"),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Long task",
      workspacePath: "/tmp/ws",
    });

    await adapter.stopSession(handle);
    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stopSession waits for exit even though abort already sent SIGTERM (FRG-4086)", async () => {
    vi.useFakeTimers();
    try {
      const mockProc = createMockProcess([
        ...handshakeResponses(),
        rpcNotification("turn/completed"),
      ]);
      Object.assign(mockProc, { signalCode: null });
      // Like a real child: `killed` flips on the first signal, exit only on SIGKILL.
      mockProc.kill.mockImplementation((signal?: string) => {
        (mockProc as any).killed = true;
        if (signal === "SIGKILL") {
          (mockProc as any).signalCode = "SIGKILL";
          mockProc.emit("exit", null, "SIGKILL");
        }
        return true;
      });
      vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);
      const handle = await adapter.startSession({ prompt: "Task", workspacePath: "/tmp/ws" });

      let stopped = false;
      const stopping = adapter.stopSession(handle).then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      await stopping;
      expect(mockProc.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up process reference after stop", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcNotification("turn/completed"),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Task",
      workspacePath: "/tmp/ws",
    });

    await adapter.stopSession(handle);

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toEqual([{ type: "error", message: "No child process found for session" }]);
  });

  it("uses custom command when provided", async () => {
    const customAdapter = new CodexAdapter({ command: "my-codex" });
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcNotification("turn/completed"),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await customAdapter.startSession({
      prompt: "Do it",
      workspacePath: "/tmp/ws",
    });

    expect(child_process.spawn).toHaveBeenCalledWith("my-codex", ["app-server"], expect.anything());
  });

  it("kills process on abort", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcNotification("turn/completed"),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Test",
      workspacePath: "/tmp/ws",
    });

    handle.abortController.abort();
    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("reuses process across turns for same sessionId", async () => {
    // Set up a process that emits handshake + turn 1 events, then turn 2 events
    const turn1Events = [
      ...handshakeResponses(),
      rpcNotification("item/assistantMessage/streamTextDelta", { delta: "Turn 1" }),
      rpcNotification("turn/completed"),
    ];
    const turn2Events = [
      rpcResponse(4, { turn: { id: "turn_2" } }),
      rpcNotification("item/assistantMessage/streamTextDelta", { delta: "Turn 2" }),
      rpcNotification("turn/completed"),
    ];

    let batchIndex = 0;
    const allBatches = [turn1Events, turn2Events];
    const writtenChunks: string[] = [];

    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        writtenChunks.push(chunk.toString());
        callback();
      },
    });

    const stdout = new Readable({
      read() {
        if (batchIndex < allBatches.length) {
          for (const line of allBatches[batchIndex]) {
            this.push(`${line}\n`);
          }
          batchIndex++;
        }
      },
    });

    const mockProc = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new Readable({
        read() {
          this.push(null);
        },
      }),
      stdin,
      pid: 54321,
      exitCode: null as number | null,
      killed: false,
      kill: vi.fn(() => {
        (mockProc as any).killed = true;
        mockProc.emit("exit", 0);
      }),
    });

    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    // Turn 1
    const handle1 = await adapter.startSession({
      prompt: "First turn",
      workspacePath: "/tmp/ws",
      sessionId: "test-session",
    });

    const events1: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle1)) {
      events1.push(event);
    }
    expect(events1).toContainEqual({ type: "text", content: "Turn 1" });
    expect(events1).toContainEqual({ type: "done", success: true });

    // Turn 2 — reuse same session
    const handle2 = await adapter.startSession({
      prompt: "Second turn",
      workspacePath: "/tmp/ws",
      sessionId: "test-session",
    });

    // Spawn called only once
    expect(child_process.spawn).toHaveBeenCalledTimes(1);
    expect(handle2.pid).toBe(handle1.pid);

    const events2: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle2)) {
      events2.push(event);
    }
    expect(events2).toContainEqual({ type: "text", content: "Turn 2" });
    expect(events2).toContainEqual({ type: "done", success: true });

    // Verify continuation turn sent only turn/start (id=4), not full handshake
    const allWritten = writtenChunks.map((c) => JSON.parse(c.trim()));
    const continuationTurnStart = allWritten.find(
      (m: any) => m.id === 4 && m.method === "turn/start",
    );
    expect(continuationTurnStart).toBeDefined();
    expect(continuationTurnStart.params.threadId).toBe("th_test");
    expect(continuationTurnStart.params.input[0].text).toBe("Second turn");
  });

  it("skips non-JSON lines gracefully", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      "some startup noise",
      rpcNotification("item/assistantMessage/streamTextDelta", { delta: "Hi" }),
      "debug output here",
      rpcNotification("turn/completed"),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Hi",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    const textEvents = collected.filter((e) => e.type === "text");
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]).toEqual({ type: "text", content: "Hi" });
  });

  it("extracts usage from turn/completed params", async () => {
    const mockProc = createMockProcess([
      ...handshakeResponses(),
      rpcNotification("turn/completed", {
        usage: { input_tokens: 200, output_tokens: 100 },
      }),
    ]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Count",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    const usageEvents = collected.filter((e) => e.type === "usage" && e.inputTokens > 0);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toEqual({
      type: "usage",
      inputTokens: 200,
      outputTokens: 100,
    });
  });

  // FRG-4085: on a Smith the orchestrator runs as root; the Codex child drops
  // to the forge worker uid like the Claude child, so it never runs as root.
});

import { describe, expect, it, vi } from "vitest";
import { runAgentOnce } from "../../../src/agent/run-once.js";
import type {
  AgentAdapter,
  AgentEvent,
  SessionHandle,
  StartSessionParams,
} from "../../../src/agent/types.js";

function handle(): SessionHandle {
  return { id: "s1", abortController: new AbortController() };
}

async function* events(list: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const e of list) yield e;
}

/** A streamEvents-style adapter (Claude): the prompt rides on startSession. */
function streamingAgent(list: AgentEvent[]) {
  const agent = {
    name: "claude",
    persistentSession: true,
    startSession: vi.fn(async () => handle()),
    streamEvents: vi.fn(() => events(list)),
    stopSession: vi.fn(async () => {}),
  };
  return agent satisfies AgentAdapter;
}

/** A runTurn adapter (codex) whose handshake settles only when the test says so. */
function handshakingAgent() {
  let release: (h: SessionHandle) => void = () => {};
  let fail: (e: Error) => void = () => {};
  const agent = {
    name: "codex",
    persistentSession: true,
    startSession: vi.fn(
      (_params: StartSessionParams) =>
        new Promise<SessionHandle>((resolve, reject) => {
          release = resolve;
          fail = reject;
        }),
    ),
    streamEvents: vi.fn(() => events([])),
    runTurn: vi.fn(() => events([])),
    stopSession: vi.fn(async () => {}),
  } satisfies AgentAdapter;
  return { agent, release: (h: SessionHandle) => release(h), fail: (e: Error) => fail(e) };
}

describe("runAgentOnce", () => {
  it("times out a session that hangs in its handshake, then stops it", async () => {
    const { agent, release } = handshakingAgent();

    // The grace bounds the wait for a hung handshake: the caller is released anyway.
    await expect(
      runAgentOnce(agent, {
        prompt: "p",
        workspacePath: "/repo",
        timeoutMs: 10,
        handshakeGraceMs: 10,
      }),
    ).rejects.toThrow("codex session timed out after 0.01s");
    expect(agent.stopSession).not.toHaveBeenCalled();

    // The handshake completes late: the orphaned session is stopped, never run.
    release(handle());
    await vi.waitFor(() => expect(agent.stopSession).toHaveBeenCalledTimes(1));
    expect(agent.runTurn).not.toHaveBeenCalled();
  });

  it("stops a session cancelled mid-handshake before rejecting (FRG-5161)", async () => {
    const { agent, release } = handshakingAgent();
    const controller = new AbortController();
    const run = runAgentOnce(agent, {
      prompt: "p",
      workspacePath: "/repo",
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    let settled = false;
    run.catch(() => {}).finally(() => (settled = true));
    await vi.waitFor(() => expect(agent.startSession).toHaveBeenCalled());

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Still waiting on the handshake: the caller keeps its slot and tree.
    expect(settled).toBe(false);

    release(handle());
    await expect(run).rejects.toThrow("codex session was cancelled");
    expect(agent.stopSession).toHaveBeenCalledTimes(1);
    expect(agent.runTurn).not.toHaveBeenCalled();
  });

  it("aborts the startSession signal on cancel so the handshake is killed (FRG-5682)", async () => {
    const { agent } = handshakingAgent();
    // Like codex: the abort kills the child and rejects the pending startSession.
    agent.startSession.mockImplementation(
      ({ signal }: StartSessionParams) =>
        new Promise<SessionHandle>((_, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const controller = new AbortController();
    const run = runAgentOnce(agent, {
      prompt: "p",
      workspacePath: "/repo",
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(agent.startSession).toHaveBeenCalled());
    const { signal } = agent.startSession.mock.calls[0][0];
    expect(signal?.aborted).toBe(false);

    const started = Date.now();
    controller.abort();
    await expect(run).rejects.toThrow("codex session was cancelled");
    // Settled by the adapter's rejection, not the 10s handshake grace.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(signal?.aborted).toBe(true);
    expect(agent.stopSession).not.toHaveBeenCalled();
  });

  it("aborts the startSession signal when the deadline fires mid-handshake (FRG-5682)", async () => {
    const { agent, fail } = handshakingAgent();
    const run = runAgentOnce(agent, {
      prompt: "p",
      workspacePath: "/repo",
      timeoutMs: 10,
      handshakeGraceMs: 10,
    });

    await expect(run).rejects.toThrow("codex session timed out after 0.01s");
    const { signal } = agent.startSession.mock.calls[0][0];
    expect(signal?.aborted).toBe(true);
    fail(new Error("aborted"));
  });

  it("stops a session that times out mid-handshake before rejecting", async () => {
    const { agent, release } = handshakingAgent();
    const run = runAgentOnce(agent, { prompt: "p", workspacePath: "/repo", timeoutMs: 10 });
    setTimeout(() => release(handle()), 30);

    await expect(run).rejects.toThrow("codex session timed out after 0.01s");
    expect(agent.stopSession).toHaveBeenCalledTimes(1);
    expect(agent.runTurn).not.toHaveBeenCalled();
  });

  it("rejects with the stop reason when the handshake fails during the grace", async () => {
    const { agent, fail } = handshakingAgent();
    const run = runAgentOnce(agent, { prompt: "p", workspacePath: "/repo", timeoutMs: 10 });
    setTimeout(() => fail(new Error("handshake failed")), 30);

    await expect(run).rejects.toThrow("codex session timed out after 0.01s");
    expect(agent.stopSession).not.toHaveBeenCalled();
  });

  it("sends the prompt on startSession and joins the text of a streamEvents adapter", async () => {
    const agent = streamingAgent([
      { type: "text", content: "hello " },
      { type: "tool_use", tool: "Bash", input: {} },
      { type: "text", content: "world" },
      { type: "done", success: true },
    ]);

    const out = await runAgentOnce(agent, {
      prompt: "review",
      workspacePath: "/repo",
      timeoutMs: 1000,
    });

    expect(out).toBe("hello world");
    expect(agent.startSession).toHaveBeenCalledWith({
      prompt: "review",
      workspacePath: "/repo",
      handshakeOnly: false,
      signal: expect.any(AbortSignal),
    });
    expect(agent.stopSession).toHaveBeenCalledTimes(1);
  });

  it("handshakes then feeds the prompt through runTurn when the adapter has one", async () => {
    const runTurn = vi.fn(() =>
      events([
        { type: "text", content: "qa done" },
        { type: "done", success: true },
      ]),
    );
    const agent = {
      name: "kimi",
      persistentSession: true,
      startSession: vi.fn(async () => handle()),
      streamEvents: vi.fn(() => events([])),
      runTurn,
      stopSession: vi.fn(async () => {}),
    } satisfies AgentAdapter;

    const out = await runAgentOnce(agent, {
      prompt: "run QA",
      workspacePath: "/repo",
      timeoutMs: 1000,
    });

    expect(out).toBe("qa done");
    expect(agent.startSession).toHaveBeenCalledWith({
      prompt: "",
      workspacePath: "/repo",
      handshakeOnly: true,
      signal: expect.any(AbortSignal),
    });
    expect(runTurn).toHaveBeenCalledWith(expect.anything(), "run QA");
    expect(agent.streamEvents).not.toHaveBeenCalled();
  });

  it("rejects with the agent's errors when the turn fails, and still stops the session", async () => {
    const agent = streamingAgent([
      { type: "error", message: "invalid x-api-key" },
      { type: "done", success: false },
    ]);

    await expect(
      runAgentOnce(agent, { prompt: "p", workspacePath: "/repo", timeoutMs: 1000 }),
    ).rejects.toThrow("claude session failed: invalid x-api-key");
    expect(agent.stopSession).toHaveBeenCalledTimes(1);
  });

  it("aborts the session and rejects on timeout", async () => {
    let aborted = false;
    const agent = {
      name: "codex",
      persistentSession: false,
      startSession: vi.fn(async () => handle()),
      // Ends only once the session is aborted, like a killed child.
      streamEvents: vi.fn((h: SessionHandle) =>
        (async function* () {
          await new Promise<void>((resolve) =>
            h.abortController.signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            }),
          );
          yield { type: "done", success: false } as AgentEvent;
        })(),
      ),
      stopSession: vi.fn(async () => {}),
    } satisfies AgentAdapter;

    await expect(
      runAgentOnce(agent, { prompt: "p", workspacePath: "/repo", timeoutMs: 10 }),
    ).rejects.toThrow("codex session timed out after 0.01s");
    expect(aborted).toBe(true);
    expect(agent.stopSession).toHaveBeenCalledTimes(1);
  });

  it("aborts a running session and rejects when the caller cancels (FRG-4321)", async () => {
    const agent = {
      name: "claude",
      persistentSession: false,
      startSession: vi.fn(async () => handle()),
      // Ends only once the session is aborted, like a killed child.
      streamEvents: vi.fn((h: SessionHandle) =>
        (async function* () {
          await new Promise<void>((resolve) =>
            h.abortController.signal.addEventListener("abort", () => resolve()),
          );
          yield { type: "done", success: false } as AgentEvent;
        })(),
      ),
      stopSession: vi.fn(async () => {}),
    } satisfies AgentAdapter;
    const controller = new AbortController();

    const run = runAgentOnce(agent, {
      prompt: "p",
      workspacePath: "/repo",
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(agent.streamEvents).toHaveBeenCalled());
    controller.abort();

    await expect(run).rejects.toThrow("claude session was cancelled");
    expect(agent.stopSession).toHaveBeenCalledTimes(1);
  });

  it("rejects an already-cancelled call without starting a session", async () => {
    const agent = streamingAgent([{ type: "done", success: true }]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      runAgentOnce(agent, {
        prompt: "p",
        workspacePath: "/repo",
        timeoutMs: 1000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("claude session was cancelled");
    expect(agent.startSession).not.toHaveBeenCalled();
  });
});

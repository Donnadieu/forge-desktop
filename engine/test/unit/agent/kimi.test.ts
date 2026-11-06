import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentEvent, SessionHandle } from "../../../src/agent/types.js";

// Hoisted child_process mock — declared BEFORE importing the adapter so the import
// resolves `spawn` to the mock. The adapter spawns the real `kimi` binary in prod;
// here we feed it canned stream-json stdout and control the exit code.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { KimiAdapter } from "../../../src/agent/kimi.js";
import { agentTreeMarkers } from "../../support/agent-tree.js";

const RESUME_HINT = (sid: string) =>
  `{"role":"meta","type":"session.resume_hint","session_id":"${sid}","command":"kimi -r ${sid}"}`;

/** A fake ChildProcess that streams the given stdout lines, then exits. */
function makeChild(lines: string[], opts: { exitCode?: number | null; stderr?: string } = {}) {
  const { exitCode = 0, stderr = "" } = opts;
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    pid?: number;
  };
  child.killed = false;
  child.pid = 4242;
  const stdout = Readable.from([lines.map((l) => `${l}\n`).join("")]);
  child.stdout = stdout;
  const stderrEmitter = new EventEmitter();
  child.stderr = stderrEmitter;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit("exit", null);
    return true;
  });
  stdout.on("end", () => {
    if (stderr) stderrEmitter.emit("data", Buffer.from(stderr));
    process.nextTick(() => child.emit("exit", exitCode));
  });
  return child;
}

/** A fake ChildProcess whose stdout stays open until the test ends/kills it (for abort). */
function makeControllableChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    pid?: number;
  };
  child.killed = false;
  child.pid = 4243;
  const stdout = new PassThrough();
  child.stdout = stdout;
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    child.killed = true;
    stdout.end();
    process.nextTick(() => child.emit("exit", null));
    return true;
  });
  return { child, stdout };
}

/** Write a per-agent wire.jsonl under KIMI_CODE_HOME for a session so flushUsage can read it.
 *  Defaults to the `main` agent; pass `agent` (e.g. "agent-0") to seed a sub-agent's usage. */
function writeWire(home: string, sessionId: string, records: string[], agent = "main") {
  const dir = join(home, "sessions", "wd_test_abcdef012345", sessionId, "agents", agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "wire.jsonl"), `${records.join("\n")}\n`);
}

/** Write a full session dir (state.json with `cwd` + a main wire.jsonl) so flushUsage can
 *  discover it by workspace cwd BEFORE the end-of-turn resume_hint — the live-usage path. */
function writeSession(home: string, sessionId: string, cwd: string, records: string[]) {
  const dir = join(home, "sessions", "wd_live_deadbeef00", sessionId);
  mkdirSync(join(dir, "agents", "main"), { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ id: sessionId, cwd }));
  writeFileSync(join(dir, "agents", "main", "wire.jsonl"), `${records.join("\n")}\n`);
}

function usageRecord(u: {
  inputOther?: number;
  output?: number;
  inputCacheRead?: number;
  inputCacheCreation?: number;
}) {
  return JSON.stringify({
    type: "usage.record",
    agentId: "main",
    model: "kimi-k2.7-code",
    usage: {
      inputOther: u.inputOther ?? 0,
      output: u.output ?? 0,
      inputCacheRead: u.inputCacheRead ?? 0,
      inputCacheCreation: u.inputCacheCreation ?? 0,
    },
    usageScope: "turn",
  });
}

async function drainRunTurn(adapter: KimiAdapter, handle: SessionHandle, prompt: string) {
  const collected: AgentEvent[] = [];
  // biome-ignore lint/style/noNonNullAssertion: runTurn is defined on KimiAdapter
  for await (const e of adapter.runTurn!(handle, prompt)) collected.push(e);
  return collected;
}

describe("KimiAdapter", () => {
  const originalKey = process.env.KIMI_API_KEY;
  const originalModel = process.env.FORGE_WORKER_MODEL;
  const originalHome = process.env.KIMI_CODE_HOME;
  let home: string;

  beforeEach(() => {
    process.env.KIMI_API_KEY = "test-key";
    process.env.FORGE_WORKER_MODEL = "kimi-k2.7-code";
    home = mkdtempSync(join(tmpdir(), "kimi-home-"));
    process.env.KIMI_CODE_HOME = home;
    spawnMock.mockReset();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.KIMI_API_KEY;
    else process.env.KIMI_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.FORGE_WORKER_MODEL;
    else process.env.FORGE_WORKER_MODEL = originalModel;
    if (originalHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("constructs without KIMI_API_KEY but refuses to start a session (FRG-4532)", async () => {
    // A held BYOK Smith builds the adapter with no key; the orchestrator must still boot.
    delete process.env.KIMI_API_KEY;
    const adapter = new KimiAdapter();
    await expect(adapter.startSession({ prompt: "x", workspacePath: "/tmp/w" })).rejects.toThrow(
      /KIMI_API_KEY/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("checks KIMI_API_KEY in an explicit per-session env, not process.env (FRG-2239)", async () => {
    const keyless = new KimiAdapter({ env: { PATH: "/usr/bin" } });
    await expect(keyless.startSession({ prompt: "x", workspacePath: "/tmp/w" })).rejects.toThrow(
      /KIMI_API_KEY/,
    );
    delete process.env.KIMI_API_KEY;
    const keyed = new KimiAdapter({ model: "kimi-k2.7-code", env: { KIMI_API_KEY: "user-key" } });
    await expect(
      keyed.startSession({ prompt: "x", workspacePath: "/tmp/w" }),
    ).resolves.toBeDefined();
  });

  it("spawns on an explicit per-session env (FRG-2239)", async () => {
    spawnMock.mockReturnValue(makeChild([RESUME_HINT("session_env")]));
    const env = { PATH: "/usr/bin", KIMI_API_KEY: "user-key", KIMI_CODE_HOME: "/tmp/gate/.kimi" };
    const adapter = new KimiAdapter({ model: "kimi-k2.7-code", env });
    const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
    await drainRunTurn(adapter, handle, "go");

    const options = spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(options.env).toEqual({
      ...env,
      KIMI_CODE_NO_AUTO_UPDATE: "1",
      ...agentTreeMarkers("/tmp/workspace"),
    });
  });

  it("scrubs env_denylist matches from the child env (FRG-4081)", async () => {
    spawnMock.mockReturnValue(makeChild([RESUME_HINT("session_deny")]));
    const env = { PATH: "/usr/bin", KIMI_API_KEY: "k", DATABASE_URL: "postgres://staging" };
    const adapter = new KimiAdapter({
      model: "kimi-k2.7-code",
      env,
      envDenylist: ["DATABASE_URL"],
    });
    const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
    await drainRunTurn(adapter, handle, "go");

    const options = spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(options.env).toEqual({
      PATH: "/usr/bin",
      KIMI_API_KEY: "k",
      KIMI_CODE_NO_AUTO_UPDATE: "1",
      ...agentTreeMarkers("/tmp/workspace"),
    });
  });

  it("withholds the owner's Claude subscription token from the child env (FRG-3009)", async () => {
    spawnMock.mockReturnValue(makeChild([RESUME_HINT("session_oauth")]));
    const env = {
      PATH: "/usr/bin",
      KIMI_API_KEY: "k",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-owner",
    };
    const adapter = new KimiAdapter({ model: "kimi-k2.7-code", env });
    const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
    await drainRunTurn(adapter, handle, "go");

    const options = spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(options.env).toEqual({
      PATH: "/usr/bin",
      KIMI_API_KEY: "k",
      KIMI_CODE_NO_AUTO_UPDATE: "1",
      ...agentTreeMarkers("/tmp/workspace"),
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-owner");
  });

  it("throws on startSession when no model resolvable", async () => {
    delete process.env.FORGE_WORKER_MODEL;
    const adapter = new KimiAdapter();
    await expect(adapter.startSession({ prompt: "hi", workspacePath: "/tmp/ws" })).rejects.toThrow(
      /model/,
    );
  });

  it("startSession does not spawn a process (runTurn-only)", async () => {
    const adapter = new KimiAdapter();
    await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  describe("runTurn argv", () => {
    it("spawns `kimi -p <prompt> --output-format stream-json -m <model>` in the workspace", async () => {
      spawnMock.mockReturnValue(
        makeChild([`{"role":"assistant","content":"ok"}`, RESUME_HINT("session_a")]),
      );
      const adapter = new KimiAdapter({ model: "kimi-k2.7-code", command: "/usr/local/bin/kimi" });
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
      await drainRunTurn(adapter, handle, "do the thing");

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [cmd, args, options] = spawnMock.mock.calls[0];
      expect(cmd).toBe("/usr/local/bin/kimi");
      expect(args).toEqual([
        "-p",
        "do the thing",
        "--output-format",
        "stream-json",
        "-m",
        "kimi-k2.7-code",
      ]);
      expect(options.cwd).toBe("/tmp/workspace");
      expect(options.env.KIMI_CODE_NO_AUTO_UPDATE).toBe("1");
    });

    it("resumes with `-r <sessionId>` on the second turn (id from resume_hint)", async () => {
      spawnMock
        .mockReturnValueOnce(
          makeChild([`{"role":"assistant","content":"ack"}`, RESUME_HINT("session_xyz")]),
        )
        .mockReturnValueOnce(
          makeChild([`{"role":"assistant","content":"answer"}`, RESUME_HINT("session_xyz")]),
        );
      const adapter = new KimiAdapter();
      const handle = await adapter.startSession({ prompt: "", workspacePath: "/tmp/ws" });

      await drainRunTurn(adapter, handle, "first");
      await drainRunTurn(adapter, handle, "second");

      const firstArgs = spawnMock.mock.calls[0][1] as string[];
      const secondArgs = spawnMock.mock.calls[1][1] as string[];
      expect(firstArgs).not.toContain("-r");
      expect(secondArgs.slice(0, 2)).toEqual(["-r", "session_xyz"]);
    });
  });

  describe("runTurn stream-json mapping", () => {
    it("maps assistant.content → text", async () => {
      spawnMock.mockReturnValue(
        makeChild([`{"role":"assistant","content":"Hello"}`, RESUME_HINT("s1")]),
      );
      const adapter = new KimiAdapter();
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
      const collected = await drainRunTurn(adapter, handle, "say hi");

      expect(collected).toContainEqual({ type: "text", content: "Hello" });
      expect(collected).toContainEqual({ type: "done", success: true });
    });

    it("maps assistant.tool_calls → tool_use with parsed JSON arguments", async () => {
      spawnMock.mockReturnValue(
        makeChild([
          `{"role":"assistant","tool_calls":[{"type":"function","id":"Bash_0","function":{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}`,
          RESUME_HINT("s2"),
        ]),
      );
      const adapter = new KimiAdapter();
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
      const collected = await drainRunTurn(adapter, handle, "p");

      expect(collected).toContainEqual({
        type: "tool_use",
        tool: "Bash",
        input: { command: "ls" },
      });
    });

    it("keeps tool_calls arguments as raw string when not valid JSON", async () => {
      spawnMock.mockReturnValue(
        makeChild([
          `{"role":"assistant","tool_calls":[{"type":"function","id":"c","function":{"name":"Bash","arguments":"not-json{"}}]}`,
          RESUME_HINT("s3"),
        ]),
      );
      const adapter = new KimiAdapter();
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
      const collected = await drainRunTurn(adapter, handle, "p");

      expect(collected).toContainEqual({ type: "tool_use", tool: "Bash", input: "not-json{" });
    });

    it("passes tool_calls arguments=null through as null", async () => {
      spawnMock.mockReturnValue(
        makeChild([
          `{"role":"assistant","tool_calls":[{"type":"function","id":"c","function":{"name":"NoArgs","arguments":null}}]}`,
          RESUME_HINT("s4"),
        ]),
      );
      const adapter = new KimiAdapter();
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
      const collected = await drainRunTurn(adapter, handle, "p");

      expect(collected).toContainEqual({ type: "tool_use", tool: "NoArgs", input: null });
    });

    it("maps role:tool → tool_result (content passed through verbatim)", async () => {
      spawnMock.mockReturnValue(
        makeChild([
          `{"role":"tool","tool_call_id":"Bash_0","content":"cat: nope: No such file\\nCommand failed with exit code: 1."}`,
          RESUME_HINT("s5"),
        ]),
      );
      const adapter = new KimiAdapter();
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
      const collected = await drainRunTurn(adapter, handle, "p");

      expect(collected).toContainEqual({
        type: "tool_result",
        output: "cat: nope: No such file\nCommand failed with exit code: 1.",
      });
    });

    it("skips meta/system.version lines", async () => {
      spawnMock.mockReturnValue(
        makeChild([
          `{"role":"meta","type":"system.version","version":"0.40.1"}`,
          `{"role":"assistant","content":"hi"}`,
          RESUME_HINT("s6"),
        ]),
      );
      const adapter = new KimiAdapter();
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
      const collected = await drainRunTurn(adapter, handle, "p");

      const texts = collected.filter((e) => e.type === "text");
      expect(texts).toEqual([{ type: "text", content: "hi" }]);
    });
  });

  describe("usage (from wire.jsonl)", () => {
    it("emits each usage.record as a per-call usage event (summed downstream)", async () => {
      writeWire(home, "session_u1", [
        usageRecord({ inputOther: 100, output: 25, inputCacheRead: 50 }),
        usageRecord({ inputOther: 200, output: 60, inputCacheRead: 70, inputCacheCreation: 5 }),
      ]);
      spawnMock.mockReturnValue(
        makeChild([`{"role":"assistant","content":"done"}`, RESUME_HINT("session_u1")]),
      );
      const adapter = new KimiAdapter();
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
      const collected = await drainRunTurn(adapter, handle, "p");

      const usage = collected.filter(
        (e): e is Extract<AgentEvent, { type: "usage" }> => e.type === "usage",
      );
      expect(usage).toEqual([
        {
          type: "usage",
          inputTokens: 100,
          outputTokens: 25,
          cacheReadTokens: 50,
          cacheWriteTokens: 0,
        },
        {
          type: "usage",
          inputTokens: 200,
          outputTokens: 60,
          cacheReadTokens: 70,
          cacheWriteTokens: 5,
        },
      ]);
    });

    it("sums usage across ALL agent wire.jsonl files, not just main (multi-agent build)", async () => {
      // kimi-code spawns parallel sub-agents (agents/agent-N), each with its own
      // wire.jsonl and its own billed tokens. Reading only `main` under-counts; the
      // adapter must fan out over every agents/*/wire.jsonl.
      writeWire(home, "session_ma", [usageRecord({ inputOther: 100, output: 10 })], "main");
      writeWire(home, "session_ma", [usageRecord({ inputOther: 40, output: 5 })], "agent-0");
      writeWire(home, "session_ma", [usageRecord({ inputOther: 30, output: 3 })], "agent-1");
      spawnMock.mockReturnValue(
        makeChild([`{"role":"assistant","content":"done"}`, RESUME_HINT("session_ma")]),
      );
      const adapter = new KimiAdapter();
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
      const collected = await drainRunTurn(adapter, handle, "p");

      const usage = collected.filter(
        (e): e is Extract<AgentEvent, { type: "usage" }> => e.type === "usage",
      );
      // One usage event per agent's record — order follows readdir, so assert the set.
      expect(usage).toHaveLength(3);
      const totalInput = usage.reduce((a, e) => a + e.inputTokens, 0);
      const totalOutput = usage.reduce((a, e) => a + e.outputTokens, 0);
      expect(totalInput).toBe(170); // 100 (main) + 40 + 30 — NOT just main's 100
      expect(totalOutput).toBe(18); // 10 + 5 + 3
    });

    it("only emits usage appended since the previous turn (offset-tracked)", async () => {
      writeWire(home, "session_u2", [usageRecord({ inputOther: 1000, output: 200 })]);
      spawnMock
        .mockReturnValueOnce(
          makeChild([`{"role":"assistant","content":"t1"}`, RESUME_HINT("session_u2")]),
        )
        .mockReturnValueOnce(
          makeChild([`{"role":"assistant","content":"t2"}`, RESUME_HINT("session_u2")]),
        );
      const adapter = new KimiAdapter();
      const handle = await adapter.startSession({ prompt: "", workspacePath: "/tmp/ws" });

      const events1 = await drainRunTurn(adapter, handle, "first");
      // Append a second turn's usage to the same wire.jsonl before turn 2 runs.
      writeWire(home, "session_u2", [
        usageRecord({ inputOther: 1000, output: 200 }),
        usageRecord({ inputOther: 80, output: 10 }),
      ]);
      const events2 = await drainRunTurn(adapter, handle, "second");

      const u1 = events1.filter((e) => e.type === "usage");
      const u2 = events2.filter((e) => e.type === "usage");
      expect(u1).toEqual([
        {
          type: "usage",
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ]);
      expect(u2).toEqual([
        {
          type: "usage",
          inputTokens: 80,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ]);
    });

    it("discovers the session dir by cwd, so usage flows without a resume_hint (live path)", async () => {
      // A real temp workspace + a session whose state.json records that cwd. flushUsage must
      // resolve the usage source from cwd — this is what lets usage stream WHILE the turn runs,
      // since the resume_hint id only arrives at the very end.
      const ws = mkdtempSync(join(tmpdir(), "kimi-ws-"));
      onTestFinished(() => rmSync(ws, { recursive: true, force: true }));
      writeSession(home, "session_cwd", ws, [usageRecord({ inputOther: 55, output: 9 })]);
      // stdout carries an assistant line but NO resume_hint — discovery must not depend on it.
      spawnMock.mockReturnValue(makeChild([`{"role":"assistant","content":"working"}`]));
      const warn = vi.fn();
      const adapter = new KimiAdapter({ logger: { warn } as unknown as Logger });
      const handle = await adapter.startSession({ prompt: "x", workspacePath: ws });
      const collected = await drainRunTurn(adapter, handle, "p");

      expect(collected.filter((e) => e.type === "usage")).toEqual([
        {
          type: "usage",
          inputTokens: 55,
          outputTokens: 9,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ]);
      expect(collected).toContainEqual({ type: "done", success: true });
      // cwd discovery backfills the session id, so the "no resume_hint" drift warning must NOT fire.
      expect(warn).not.toHaveBeenCalled();
    });

    it("ignores step.end / append_loop_event usage (only reads usage.record)", async () => {
      writeWire(home, "session_u3", [
        usageRecord({ inputOther: 42, output: 7 }),
        JSON.stringify({
          type: "context.append_loop_event",
          event: { type: "step.end", usage: { inputOther: 9999, output: 9999 } },
        }),
      ]);
      spawnMock.mockReturnValue(
        makeChild([`{"role":"assistant","content":"x"}`, RESUME_HINT("session_u3")]),
      );
      const adapter = new KimiAdapter();
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
      const collected = await drainRunTurn(adapter, handle, "p");

      const usage = collected.filter((e) => e.type === "usage");
      expect(usage).toEqual([
        {
          type: "usage",
          inputTokens: 42,
          outputTokens: 7,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ]);
    });
  });

  describe("done + diagnostics", () => {
    it("done success=true on exit code 0", async () => {
      spawnMock.mockReturnValue(
        makeChild([`{"role":"assistant","content":"ok"}`, RESUME_HINT("s7")], { exitCode: 0 }),
      );
      const adapter = new KimiAdapter();
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
      const collected = await drainRunTurn(adapter, handle, "p");
      expect(collected).toContainEqual({ type: "done", success: true });
    });

    it("done success=false on non-zero exit code", async () => {
      spawnMock.mockReturnValue(
        makeChild([`{"role":"assistant","content":"partial"}`], { exitCode: 1 }),
      );
      const adapter = new KimiAdapter();
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
      const collected = await drainRunTurn(adapter, handle, "p");
      expect(collected).toContainEqual({ type: "done", success: false });
    });

    it("emits a diagnostic error (with stderr) when no events are produced", async () => {
      spawnMock.mockReturnValue(
        makeChild([], { exitCode: 1, stderr: "provider has no credential configured" }),
      );
      const adapter = new KimiAdapter();
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
      const collected = await drainRunTurn(adapter, handle, "p");

      expect(collected).toContainEqual({
        type: "error",
        message: expect.stringContaining("no events"),
      });
      expect(collected.at(-1)).toEqual({ type: "done", success: false });
    });
  });

  it("a turn with no events says what kimi printed: its quota or rate-limit error (Forge Desktop)", async () => {
    // kimi-cli 0.80 print mode prints a provider error as a plain line (`Error code: <status> - <body>`).
    const line =
      "Error code: 429 - {'error': {'message': 'Your account 1234<ak-5678> request reached TPM rate limit, current:120000, limit:100000', 'type': 'rate_limit_reached_error'}}";
    spawnMock.mockReturnValue(makeChild([line], { exitCode: 1, stderr: "some warning" }));
    const adapter = new KimiAdapter();
    const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
    const collected = await drainRunTurn(adapter, handle, "p");
    expect(collected).toContainEqual({
      type: "error",
      message: `Kimi turn produced no events: ${line}`,
    });
  });

  describe("fail-loud contract diagnostics", () => {
    /** A minimal Logger stub capturing warn() calls. */
    function makeLogger() {
      const warn = vi.fn();
      return { logger: { warn } as unknown as Logger, warn };
    }

    it("warns once when a turn produced events but no session.resume_hint (drift)", async () => {
      // Assistant content, but NO resume_hint line — id never captured.
      spawnMock
        .mockReturnValueOnce(makeChild([`{"role":"assistant","content":"work"}`]))
        .mockReturnValueOnce(makeChild([`{"role":"assistant","content":"more"}`]));
      const { logger, warn } = makeLogger();
      const adapter = new KimiAdapter({ logger });
      const handle = await adapter.startSession({ prompt: "", workspacePath: "/tmp/ws" });

      const collected = await drainRunTurn(adapter, handle, "first");
      // The turn still succeeds — the diagnostic must not flip it to failure.
      expect(collected).toContainEqual({ type: "done", success: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("session.resume_hint");

      // Second turn does not re-warn (latched per session).
      await drainRunTurn(adapter, handle, "second");
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("warns when a session id was captured but the session dir is unresolvable", async () => {
      // resume_hint present (id captured) but no session dir written under KIMI_CODE_HOME.
      spawnMock.mockReturnValue(
        makeChild([`{"role":"assistant","content":"ran"}`, RESUME_HINT("no_wire_session")]),
      );
      const { logger, warn } = makeLogger();
      const adapter = new KimiAdapter({ logger });
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });

      const collected = await drainRunTurn(adapter, handle, "p");
      expect(collected).toContainEqual({ type: "done", success: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][1]).toContain("session dir");
    });

    it("does not warn on the happy path (resume_hint + wire.jsonl present)", async () => {
      writeWire(home, "happy_session", [usageRecord({ inputOther: 10, output: 2 })]);
      spawnMock.mockReturnValue(
        makeChild([`{"role":"assistant","content":"ok"}`, RESUME_HINT("happy_session")]),
      );
      const { logger, warn } = makeLogger();
      const adapter = new KimiAdapter({ logger });
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });

      await drainRunTurn(adapter, handle, "p");
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("abort", () => {
    it("kills the child and yields only done(false) — no error", async () => {
      const { child, stdout } = makeControllableChild();
      spawnMock.mockReturnValue(child);
      const adapter = new KimiAdapter();
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });

      // biome-ignore lint/style/noNonNullAssertion: runTurn defined on KimiAdapter
      const iter = adapter.runTurn!(handle, "long")[Symbol.asyncIterator]();
      stdout.write(`{"role":"assistant","content":"starting"}\n`);
      const first = await iter.next();
      expect(first.value).toEqual({ type: "text", content: "starting" });

      handle.abortController.abort();
      expect(child.kill).toHaveBeenCalled();

      const collected: AgentEvent[] = [first.value as AgentEvent];
      while (true) {
        const n = await iter.next();
        if (n.done) break;
        collected.push(n.value as AgentEvent);
      }
      expect(collected.map((e) => e.type)).toEqual(["text", "done"]);
      expect(collected.at(-1)).toEqual({ type: "done", success: false });
    });
  });

  describe("streamEvents", () => {
    it("yields done immediately for a known handle (runTurn-only adapter)", async () => {
      const adapter = new KimiAdapter();
      const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
      const collected: AgentEvent[] = [];
      for await (const e of adapter.streamEvents(handle)) collected.push(e);
      expect(collected).toEqual([{ type: "done", success: true }]);
    });

    it("yields error for an unknown handle", async () => {
      const adapter = new KimiAdapter();
      const fake: SessionHandle = { id: "missing", abortController: new AbortController() };
      const collected: AgentEvent[] = [];
      for await (const e of adapter.streamEvents(fake)) collected.push(e);
      expect(collected).toEqual([{ type: "error", message: "No session found for handle" }]);
    });
  });

  it("runTurn yields error+done for an unknown handle", async () => {
    const adapter = new KimiAdapter();
    const fake: SessionHandle = { id: "missing", abortController: new AbortController() };
    const collected = await drainRunTurn(adapter, fake, "p");
    expect(collected).toEqual([
      { type: "error", message: "No session found for handle" },
      { type: "done", success: false },
    ]);
  });

  it("startSession reuses state for the same sessionId", async () => {
    const adapter = new KimiAdapter();
    const handle1 = await adapter.startSession({
      sessionId: "fixed",
      prompt: "a",
      workspacePath: "/tmp/ws",
    });
    const handle2 = await adapter.startSession({
      sessionId: "fixed",
      prompt: "b",
      workspacePath: "/tmp/ws",
    });
    expect(handle1.id).toBe("fixed");
    expect(handle2.id).toBe("fixed");
    expect(handle1.abortController).toBe(handle2.abortController);
  });

  it("stopSession removes state; later streamEvents reports no session", async () => {
    const adapter = new KimiAdapter();
    const handle = await adapter.startSession({ prompt: "x", workspacePath: "/tmp/ws" });
    await adapter.stopSession(handle);
    const collected: AgentEvent[] = [];
    for await (const e of adapter.streamEvents(handle)) collected.push(e);
    expect(collected).toEqual([{ type: "error", message: "No session found for handle" }]);
  });
});

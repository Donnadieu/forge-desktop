import * as child_process from "node:child_process";
import { EventEmitter, Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../../../src/agent/claude.js";
import type { AgentEvent } from "../../../src/agent/types.js";
import { agentTreeMarkers } from "../../support/agent-tree.js";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// The thinking probe runs a real command; here Claude Code "knows" the flag.
vi.mock("../../../src/process/thinking-display.js", () => ({
  thinkingDisplayArgs: vi.fn(async () => ["--thinking-display", "summarized"]),
}));

// Mock fs.existsSync for --mcp-config file check
vi.mock("node:fs", () => ({
  existsSync: vi.fn((path: string) => path === "/tmp/ws/.forge/mcp.json"),
}));

function createMockProcess(events: string[]): any {
  const stdout = new Readable({
    read() {
      for (const event of events) {
        this.push(`${event}\n`);
      }
      this.push(null);
    },
  });

  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
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
    pid: 12345,
    exitCode: null as number | null,
    killed: false,
    kill: vi.fn(() => {
      (proc as any).killed = true;
      proc.emit("exit", 0);
    }),
  });

  return proc;
}

describe("ClaudeCodeAdapter", () => {
  let adapter: ClaudeCodeAdapter;
  const originalWorkerModel = process.env.FORGE_WORKER_MODEL;

  beforeEach(() => {
    process.env.FORGE_WORKER_MODEL = "claude-opus-4-7";
    adapter = new ClaudeCodeAdapter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalWorkerModel === undefined) delete process.env.FORGE_WORKER_MODEL;
    else process.env.FORGE_WORKER_MODEL = originalWorkerModel;
  });

  it("starts a session with correct args", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Fix the bug",
      workspacePath: "/tmp/workspace",
    });

    const spawnArgs = vi.mocked(child_process.spawn).mock.calls[0][1] as string[];
    expect(spawnArgs.slice(0, 6)).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    expect(spawnArgs[6]).toBe("--session-id");
    expect(spawnArgs[7]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(child_process.spawn).toHaveBeenCalledWith(
      "claude",
      expect.any(Array),
      expect.objectContaining({
        cwd: "/tmp/workspace",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(handle.pid).toBe(12345);
  });

  it("asks for the words of the agent's thinking, so a card's Thought rows open", async () => {
    vi.mocked(child_process.spawn).mockReturnValue(createMockProcess([]) as any);
    await adapter.startSession({ prompt: "Fix the bug", workspacePath: "/tmp/workspace" });
    const spawnArgs = vi.mocked(child_process.spawn).mock.calls[0][1] as string[];
    expect(spawnArgs.join(" ")).toContain("--thinking-display summarized");
  });

  it("strips the Anthropic auth overrides on the claude-subscription provider", async () => {
    // FRG-2078: on a Smith the orchestrator holds the platform ANTHROPIC_API_KEY,
    // which Claude Code would prefer over the owner's subscription token.
    vi.stubEnv("FORGE_WORKER_MODEL_PROVIDER", "claude-subscription");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-owner");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-platform");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example");
    try {
      vi.mocked(child_process.spawn).mockReturnValue(createMockProcess([]) as any);
      await adapter.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
      const opts = vi.mocked(child_process.spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-owner");
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(opts.env.ANTHROPIC_BASE_URL).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("spawns on an explicit per-session env instead of process.env (FRG-2239)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-platform");
    vi.stubEnv("DATABASE_URL", "postgres://factory");
    try {
      const scoped = new ClaudeCodeAdapter({
        model: "claude-sonnet-5",
        env: { PATH: "/usr/bin", HOME: "/tmp/gate-home", ANTHROPIC_API_KEY: "sk-ant-user" },
      });
      vi.mocked(child_process.spawn).mockReturnValue(createMockProcess([]) as any);
      await scoped.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
      const opts = vi.mocked(child_process.spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env).toEqual({
        PATH: "/usr/bin",
        HOME: "/tmp/gate-home",
        ANTHROPIC_API_KEY: "sk-ant-user",
        ...agentTreeMarkers("/tmp/workspace"),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("scrubs env_denylist matches from the child env at spawn time (FRG-4081)", async () => {
    vi.stubEnv("FORGE_WORKER_MODEL_PROVIDER", "claude-subscription");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-owner");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-platform");
    try {
      const scrubbed = new ClaudeCodeAdapter({
        model: "claude-sonnet-5",
        envDenylist: ["*DATABASE_URL*", "PGPASSWORD"],
      });
      // Set after construction: the scrub reads process.env per spawn, not a boot snapshot.
      vi.stubEnv("DATABASE_URL", "postgres://staging");
      vi.stubEnv("DATABASE_URL_STAGING_RW", "postgres://staging-rw");
      vi.stubEnv("DATABASE_URL_PROD_RO", "postgres://prod-ro");
      vi.stubEnv("PGPASSWORD", "secret");
      vi.mocked(child_process.spawn).mockReturnValue(createMockProcess([]) as any);
      await scrubbed.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
      const opts = vi.mocked(child_process.spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(Object.keys(opts.env).filter((k) => k.includes("DATABASE_URL"))).toEqual([]);
      expect(opts.env.PGPASSWORD).toBeUndefined();
      expect(opts.env.PATH).toBe(process.env.PATH);
      // The subscription auth strip still composes on top of the denylist.
      expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-owner");
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
      // The orchestrator's own env is untouched.
      expect(process.env.DATABASE_URL).toBe("postgres://staging");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("decides the auth strip before the denylist runs (FRG-4081)", async () => {
    vi.stubEnv("FORGE_WORKER_MODEL_PROVIDER", "claude-subscription");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-owner");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-platform");
    try {
      const scrubbed = new ClaudeCodeAdapter({
        model: "claude-sonnet-5",
        envDenylist: ["FORGE_*"],
      });
      vi.mocked(child_process.spawn).mockReturnValue(createMockProcess([]) as any);
      await scrubbed.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
      const opts = vi.mocked(child_process.spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.FORGE_WORKER_MODEL_PROVIDER).toBeUndefined();
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-owner");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("mirrors the canonical override vars and provider id from config", async () => {
    const canonical = await import("../../../src/config/providers.js");
    const local = await import("../../../src/agent/claude-env.js");
    expect([...local.CLAUDE_AUTH_OVERRIDE_VARS]).toEqual([...canonical.CLAUDE_AUTH_OVERRIDE_VARS]);
    expect(local.CLAUDE_SUBSCRIPTION_PROVIDER_ID).toBe(canonical.CLAUDE_SUBSCRIPTION_PROVIDER_ID);
  });

  it("keeps the API key when a leftover token is present but the provider is not a subscription", async () => {
    vi.stubEnv("FORGE_WORKER_MODEL_PROVIDER", "");
    vi.stubEnv("FORGE_SMITH_REASONING_PROVIDER", "anthropic");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-stale");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-owner");
    try {
      vi.mocked(child_process.spawn).mockReturnValue(createMockProcess([]) as any);
      await adapter.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
      const opts = vi.mocked(child_process.spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.ANTHROPIC_API_KEY).toBe("sk-ant-owner");
      expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("strips the platform key when the Smith's execution half is a subscription (FRG-2095)", async () => {
    vi.stubEnv("FORGE_WORKER_MODEL_PROVIDER", "");
    vi.stubEnv("FORGE_SMITH_REASONING_PROVIDER", "anthropic");
    vi.stubEnv("FORGE_SMITH_EXECUTION_PROVIDER", "claude-subscription");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-owner");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-platform");
    try {
      vi.mocked(child_process.spawn).mockReturnValue(createMockProcess([]) as any);
      await adapter.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
      const opts = vi.mocked(child_process.spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-owner");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("mirrors OpenRouter's Anthropic root from the registry (FRG-4085)", async () => {
    const canonical = await import("../../../src/config/providers.js");
    const local = await import("../../../src/agent/claude-env.js");
    expect(canonical.getProviderConfig(local.OPENROUTER_PROVIDER_ID)?.defaultBaseUrl).toBe(
      local.OPENROUTER_ANTHROPIC_BASE_URL,
    );
  });

  it("points an OpenRouter execution worker at OpenRouter on the owner's key (FRG-4085)", async () => {
    vi.stubEnv("FORGE_WORKER_MODEL_PROVIDER", "");
    vi.stubEnv("FORGE_SMITH_REASONING_PROVIDER", "openrouter");
    vi.stubEnv("FORGE_SMITH_EXECUTION_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-owner");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-platform");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://api.anthropic.com");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-stale");
    try {
      vi.mocked(child_process.spawn).mockReturnValue(createMockProcess([]) as any);
      await adapter.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
      const opts = vi.mocked(child_process.spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
      expect(opts.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-owner");
      expect(opts.env.ANTHROPIC_API_KEY).toBe("");
      expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never falls back to the platform key when the OpenRouter key is missing (FRG-4085)", async () => {
    vi.stubEnv("FORGE_WORKER_MODEL_PROVIDER", "");
    vi.stubEnv("FORGE_SMITH_EXECUTION_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-platform");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "sk-ant-platform-bearer");
    try {
      vi.mocked(child_process.spawn).mockReturnValue(createMockProcess([]) as any);
      await adapter.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
      const opts = vi.mocked(child_process.spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.ANTHROPIC_API_KEY).toBe("");
      expect(opts.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(opts.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("routes a padded OpenRouter execution provider like the funding gate does (FRG-4526)", async () => {
    // The funding gate trims FORGE_SMITH_EXECUTION_PROVIDER; routing must too, or
    // an honoured Studio openrouter agent would run on the platform Anthropic key.
    const { claudeChildEnv, claudeModelArg } = await import("../../../src/agent/claude-env.js");
    const env = {
      FORGE_SMITH_EXECUTION_PROVIDER: " openrouter\n",
      OPENROUTER_API_KEY: "sk-or-owner",
      ANTHROPIC_API_KEY: "sk-ant-platform",
    };
    expect(claudeChildEnv(env)).toMatchObject({
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "sk-or-owner",
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    });
    expect(claudeModelArg("anthropic/claude-opus-5", env)).toBe("anthropic/claude-opus-5");
  });

  it("launches an OpenRouter worker on the full OpenRouter slug (FRG-4085)", async () => {
    vi.stubEnv("FORGE_SMITH_EXECUTION_PROVIDER", "openrouter");
    try {
      const orAdapter = new ClaudeCodeAdapter({ model: "anthropic/claude-opus-4.8" });
      vi.mocked(child_process.spawn).mockReturnValue(createMockProcess([]) as any);
      await orAdapter.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
      const args = vi.mocked(child_process.spawn).mock.calls[0][1] as string[];
      expect(args[args.indexOf("--model") + 1]).toBe("anthropic/claude-opus-4.8");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("strips the provider prefix off the model everywhere else", async () => {
    vi.stubEnv("FORGE_SMITH_EXECUTION_PROVIDER", "anthropic");
    try {
      const prefixed = new ClaudeCodeAdapter({ model: "anthropic/claude-opus-5" });
      vi.mocked(child_process.spawn).mockReturnValue(createMockProcess([]) as any);
      await prefixed.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
      const args = vi.mocked(child_process.spawn).mock.calls[0][1] as string[];
      expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("leaves a mixed Smith's Anthropic worker off OpenRouter (FRG-4085)", async () => {
    vi.stubEnv("FORGE_WORKER_MODEL_PROVIDER", "");
    vi.stubEnv("FORGE_SMITH_REASONING_PROVIDER", "openrouter");
    vi.stubEnv("FORGE_SMITH_EXECUTION_PROVIDER", "anthropic");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-owner");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-owner");
    try {
      vi.mocked(child_process.spawn).mockReturnValue(createMockProcess([]) as any);
      await adapter.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
      const opts = vi.mocked(child_process.spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.ANTHROPIC_API_KEY).toBe("sk-ant-owner");
      expect(opts.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(opts.env.ANTHROPIC_BASE_URL).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps an ambient token when no provider is configured (local / personal orchestrator)", async () => {
    vi.stubEnv("FORGE_WORKER_MODEL_PROVIDER", "");
    vi.stubEnv("FORGE_SMITH_REASONING_PROVIDER", "");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-ambient");
    try {
      vi.mocked(child_process.spawn).mockReturnValue(createMockProcess([]) as any);
      await adapter.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
      const opts = vi.mocked(child_process.spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-ambient");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("strips the platform key on a subscription even when the token is missing", async () => {
    vi.stubEnv("FORGE_WORKER_MODEL_PROVIDER", "");
    vi.stubEnv("FORGE_SMITH_REASONING_PROVIDER", "claude-subscription");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-platform");
    try {
      vi.mocked(child_process.spawn).mockReturnValue(createMockProcess([]) as any);
      await adapter.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
      const opts = vi.mocked(child_process.spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the API key when no subscription token is present", async () => {
    // Pin both provider vars: a subscription Smith's ambient env would strip it.
    vi.stubEnv("FORGE_WORKER_MODEL_PROVIDER", "");
    vi.stubEnv("FORGE_SMITH_REASONING_PROVIDER", "");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-key");
    try {
      vi.mocked(child_process.spawn).mockReturnValue(createMockProcess([]) as any);
      await adapter.startSession({ prompt: "x", workspacePath: "/tmp/workspace" });
      const opts = vi.mocked(child_process.spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("pipes prompt via stdin, not as positional arg", async () => {
    const writtenChunks: string[] = [];
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        writtenChunks.push(chunk.toString());
        callback();
      },
    });

    const mockProc = createMockProcess([]);
    (mockProc as any).stdin = stdin;
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Fix the bug",
      workspacePath: "/tmp/workspace",
    });

    const parsed = JSON.parse(writtenChunks.join("").trim());
    expect(parsed).toEqual({
      type: "user",
      message: { role: "user", content: "Fix the bug" },
    });
    // Verify prompt is NOT in the spawn args
    const spawnArgs = vi.mocked(child_process.spawn).mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain("Fix the bug");
  });

  it("includes --mcp-config when provided", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Fix it",
      workspacePath: "/tmp/ws",
      mcpConfigPath: "/tmp/ws/.forge/mcp.json",
    });

    const spawnArgs = vi.mocked(child_process.spawn).mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--mcp-config");
    expect(spawnArgs).toContain("/tmp/ws/.forge/mcp.json");
    expect(spawnArgs).toContain("--session-id");
  });

  it("skips --mcp-config when file does not exist", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Fix it",
      workspacePath: "/tmp/ws",
      mcpConfigPath: "/tmp/ws/.forge/nonexistent.json",
    });

    const spawnArgs = vi.mocked(child_process.spawn).mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain("--mcp-config");
  });

  it("treats zero events as failure in fallback done", async () => {
    // No events at all — agent crashed at startup
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Do something",
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

  it("includes --session-id when sessionId provided", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Continue",
      workspacePath: "/tmp/ws",
      sessionId: "prev-session-123",
    });

    const spawnArgs = vi.mocked(child_process.spawn).mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--session-id");
    expect(spawnArgs).toContain("prev-session-123");
    expect(spawnArgs).not.toContain("--continue");
  });

  it("includes --session-id on turn 1 (auto-generated UUID)", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Start fresh",
      workspacePath: "/tmp/ws",
    });

    const spawnArgs = vi.mocked(child_process.spawn).mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--session-id");
    const sessionIdx = spawnArgs.indexOf("--session-id");
    expect(spawnArgs[sessionIdx + 1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(spawnArgs).not.toContain("--continue");
  });

  it("uses sessionId as handle id when provided", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Continue",
      workspacePath: "/tmp/ws",
      sessionId: "prev-session-123",
    });

    expect(handle.id).toBe("prev-session-123");
  });

  it("includes --dangerously-skip-permissions for bypassPermissions policy", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Do it",
      workspacePath: "/tmp/ws",
      approvalPolicy: "bypassPermissions",
    });

    expect(vi.mocked(child_process.spawn).mock.calls[0][1]).toContain(
      "--dangerously-skip-permissions",
    );
  });

  it("does not include --dangerously-skip-permissions for other policies", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Do it",
      workspacePath: "/tmp/ws",
      approvalPolicy: "manual",
    });

    expect(vi.mocked(child_process.spawn).mock.calls[0][1]).not.toContain(
      "--dangerously-skip-permissions",
    );
  });

  it("streams and maps text events", async () => {
    const events = [JSON.stringify({ type: "assistant", subtype: "text", text: "Hello world" })];
    const mockProc = createMockProcess(events);
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
    expect(collected).toContainEqual({ type: "done", success: true });
  });

  it("streams and maps tool_use events", async () => {
    const events = [
      JSON.stringify({
        type: "assistant",
        subtype: "tool_use",
        tool: { name: "Read", id: "tool-1" },
        input: { file_path: "/src/main.ts" },
      }),
    ];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Read file",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toContainEqual({
      type: "tool_use",
      tool: "Read",
      input: { file_path: "/src/main.ts" },
    });
  });

  it("streams tool_result events", async () => {
    const events = [
      JSON.stringify({
        type: "tool_result",
        content: [{ type: "text", text: "file contents here" }],
      }),
    ];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Read file",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toContainEqual({
      type: "tool_result",
      output: [{ type: "text", text: "file contents here" }],
    });
  });

  it("extracts usage from assistant batch message.usage with deduplication", async () => {
    const events = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello" }],
          usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 25 },
        },
      }),
      // Duplicate — same usage, should produce zero delta
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "World" }],
          usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 25 },
        },
      }),
    ];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Count tokens",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    const usageEvents = collected.filter((e) => e.type === "usage" && e.inputTokens > 0);
    expect(usageEvents).toHaveLength(1);
    // Cache-read reported separately from fresh input (100 fresh + 50 cache-read).
    expect(usageEvents[0]).toEqual({
      type: "usage",
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
    });
  });

  it("sums distinct per-call assistant usage — the CLI reports per-call, not cumulative", async () => {
    // The Claude CLI emits per-call usage on assistant lines: each call's figures
    // are independent and later calls can be SMALLER than earlier ones (input
    // shrinks, cache grows). Distinct calls must be summed — the old cumulative
    // high-water deduper collapsed them and silently under-counted. Each call
    // repeats its usage on two lines (thinking + text); the repeat is deduped.
    const call = (input: number, cacheRead: number, kind: string) => ({
      type: "assistant",
      message: {
        content: [{ type: kind, text: "x" }],
        usage: { input_tokens: input, cache_read_input_tokens: cacheRead, output_tokens: 4 },
      },
    });
    const events = [
      JSON.stringify(call(10, 13782, "thinking")),
      JSON.stringify(call(10, 13782, "text")), // same call, deduped
      JSON.stringify(call(8, 26328, "thinking")), // next call, smaller input
      JSON.stringify(call(8, 26328, "text")), // same call, deduped
    ];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({ prompt: "p", workspacePath: "/tmp/ws" });
    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    const usageEvents = collected.filter((e) => e.type === "usage") as Extract<
      AgentEvent,
      { type: "usage" }
    >[];
    // Two distinct calls emitted, the duplicates dropped.
    expect(usageEvents).toHaveLength(2);
    const totalInput = usageEvents.reduce((s, e) => s + e.inputTokens, 0);
    const totalCacheRead = usageEvents.reduce((s, e) => s + (e.cacheReadTokens ?? 0), 0);
    // Summed across both calls: 10+8 input, 13782+26328 cache-read.
    expect(totalInput).toBe(18);
    expect(totalCacheRead).toBe(40110);
  });

  it("skips system usage events to avoid double counting", async () => {
    const events = [
      JSON.stringify({
        type: "system",
        subtype: "usage",
        input_tokens: 100,
        output_tokens: 50,
      }),
    ];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Count tokens",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    const usageEvents = collected.filter((e) => e.type === "usage" && e.inputTokens > 0);
    expect(usageEvents).toHaveLength(0);
  });

  it("streams error events", async () => {
    const events = [
      JSON.stringify({
        type: "error",
        error: { message: "Something went wrong" },
      }),
    ];
    const mockProc = createMockProcess(events);
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
  });

  it("maps result events to done events", async () => {
    const events = [
      JSON.stringify({
        type: "result",
        result: "Task complete",
        is_error: false,
        session_id: "abc-123",
      }),
    ];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Do something",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toContainEqual({ type: "done", success: true });
  });

  it("surfaces an is_error result's reason as an error event before the failed done", async () => {
    // Captured from claude 2.1.x with a bogus CLAUDE_CODE_OAUTH_TOKEN (FRG-4321).
    const events = [
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 401,
        terminal_reason: "api_error",
        result: "Failed to authenticate. API Error: 401 Invalid bearer token",
      }),
    ];
    vi.mocked(child_process.spawn).mockReturnValue(createMockProcess(events) as any);

    const handle = await adapter.startSession({ prompt: "p", workspacePath: "/tmp/ws" });
    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toEqual([
      {
        type: "error",
        message: "Failed to authenticate. API Error: 401 Invalid bearer token (API status 401)",
      },
      { type: "done", success: false },
    ]);
  });

  it.each([
    [{ subtype: "success", terminal_reason: "api_error" }, "api_error"],
    [{ subtype: "error_max_turns", result: "" }, "error_max_turns"],
    [{}, "error"],
    [{ result: "x".repeat(3000), api_error_status: 401 }, "x".repeat(2000)],
  ])("falls back to a reason for an is_error result %#", async (fields, message) => {
    const events = [JSON.stringify({ type: "result", is_error: true, ...fields })];
    vi.mocked(child_process.spawn).mockReturnValue(createMockProcess(events) as any);

    const handle = await adapter.startSession({ prompt: "p", workspacePath: "/tmp/ws" });
    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toEqual([
      { type: "error", message },
      { type: "done", success: false },
    ]);
  });

  it("reconciles the turn total from result.usage (authoritative per-turn source)", async () => {
    // result.usage is the fully-summed per-turn total. With nothing streamed yet
    // this turn, the whole thing is emitted as the reconcile delta before done.
    const events = [
      JSON.stringify({
        type: "result",
        result: "Task complete",
        is_error: false,
        usage: { input_tokens: 500, output_tokens: 200 },
      }),
    ];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Do something",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    const usageEvents = collected.filter((e) => e.type === "usage");
    expect(usageEvents).toEqual([
      {
        type: "usage",
        inputTokens: 500,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);
    // Usage is reconciled before the terminal done so the total is final on completion.
    const usageIdx = collected.findIndex((e) => e.type === "usage");
    const doneIdx = collected.findIndex((e) => e.type === "done");
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeLessThan(doneIdx);
    expect(collected).toContainEqual({ type: "done", success: true });
  });

  it("streams partial output live, then reconciles to the exact result.usage total", async () => {
    // Real multi-call turn: the CLI streams accurate input/cache but only a
    // partial output_tokens (4, 2) on assistant lines; the true per-turn total
    // (out=162) arrives only on result. Live events climb; result trues it up.
    const assistant = (
      input: number,
      output: number,
      cacheRead: number,
      cacheWrite: number,
      kind: string,
    ) => ({
      type: "assistant",
      message: {
        content: [{ type: kind, text: "x" }],
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheWrite,
        },
      },
    });
    const events = [
      JSON.stringify(assistant(10, 4, 13782, 12546, "thinking")),
      JSON.stringify(assistant(10, 4, 13782, 12546, "tool_use")), // dup of call 1
      JSON.stringify(assistant(8, 2, 26328, 173, "thinking")),
      JSON.stringify(assistant(8, 2, 26328, 173, "text")), // dup of call 2
      JSON.stringify({
        type: "result",
        is_error: false,
        usage: {
          input_tokens: 18,
          output_tokens: 162,
          cache_read_input_tokens: 40110,
          cache_creation_input_tokens: 12719,
        },
      }),
    ];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({ prompt: "p", workspacePath: "/tmp/ws" });
    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    const usageEvents = collected.filter((e) => e.type === "usage") as Extract<
      AgentEvent,
      { type: "usage" }
    >[];
    // Two live per-call events (dups dropped) + one reconcile at result.
    expect(usageEvents).toHaveLength(3);
    // Output climbed only partially live (4 + 2 = 6) before the reconcile.
    const liveOutput = usageEvents.slice(0, 2).reduce((s, e) => s + e.outputTokens, 0);
    expect(liveOutput).toBe(6);
    // The reconcile tops output up to the authoritative total.
    expect(usageEvents[2].outputTokens).toBe(156);
    // Summed, every axis lands exactly on result.usage — this is what persists.
    const sum = (pick: (e: (typeof usageEvents)[number]) => number) =>
      usageEvents.reduce((s, e) => s + pick(e), 0);
    expect(sum((e) => e.inputTokens)).toBe(18);
    expect(sum((e) => e.outputTokens)).toBe(162);
    expect(sum((e) => e.cacheReadTokens ?? 0)).toBe(40110);
    expect(sum((e) => e.cacheWriteTokens ?? 0)).toBe(12719);
  });

  it("suppresses waitForExit done when result event received", async () => {
    const events = [
      JSON.stringify({
        type: "result",
        result: "Task complete",
        is_error: false,
        session_id: "abc-123",
      }),
    ];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Do something",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    const doneEvents = collected.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toEqual({ type: "done", success: true });
  });

  it("defaults to success true when no result event", async () => {
    // Only text events, no result event — fallback done should be success: true
    const events = [JSON.stringify({ type: "assistant", subtype: "text", text: "Working..." })];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Do something",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    const doneEvents = collected.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toEqual({ type: "done", success: true });
  });

  it("skips non-JSON lines gracefully", async () => {
    const events = [
      "Starting claude...",
      JSON.stringify({ type: "assistant", subtype: "text", text: "Hi" }),
      "some debug output",
    ];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Hi",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    // Should only contain the text event and the done event, not crash on non-JSON
    const textEvents = collected.filter((e) => e.type === "text");
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]).toEqual({ type: "text", content: "Hi" });
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
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Long task",
      workspacePath: "/tmp/ws",
    });

    await adapter.stopSession(handle);
    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("waits for the process to exit and escalates to SIGKILL (FRG-4086)", async () => {
    vi.useFakeTimers();
    try {
      // A real child: SIGTERM sets `killed` immediately but the process only
      // exits later — and this one ignores SIGTERM until SIGKILL.
      const mockProc = createMockProcess([]);
      Object.assign(mockProc, { signalCode: null });
      mockProc.kill.mockImplementation((signal?: string) => {
        (mockProc as any).killed = true;
        if (signal === "SIGKILL") {
          (mockProc as any).signalCode = "SIGKILL";
          mockProc.emit("exit", null, "SIGKILL");
        }
        return true;
      });
      vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);
      const handle = await adapter.startSession({ prompt: "Long task", workspacePath: "/tmp/ws" });

      let stopped = false;
      const stopping = adapter.stopSession(handle).then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(stopped).toBe(false);
      expect(mockProc.kill).not.toHaveBeenCalledWith("SIGKILL");

      await vi.advanceTimersByTimeAsync(1_500);
      await stopping;
      expect(mockProc.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("abort alone escalates to SIGKILL when the process ignores SIGTERM (FRG-4086)", async () => {
    vi.useFakeTimers();
    try {
      // The runner only reaches stopSession once the stream ends, which never
      // happens while a SIGTERM-ignoring process keeps stdout open.
      const mockProc = createMockProcess([]);
      Object.assign(mockProc, { signalCode: null });
      mockProc.kill.mockImplementation((signal?: string) => {
        (mockProc as any).killed = true;
        if (signal === "SIGKILL") {
          (mockProc as any).signalCode = "SIGKILL";
          mockProc.emit("exit", null, "SIGKILL");
        }
        return true;
      });
      vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);
      const handle = await adapter.startSession({ prompt: "Long task", workspacePath: "/tmp/ws" });

      handle.abortController.abort();
      expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockProc.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up process reference after stop", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Long task",
      workspacePath: "/tmp/ws",
    });

    await adapter.stopSession(handle);

    // After stop, streamEvents should yield an error (no process found)
    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toEqual([{ type: "error", message: "No child process found for session" }]);
  });

  it("uses custom command when provided", async () => {
    const customAdapter = new ClaudeCodeAdapter({ command: "my-custom-agent" });
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await customAdapter.startSession({
      prompt: "Do it",
      workspacePath: "/tmp/ws",
    });

    expect(child_process.spawn).toHaveBeenCalledWith(
      "my-custom-agent",
      expect.any(Array),
      expect.anything(),
    );
  });

  it("does not pass signal option to spawn", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Test",
      workspacePath: "/tmp/ws",
    });

    const spawnOptions = vi.mocked(child_process.spawn).mock.calls[0][2] as Record<string, unknown>;
    expect(spawnOptions).not.toHaveProperty("signal");
  });

  it("kills process on abort instead of throwing", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Test",
      workspacePath: "/tmp/ws",
    });

    // Aborting should kill the process, not throw
    handle.abortController.abort();
    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("defaults to 'claude' command when no option provided", async () => {
    const defaultAdapter = new ClaudeCodeAdapter();
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await defaultAdapter.startSession({
      prompt: "Do it",
      workspacePath: "/tmp/ws",
    });

    expect(child_process.spawn).toHaveBeenCalledWith(
      "claude",
      expect.any(Array),
      expect.anything(),
    );
  });

  it("reuses process across turns for same sessionId", async () => {
    const writtenChunks: string[] = [];
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        writtenChunks.push(chunk.toString());
        callback();
      },
    });

    const turn1Events = [
      JSON.stringify({ type: "assistant", subtype: "text", text: "Acknowledged" }),
      JSON.stringify({
        type: "result",
        result: "done",
        is_error: false,
        session_id: "test-session",
      }),
    ];
    const turn2Events = [
      JSON.stringify({ type: "assistant", subtype: "text", text: "debt-tracker" }),
      JSON.stringify({
        type: "result",
        result: "done",
        is_error: false,
        session_id: "test-session",
      }),
    ];

    let batchIndex = 0;
    const allBatches = [turn1Events, turn2Events];
    const stdout = new Readable({
      read() {
        if (batchIndex < allBatches.length) {
          for (const event of allBatches[batchIndex]) {
            this.push(`${event}\n`);
          }
          batchIndex++;
        }
        // Don't push null — process stays alive
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
      pid: 12345,
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
      prompt: "The project is debt-tracker. Acknowledge.",
      workspacePath: "/tmp/ws",
      sessionId: "test-session",
    });

    const events1: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle1)) {
      events1.push(event);
    }
    expect(events1).toContainEqual({ type: "done", success: true });

    // Turn 2 — same sessionId, should reuse process
    const handle2 = await adapter.startSession({
      prompt: "What is the project name?",
      workspacePath: "/tmp/ws",
      sessionId: "test-session",
    });

    // Verify spawn was called only ONCE
    expect(child_process.spawn).toHaveBeenCalledTimes(1);

    // Verify handle2 has same pid
    expect(handle2.pid).toBe(handle1.pid);

    // Verify turn 2 prompt was sent as JSON to same stdin
    expect(writtenChunks.length).toBeGreaterThanOrEqual(2);
    const turn2Msg = JSON.parse(writtenChunks[writtenChunks.length - 1]);
    expect(turn2Msg.message.content).toBe("What is the project name?");

    const events2: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle2)) {
      events2.push(event);
    }
    expect(events2).toContainEqual({ type: "text", content: "debt-tracker" });
    expect(events2).toContainEqual({ type: "done", success: true });
  });
});

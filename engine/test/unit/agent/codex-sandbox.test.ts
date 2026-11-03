import * as child_process from "node:child_process";
import { EventEmitter, Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../../../src/agent/codex.js";
import {
  type CodexSandboxPolicy,
  tenantRepoSandboxPolicy,
} from "../../../src/agent/codex-sandbox.js";
import { createAgent } from "../../../src/agent/index.js";

// FRG-4315: a codex session over a tenant repo (the quality gate) runs its
// commands under `workspaceWrite`; a build worker keeps full access.

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
}));

/**
 * A mock app-server that answers each request as it is written: every request
 * gets a response, and a `turn/start` is followed by `turn/completed`.
 */
function createRespondingMockProcess(): any {
  const written: any[] = [];
  const stdout = new Readable({ read() {} });
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        written.push(msg);
        if (msg.id === undefined) continue;
        const result = msg.method === "thread/start" ? { thread: { id: "th_test" } } : {};
        stdout.push(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
        if (msg.method === "turn/start") {
          stdout.push(
            `${JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: {} })}\n`,
          );
        }
      }
      callback();
    },
  });
  return Object.assign(new EventEmitter(), {
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
    kill: vi.fn(),
    _written: written,
  });
}

describe("CodexAdapter sandbox policy", () => {
  beforeEach(() => {
    vi.stubEnv("FORGE_WORKER_MODEL", "gpt-5.3-codex");
    vi.stubEnv("OPENAI_API_KEY", "sk-test-openai-key");
    vi.mocked(child_process.spawn).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Every turn/start the adapter sends: first, continuation and runTurn. */
  async function turnPolicies(adapter: CodexAdapter): Promise<unknown[]> {
    const proc = createRespondingMockProcess();
    vi.mocked(child_process.spawn).mockReturnValue(proc);
    const params = { prompt: "one", workspacePath: "/tmp/ws", sessionId: "s1" };
    const handle = await adapter.startSession(params);
    for await (const _ of adapter.streamEvents(handle)) {
      // drain turn 1
    }
    await adapter.startSession({ ...params, prompt: "two" });
    for await (const _ of adapter.streamEvents(handle)) {
      // drain turn 2
    }
    for await (const _ of adapter.runTurn(handle, "three")) {
      // drain turn 3
    }
    // One app-server and one thread: turns 2 and 3 took the continuation paths.
    expect(child_process.spawn).toHaveBeenCalledTimes(1);
    expect(proc._written.filter((m: any) => m.method === "thread/start")).toHaveLength(1);
    const turns = proc._written.filter((m: any) => m.method === "turn/start");
    expect(turns.map((m: any) => m.params.input[0].text)).toEqual(["one", "two", "three"]);
    return turns.map((m: any) => m.params.sandboxPolicy);
  }

  const policy: CodexSandboxPolicy = tenantRepoSandboxPolicy("/tmp/ws", "/tmp/gate-home", [
    "/opt/playwright-browsers",
  ]);

  it("defaults every turn to full access, as a single-tenant build worker needs", async () => {
    const policies = await turnPolicies(new CodexAdapter());
    expect(policies).toEqual(Array(3).fill({ type: "dangerFullAccess" }));
  });

  it("sends a given tenant-repo policy on every turn, never full access", async () => {
    const policies = await turnPolicies(new CodexAdapter({ sandboxPolicy: policy }));
    expect(policies).toEqual(Array(3).fill(policy));
  });

  it("reaches the adapter through createAgent", async () => {
    const policies = await turnPolicies(
      createAgent("codex", { sandboxPolicy: policy }) as CodexAdapter,
    );
    expect(policies).toEqual(Array(3).fill(policy));
  });
});

describe("tenantRepoSandboxPolicy", () => {
  it("writes only the repo and session home, reads only them and the extra roots, hides the host /tmp", () => {
    expect(tenantRepoSandboxPolicy("/tmp/r", "/tmp/h", ["/opt/pw"])).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/tmp/r", "/tmp/h"],
      networkAccess: true,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
      readOnlyAccess: {
        type: "restricted",
        includePlatformDefaults: true,
        readableRoots: ["/tmp/r", "/tmp/h", "/opt/pw"],
      },
    });
  });

  it("leaves out an empty or relative readable root, which codex would reject", () => {
    const policy = tenantRepoSandboxPolicy("/tmp/r", "/tmp/h", ["", "0", "rel/dir"]);
    expect(policy).toMatchObject({ readOnlyAccess: { readableRoots: ["/tmp/r", "/tmp/h"] } });
  });
});

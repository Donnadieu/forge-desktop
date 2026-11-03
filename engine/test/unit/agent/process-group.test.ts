import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../../src/agent/claude.js";
import { KimiAdapter } from "../../../src/agent/kimi.js";
import { spawnProcessGroup, terminateChild } from "../../../src/process/process-tree.js";
import { isRunning, waitFor } from "../../support/test-helpers.js";

// A fake `claude` CLI: forks two long sleeps (standing in for `make all` /
// vitest), one in its own process group and one in a new session of its own,
// as Claude Code's Bash tool does (`setsid`). Records both pids, then idles.
// `.cjs` so `require` works even when TMPDIR sits inside this `"type": "module"` repo.
const FAKE_CLI = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const sameGroup = spawn("sleep", ["300"], { stdio: "ignore" });
const ownSession = spawn("sleep", ["301"], { stdio: "ignore", detached: true });
writeFileSync(process.env.FAKE_CHILD_PID_FILE, sameGroup.pid + " " + ownSession.pid);
process.stdin.resume();
`;

// Finding a descendant that started its own session relies on /proc (the
// FORGE_AGENT_TREE env scan in src/process/procfs.ts), which is Linux-only.
const HAS_PROCFS = existsSync("/proc/self/environ");

describe.skipIf(process.platform === "win32")("agent process-group kill (FRG-4527)", () => {
  let dir: string;
  let pids: number[];
  let leaders: number[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-pgroup-"));
    writeFileSync(join(dir, "fake-claude.cjs"), FAKE_CLI);
    chmodSync(join(dir, "fake-claude.cjs"), 0o755);
    pids = [];
    leaders = [];
  });

  afterEach(() => {
    // A failed test must not leak its process tree.
    for (const pgid of leaders) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    for (const pid of pids) if (isRunning(pid)) process.kill(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  async function startFakeSession() {
    const pidFile = join(dir, "child.pid");
    const adapter = new ClaudeCodeAdapter({
      command: join(dir, "fake-claude.cjs"),
      model: "claude-sonnet-5",
      env: { ...process.env, FAKE_CHILD_PID_FILE: pidFile },
    });
    const handle = await adapter.startSession({ prompt: "hi", workspacePath: dir });
    if (handle.pid !== undefined) leaders.push(handle.pid);
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").includes(" "));
    pids = readFileSync(pidFile, "utf8").split(" ").map(Number);
    for (const pid of pids) expect(isRunning(pid)).toBe(true);
    return { adapter, handle };
  }

  /** Spawn `sh -c script` as a group leader; resolves once it printed the background pid. */
  async function startShell(script: string) {
    const leader = spawnProcessGroup("sh", ["-c", script], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (leader.pid !== undefined) leaders.push(leader.pid);
    let out = "";
    leader.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    await waitFor(() => out.includes("\n"));
    pids = [Number(out.trim())];
    return leader;
  }

  it.skipIf(!HAS_PROCFS)(
    "stopSession kills the CLI's descendants, including ones in their own session",
    async () => {
      const { adapter, handle } = await startFakeSession();
      await adapter.stopSession(handle);
      // stopSession resolves only once the whole tree is gone.
      for (const pid of pids) expect(isRunning(pid)).toBe(false);
      expect(handle.pid !== undefined && isRunning(handle.pid)).toBe(false);
    },
  );

  it.skipIf(!HAS_PROCFS)("an abort kills the CLI's descendants", async () => {
    const { handle } = await startFakeSession();
    handle.abortController.abort();
    await waitFor(() => pids.every((pid) => !isRunning(pid)), 2000);
  });

  it("escalates to SIGKILL when the leader ignores SIGTERM", async () => {
    // Ignored dispositions survive exec, so the background sleep ignores TERM too.
    const leader = await startShell('trap "" TERM; sleep 300 & echo $!; wait');
    await terminateChild(leader);
    expect(isRunning(pids[0] as number)).toBe(false);
  }, 15_000);

  it("SIGKILLs a descendant that ignores SIGTERM after the leader exited on it", async () => {
    const leader = await startShell('(trap "" TERM; exec sleep 300) & echo $!; wait');
    await terminateChild(leader);
    expect(isRunning(pids[0] as number)).toBe(false);
  }, 15_000);

  it.skipIf(!HAS_PROCFS)(
    "kills a new-session descendant reparented away from a leader that already exited",
    async () => {
      const leader = await startShell("setsid sleep 300 >/dev/null 2>&1 & echo $!");
      await waitFor(() => leader.exitCode !== null);
      expect(isRunning(pids[0] as number)).toBe(true);
      await terminateChild(leader);
      expect(isRunning(pids[0] as number)).toBe(false);
    },
  );

  it("a Kimi turn sweeps what the turn left running once it ends", async () => {
    const pidFile = join(dir, "kimi-child.pid");
    writeFileSync(
      join(dir, "fake-kimi"),
      `#!/bin/sh\nsetsid sleep 300 >/dev/null 2>&1 &\necho $! > "${pidFile}"\necho '{"role":"assistant","content":"ok"}'\n`,
    );
    chmodSync(join(dir, "fake-kimi"), 0o755);
    const adapter = new KimiAdapter({
      command: join(dir, "fake-kimi"),
      model: "kimi-k2",
      env: { PATH: process.env.PATH, KIMI_API_KEY: "k" },
    });
    const handle = await adapter.startSession({ prompt: "x", workspacePath: dir });
    for await (const _event of adapter.runTurn(handle, "go")) {
      // Drain the turn.
    }
    pids = [Number(readFileSync(pidFile, "utf8"))];
    expect(isRunning(pids[0] as number)).toBe(false);
  });

  it("kills descendants left behind by a leader that already exited", async () => {
    const leader = await startShell("sleep 300 & echo $!");
    await waitFor(() => leader.exitCode !== null);
    expect(isRunning(pids[0] as number)).toBe(true);
    await terminateChild(leader);
    expect(isRunning(pids[0] as number)).toBe(false);
  });
});

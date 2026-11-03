import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KILL_GRACE_MS,
  spawnProcessGroup,
  terminateChild,
} from "../../../src/process/process-tree.js";
import { AGENT_TREE_ENV, AGENT_WORKSPACE_ENV } from "../../../src/process/procfs.js";

/** A fake child that exits on SIGKILL only, or on SIGTERM when `obeysSigterm`. */
function fakeChild(obeysSigterm: boolean): any {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242 as number | undefined,
    exitCode: null as number | null,
    signalCode: null as string | null,
    killed: false,
    kill: vi.fn((signal: string) => {
      child.killed = true;
      if (signal === "SIGKILL" || obeysSigterm) {
        child.signalCode = signal;
        child.emit("exit", null, signal);
      }
      return true;
    }),
  });
  return child;
}

describe("terminateChild (FRG-4086)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves on SIGTERM without escalating", async () => {
    vi.useFakeTimers();
    const child = fakeChild(true);
    await terminateChild(child);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("escalates to SIGKILL and resolves only once the process exits", async () => {
    vi.useFakeTimers();
    const child = fakeChild(false);
    let done = false;
    const exiting = terminateChild(child).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await exiting;
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
  });

  it("shares one termination between callers (abort listener + stopSession)", async () => {
    const child = fakeChild(true);
    const first = terminateChild(child);
    expect(terminateChild(child)).toBe(first);
    await first;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("does not signal a child that never spawned (no pid)", async () => {
    const child = fakeChild(true);
    child.pid = undefined;
    await terminateChild(child);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does nothing for a process that already exited", async () => {
    const child = fakeChild(true);
    child.exitCode = 0;
    await terminateChild(child);
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === "win32")("spawnProcessGroup markers (FRG-5427)", () => {
  /** The tree and workspace markers the spawned child sees. */
  async function childMarkers(workspace?: string): Promise<string[]> {
    const child = spawnProcessGroup(
      "sh",
      ["-c", `printf '%s|%s' "$${AGENT_TREE_ENV}" "$${AGENT_WORKSPACE_ENV}"`],
      {
        cwd: tmpdir(),
        env: { ...process.env, [AGENT_WORKSPACE_ENV]: "/outer/agent/workspace" },
        stdio: ["ignore", "pipe", "ignore"],
      },
      { workspace },
    );
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    await new Promise((settle) => child.on("close", settle));
    return out.split("|");
  }

  it("marks the tree but not the workspace by default, dropping an inherited one", async () => {
    const [tree, workspace] = await childMarkers();
    expect(tree).toMatch(/^[0-9a-f-]{36}$/);
    expect(workspace).toBe("");
  });

  it("marks an agent session's workspace (it holds the dispatch lock)", async () => {
    const [, workspace] = await childMarkers(tmpdir());
    expect(workspace).toBe(resolve(tmpdir()));
  });
});

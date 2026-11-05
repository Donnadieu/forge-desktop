import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cardOf,
  type ListedProcess,
  listProcesses,
  parseLsof,
  pickLeftovers,
  selfAndAncestors,
} from "../../../src/process/leftovers.js";
import { stopLeftoverServers } from "../../../src/workspace/leftover-sweep.js";
import { workspaceLockPath } from "../../../src/workspace/lock.js";

const ROOT = "/Users/me/Library/Application Support/Forge/workspaces";

const proc = (pid: number, ppid: number, cwd: string, extra: Partial<ListedProcess> = {}) => ({
  pid,
  ppid,
  command: `cmd${pid}`,
  cwd,
  terminal: false,
  ...extra,
});

describe("parseLsof", () => {
  it("reads pid, parent, command, cwd with spaces, and a terminal on stdin", () => {
    const out = [
      "p2121",
      "R1",
      "cruby",
      "fcwd",
      `n${ROOT}/BC-1`,
      "f0",
      "n/dev/null",
      "f1",
      "n/private/tmp/smoke-rails.log",
      "p3000",
      "R2999",
      "czsh",
      "fcwd",
      `n${ROOT}/BC-2`,
      "f0",
      "n/dev/ttys003",
      "",
    ].join("\n");
    expect(parseLsof(out)).toEqual([
      { pid: 2121, ppid: 1, command: "ruby", cwd: `${ROOT}/BC-1`, terminal: false },
      { pid: 3000, ppid: 2999, command: "zsh", cwd: `${ROOT}/BC-2`, terminal: true },
    ]);
  });

  it("ignores junk and pid 1", () => {
    expect(parseLsof("garbage\nn/x\np1\nR0\nfcwd\nn/\n")).toEqual([]);
  });
});

describe("cardOf", () => {
  it("names the card folder a cwd sits in, at any depth", () => {
    expect(cardOf(`${ROOT}/BC-1`, [ROOT])).toBe("BC-1");
    expect(cardOf(`${ROOT}/BC-1/app/frontend`, [ROOT])).toBe("BC-1");
  });

  it("is undefined outside the root, at the root, in a lookalike root or a hidden entry", () => {
    expect(cardOf("/Users/me/conductor/workspaces/andela/x", [ROOT])).toBeUndefined();
    expect(cardOf(ROOT, [ROOT])).toBeUndefined();
    expect(cardOf(`${ROOT}-old/BC-1`, [ROOT])).toBeUndefined();
    expect(cardOf(`${ROOT}/.BC-1.forge-lock.reclaiming`, [ROOT])).toBeUndefined();
  });
});

describe("pickLeftovers", () => {
  const protect = new Set([500, 400]);

  it("picks detached processes in card folders and their children, nothing else", () => {
    const rows = [
      proc(10, 1, `${ROOT}/BC-1`), // puma left by a run: detached
      proc(11, 10, `${ROOT}/BC-1`), // its worker
      proc(12, 1, `${ROOT}/BC-2/app/frontend`), // bunx vite
      proc(13, 12, "/private/tmp"), // vite's esbuild, cwd elsewhere: still its child
      proc(20, 900, `${ROOT}/BC-1`), // an editor's language server: has a live parent
      proc(21, 1, `${ROOT}/BC-1`, { terminal: true }), // a shell the person opened there
      proc(22, 1, "/Users/me/conductor/workspaces/andela/kingstown"), // Conductor's vite
      proc(23, 1, "/Users/me/Library/Application Support/One"), // One
      proc(500, 1, `${ROOT}/BC-3`), // the engine itself (protected)
    ];
    const picked = pickLeftovers(rows, { root: ROOT, protect });
    expect(picked.map((l) => [l.pid, l.card])).toEqual([
      [10, "BC-1"],
      [12, "BC-2"],
      [11, "BC-1"],
      [13, "BC-2"],
    ]);
  });

  it("leaves cards to keep alone, and limits to one card with only", () => {
    const rows = [proc(10, 1, `${ROOT}/BC-1`), proc(12, 1, `${ROOT}/BC-2`)];
    expect(
      pickLeftovers(rows, { root: ROOT, protect, keep: (c) => c === "BC-1" }).map((l) => l.pid),
    ).toEqual([12]);
    expect(pickLeftovers(rows, { root: ROOT, protect, only: "BC-1" }).map((l) => l.pid)).toEqual([
      10,
    ]);
  });

  it("never picks this process or its ancestors", () => {
    const rows = [proc(process.pid, 1, `${ROOT}/BC-1`)];
    expect(pickLeftovers(rows, { root: ROOT })).toEqual([]);
    expect(selfAndAncestors([proc(5, 4, "/"), proc(4, 1, "/")], 5)).toEqual(new Set([5, 4]));
  });
});

// A real orphan: macOS hands it to launchd (pid 1). Linux may hand it to a subreaper instead.
describe.skipIf(process.platform !== "darwin")("leftover sweep on real processes (macOS)", () => {
  let base: string;
  let root: string;
  const pids: number[] = [];

  /** Start `sleep` detached from this test (parent becomes launchd) with its cwd in `dir`. */
  async function orphanIn(dir: string): Promise<number> {
    mkdirSync(dir, { recursive: true });
    const pidFile = join(base, `pid-${pids.length}`);
    const sh = spawn(
      "/bin/sh",
      ["-c", `cd "$1" && (sleep 300 >/dev/null 2>&1 & echo $! > "$2")`, "sh", dir, pidFile],
      {
        stdio: "ignore",
      },
    );
    await once(sh, "exit");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    pids.push(pid);
    return pid;
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "forge-leftovers-")));
    root = join(base, "workspaces");
    mkdirSync(root);
  });

  afterEach(() => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(base, { recursive: true, force: true });
  });

  it("lists an orphan with its cwd and launchd as parent", async () => {
    const pid = await orphanIn(join(root, "BC-1"));
    const row = (await listProcesses()).find((r) => r.pid === pid);
    expect(row).toMatchObject({ ppid: 1, cwd: join(root, "BC-1"), terminal: false });
  });

  it("stops leftovers of cards no run holds, keeps a card a live run holds and anything outside the root", async () => {
    const stale = await orphanIn(join(root, "BC-1", "app", "frontend"));
    const held = await orphanIn(join(root, "BC-2"));
    const outside = await orphanIn(join(base, "workspaces-other", "BC-1"));
    // BC-2's lock is held by a live process (this test's own child stands in for an engine).
    const engine = spawn("sleep", ["300"], { stdio: "ignore" });
    pids.push(engine.pid as number);
    writeFileSync(
      workspaceLockPath(join(root, "BC-2")),
      JSON.stringify({
        pid: engine.pid,
        token: "other-engine",
        startedAt: new Date().toISOString(),
      }),
    );

    const stopped = await stopLeftoverServers(root, { graceMs: 3000 });

    expect(stopped.map((l) => [l.pid, l.card])).toEqual([[stale, "BC-1"]]);
    expect(alive(stale)).toBe(false);
    expect(alive(held)).toBe(true);
    expect(alive(outside)).toBe(true);

    // The card's own run, holding the lock, stops it at the start or end of the run.
    const own = await stopLeftoverServers(root, { only: "BC-2", graceMs: 3000 });
    expect(own.map((l) => l.pid)).toEqual([held]);
    expect(alive(held)).toBe(false);
    expect(alive(outside)).toBe(true);
  }, 30_000);
});

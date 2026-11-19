import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  pickLeftoverEngines,
  replaceLeftoverEngines,
} from "../../../src/process/engine-takeover.js";
import type { ListedProcess } from "../../../src/process/leftovers.js";

const HOME = "/Users/x/Library/Application Support/Forge/projects/p1";

function proc(pid: number, ppid: number, cwd: string, extra: Partial<ListedProcess> = {}) {
  return { pid, ppid, command: "node", cwd, terminal: false, ...extra };
}

describe("pickLeftoverEngines", () => {
  it("picks an engine of the same folder whose app is gone (launchd is its parent)", () => {
    expect(pickLeftoverEngines([proc(10, 1, HOME)], HOME).map((r) => r.pid)).toEqual([10]);
  });

  it("leaves alone engines of other folders, card folders, live apps' engines, terminals, other programs and itself", () => {
    const rows = [
      proc(11, 1, `${HOME}-2`),
      proc(12, 1, `${HOME}/workspaces/BC-1`),
      proc(13, 4242, HOME),
      proc(14, 1, HOME, { terminal: true }),
      proc(15, 1, HOME, { command: "ruby" }),
      proc(process.pid, 1, HOME),
    ];
    expect(pickLeftoverEngines(rows, HOME)).toEqual([]);
  });
});

// A real orphan: macOS hands it to launchd (pid 1).
describe.skipIf(process.platform !== "darwin")(
  "replaceLeftoverEngines on real processes (macOS)",
  () => {
    let base: string;
    let home: string;
    const pids: number[] = [];

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    /** A detached `node` in `home` standing in for an old engine; `onTerm` runs on SIGTERM. */
    async function leftoverEngine(onTerm: string): Promise<number> {
      const pidFile = join(base, `pid-${pids.length}`);
      const script = `process.on("SIGTERM", () => { ${onTerm} }); setInterval(() => {}, 1e6);`;
      const sh = spawn(
        "/bin/sh",
        [
          "-c",
          `cd "$1" && ("$2" -e "$3" >/dev/null 2>&1 & echo $! > "$4")`,
          "sh",
          home,
          process.execPath,
          script,
          pidFile,
        ],
        { stdio: "ignore" },
      );
      await once(sh, "exit");
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      pids.push(pid);
      // Wait until lsof sees it in its folder.
      await new Promise((r) => setTimeout(r, 300));
      return pid;
    }

    beforeEach(() => {
      base = realpathSync(mkdtempSync(join(tmpdir(), "forge-takeover-")));
      home = join(base, "projects", "p1");
      mkdirSync(home, { recursive: true });
    });

    afterEach(() => {
      for (const pid of pids.splice(0)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      rmSync(base, { recursive: true, force: true });
    });

    it("asks a leftover engine to stop (it drains) and waits until it's gone", async () => {
      const drained = join(base, "drained");
      const pid = await leftoverEngine(
        `require("node:fs").writeFileSync(${JSON.stringify(drained)}, "1"); setTimeout(() => process.exit(0), 300);`,
      );
      const replaced = await replaceLeftoverEngines(home, { graceMs: 5000 });
      expect(replaced).toEqual([pid]);
      expect(alive(pid)).toBe(false);
      expect(existsSync(drained)).toBe(true);
    }, 20_000);

    it("kills a leftover that doesn't stop within the grace window", async () => {
      const pid = await leftoverEngine("/* ignores SIGTERM */");
      const t0 = Date.now();
      expect(await replaceLeftoverEngines(home, { graceMs: 500 })).toEqual([pid]);
      expect(alive(pid)).toBe(false);
      expect(Date.now() - t0).toBeLessThan(5000);
    }, 20_000);

    it("finds nothing to replace in a folder no other engine uses", async () => {
      expect(await replaceLeftoverEngines(home, { graceMs: 500 })).toEqual([]);
    });
  },
);

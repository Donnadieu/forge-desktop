/**
 * The engine's lifecycle with the app, on real processes: a stand-in app (a small node script) starts the real engine
 * the way Forge does (FORGE_APP_PID, cwd = the engine's folder, stdout piped) and is then killed with SIGKILL, as a
 * crash or a force quit does. macOS only: an orphan goes to launchd (pid 1) there.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listProcesses } from "../../../src/process/leftovers.js";

const ENTRY = resolve(fileURLToPath(new URL("../../../src/index.ts", import.meta.url)));
// tsx's ESM loader, as a URL `node --import` takes from any folder.
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

const APP = `
import { spawn } from "node:child_process";
const [node, tsx, entry, home, mode, withPid] = process.argv.slice(2);
const env = { ...process.env, FORGE_HOME: home, FORGE_ENGINE_HOME: home, FORGE_API_TOKEN: "t".repeat(64),
  FORGE_LOG_FILE: home + "/engine.log", LINEAR_API_KEY: "not-a-key", FORGE_DRAIN_MS: "3000" };
delete env.FORGE_APP_PID; delete env.FORGE_ENGINE_MODE; delete env.NODE_ENV; delete env.VITEST;
if (withPid === "1") env.FORGE_APP_PID = String(process.pid);
if (mode === "sessions") env.FORGE_ENGINE_MODE = "sessions";
const e = spawn(node, ["--disable-warning=ExperimentalWarning", "--import", tsx, entry],
  { cwd: home, env, stdio: ["ignore", "pipe", "ignore"] });
let out = "";
e.stdout.on("data", (d) => { out += d; if (out.includes("FORGE_ENGINE_READY")) { process.stdout.write("READY " + e.pid + "\\n"); out = ""; } });
e.on("exit", (code) => process.stdout.write("EXIT " + code + "\\n"));
setInterval(() => {}, 1e6);
`;

const WORKFLOW = (home: string) => `---
tracker:
  kind: linear
  project_slug: lifecycle-test
  endpoint: http://127.0.0.1:9/graphql
workspace:
  root: ${home}/workspaces
polling:
  interval_ms: 60000
---
Lifecycle test for {{ issue.identifier }}
`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(ok: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return ok();
}

describe.skipIf(process.platform !== "darwin")(
  "the engine's lifecycle with the app (macOS)",
  () => {
    let base: string;
    let appScript: string;
    const apps: ChildProcess[] = [];
    const engines: number[] = [];

    beforeEach(() => {
      base = realpathSync(mkdtempSync(join(tmpdir(), "forge-lifecycle-")));
      appScript = join(base, "app.mjs");
      writeFileSync(appScript, APP);
    });

    afterEach(() => {
      for (const a of apps.splice(0)) a.kill("SIGKILL");
      for (const pid of engines.splice(0)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      rmSync(base, { recursive: true, force: true });
    });

    function folder(name: string, mode: "board" | "sessions"): string {
      const home = join(base, name);
      mkdirSync(home, { recursive: true });
      if (mode === "board") writeFileSync(join(home, "WORKFLOW.md"), WORKFLOW(home));
      return home;
    }

    /** Starts a stand-in app that starts an engine in `home`; resolves with both once the engine is ready. */
    async function startApp(home: string, mode: "board" | "sessions", withAppPid: boolean) {
      const app = spawn(
        process.execPath,
        [appScript, process.execPath, TSX, ENTRY, home, mode, withAppPid ? "1" : "0"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      apps.push(app);
      const engine = await new Promise<number>((done, fail) => {
        let out = "";
        const t = setTimeout(() => fail(new Error(`engine not ready: ${out}`)), 20_000);
        app.stdout?.on("data", (d) => {
          out += d;
          const m = /READY (\d+)/.exec(out);
          if (m) {
            clearTimeout(t);
            done(Number(m[1]));
          }
        });
      });
      engines.push(engine);
      return { app, engine };
    }

    /** A dev server an agent left running detached in `dir` (its parent is launchd). */
    async function devServerIn(dir: string): Promise<number> {
      mkdirSync(dir, { recursive: true });
      const pidFile = join(base, `server-${engines.length}-${Date.now()}`);
      const sh = spawn(
        "/bin/sh",
        ["-c", `cd "$1" && (sleep 300 >/dev/null 2>&1 & echo $! > "$2")`, "sh", dir, pidFile],
        { stdio: "ignore" },
      );
      await new Promise((r) => sh.on("exit", r));
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      engines.push(pid);
      return pid;
    }

    async function killApp(app: ChildProcess): Promise<void> {
      app.kill("SIGKILL");
      await until(() => app.exitCode !== null || app.signalCode !== null, 3000);
    }

    for (const mode of ["board", "sessions"] as const) {
      it(`a ${mode} engine and the dev servers its agents left stop by themselves within seconds once the app is killed (kill -9)`, async () => {
        const home = folder(`kill-${mode}`, mode);
        const { app, engine } = await startApp(home, mode, true);
        expect(alive(engine)).toBe(true);
        const server = await devServerIn(
          mode === "board"
            ? join(home, "workspaces", "BC-1", "app")
            : join(home, "folders", "o-r", "s1"),
        );
        await killApp(app);
        const t0 = Date.now();
        expect(await until(() => !alive(engine), 5000)).toBe(true);
        expect(Date.now() - t0).toBeLessThan(5000);
        expect(alive(server)).toBe(false);
        // It stopped the normal way (its agents get the drain), not by a kill.
        expect(readFileSync(join(home, "engine.log"), "utf8")).toMatch(/stopping/);
      }, 40_000);
    }

    it("a relaunch replaces a leftover engine of the same folder before it's ready: never two engines", async () => {
      const home = folder("relaunch", "board");
      // An app from before FORGE_APP_PID: its engine keeps running after the app is killed.
      const old = await startApp(home, "board", false);
      await killApp(old.app);
      await new Promise((r) => setTimeout(r, 1500));
      expect(alive(old.engine)).toBe(true);

      const next = await startApp(home, "board", true);
      expect(next.engine).not.toBe(old.engine);
      expect(alive(old.engine)).toBe(false);
      const inFolder = (await listProcesses()).filter((r) => r.cwd === home && alive(r.pid));
      expect(inFolder.map((r) => r.pid)).toEqual([next.engine]);
      // The leftover drained (SIGTERM) before it went.
      const log = readFileSync(join(home, "engine.log"), "utf8");
      expect(log).toMatch(new RegExp(`"pid":${old.engine},[^\\n]*"Forge engine stopping"`));
    }, 60_000);
  },
);

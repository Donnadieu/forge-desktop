/**
 * Workspace setup for sessions (Omar, Nov 12 2026; docs/design/workspace-settings.md): the files git ignores that
 * every new session's folder gets from the person's checkout, a setup script run there when the session starts,
 * a cleanup script run when it's archived, and the variables every agent and script of the workspace gets.
 *
 * The app tells the host each workspace's setup on every connect and on Save; the host keeps it in memory only, so
 * a secret value never reaches a file. Anything kept from a script's output has the secret values masked.
 *
 * New in Forge Desktop.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

export const SECRET_MASK = "••••••••";
/** What's kept of a script's output: its last 20,000 characters. */
const OUTPUT_LIMIT = 20_000;

export interface WorkspaceSetup {
  copy: string[];
  setup: string;
  cleanup: string;
  env: Record<string, string>;
  /** Keys of `env` whose values are secret. */
  secrets: string[];
}

export interface ScriptRun {
  state: "running" | "done" | "failed";
  exitCode: number | null;
  output: string;
  startedAt: string;
  endedAt: string | null;
}

export const NO_SETUP: WorkspaceSetup = { copy: [], setup: "", cleanup: "", env: {}, secrets: [] };

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The app's body, checked: lists of strings, keys a shell takes (never Forge's own `FORGE_`). */
export function parseSetup(b: unknown): WorkspaceSetup {
  const o = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  const env: Record<string, string> = {};
  if (o.env && typeof o.env === "object")
    for (const [k, v] of Object.entries(o.env as Record<string, unknown>))
      if (KEY.test(k) && !k.toUpperCase().startsWith("FORGE_") && typeof v === "string") env[k] = v;
  return {
    copy: strings(o.copy).map((p) => p.trim()),
    setup: typeof o.setup === "string" ? o.setup : "",
    cleanup: typeof o.cleanup === "string" ? o.cleanup : "",
    env,
    secrets: strings(o.secrets).filter((k) => k in env),
  };
}

/** Every secret value in `text` replaced by the mask (longest first, so one value inside another still goes). */
export function maskSecrets(text: string, s: WorkspaceSetup): string {
  const values = s.secrets
    .map((k) => s.env[k] ?? "")
    .filter((v) => v.length >= 3)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of values) out = out.split(v).join(SECRET_MASK);
  return out;
}

/**
 * Copies each listed path from the checkout into the session's folder: a file or a whole folder (`dir/`), only
 * inside the checkout, and never over a file the branch already has (that one is the repo's, not the person's).
 */
export function copyFiles(
  from: string,
  to: string,
  paths: string[],
): { copied: string[]; skipped: string[] } {
  const copied: string[] = [];
  const skipped: string[] = [];
  const root = realpathSync(from);
  for (const p of paths) {
    const rel = normalize(p.replace(/\/+$/, ""));
    const src = join(root, rel);
    const inside = !isAbsolute(p) && !rel.startsWith("..") && rel !== "." && rel !== "";
    if (!inside || !existsSync(src) || !realpathSync(src).startsWith(root + sep)) {
      skipped.push(p);
      continue;
    }
    const dest = join(to, rel);
    if (relative(to, dest).startsWith("..")) {
      skipped.push(p);
      continue;
    }
    try {
      if (lstatSync(src).isDirectory()) {
        cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
      } else if (!existsSync(dest)) {
        cpSync(src, dest);
      } else {
        skipped.push(p);
        continue;
      }
      copied.push(p);
    } catch {
      skipped.push(p);
    }
  }
  return { copied, skipped };
}

/**
 * Runs a script in `cwd` with the person's login shell (their PATH and tools), `env` as its environment. Calls
 * `onOutput` with everything printed so far (stdout and stderr together, masked) as it comes. Gives up after
 * `timeoutMs`. Never throws.
 */
export function runScript(
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  mask: (text: string) => string,
  onOutput: (output: string) => void,
  timeoutMs = 15 * 60_000,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL?.startsWith("/") ? process.env.SHELL : "/bin/sh";
    let output = "";
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const add = (chunk: Buffer | string) => {
      output = (output + chunk.toString()).slice(-OUTPUT_LIMIT * 2);
      onOutput(mask(output).slice(-OUTPUT_LIMIT));
    };
    const finish = (code: number, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (extra) add(extra);
      resolve({ code, output: mask(output).slice(-OUTPUT_LIMIT) });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ["-lc", script], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      resolve({ code: 127, output: mask(String(err)) });
      return;
    }
    timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      finish(124, `\nStopped after ${Math.round(timeoutMs / 60_000)} minutes.\n`);
    }, timeoutMs);
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    child.on("error", (err) => finish(127, `\n${String(err)}\n`));
    child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
  });
}

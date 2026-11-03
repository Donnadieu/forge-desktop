/**
 * The macOS process table, for the same questions `procfs.ts` answers from
 * Linux `/proc`: which pids exist, each one's parent, group, state and start
 * time, and which processes carry an environment marker. macOS has no `/proc`,
 * so this reads `ps` (and `sysctl` for the boot time), cached briefly because
 * callers ask about many pids in a row.
 *
 * New in Forge Desktop (Forge reads Linux `/proc` only). Every read degrades to
 * "unknown" (`undefined` / empty) when `ps` can't run, like `procfs.ts`.
 */
import { execFileSync } from "node:child_process";

export interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** `ps` STAT, e.g. `S+`, `Z`: the first letter is the state. */
  stat: string;
  /** Start time as `ps` prints it (`lstart`); with the pid it tells a process from a pid reuser. */
  started: string;
}

const CACHE_MS = 250;
let cached: { at: number; rows: Map<number, PsRow> } | undefined;

function run(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/** Parses `ps -axo pid=,ppid=,pgid=,stat=,lstart=` output. */
export function parsePsTable(out: string): Map<number, PsRow> {
  const rows = new Map<number, PsRow>();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    rows.set(pid, {
      pid,
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      stat: m[4] ?? "",
      started: (m[5] ?? "").trim(),
    });
  }
  return rows;
}

/** Every process, from a snapshot at most {@link CACHE_MS} old. Empty when `ps` can't run. */
export function psTable(): Map<number, PsRow> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.rows;
  const out = run("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="]);
  const rows = out === undefined ? new Map<number, PsRow>() : parsePsTable(out);
  cached = { at: now, rows };
  return rows;
}

/** Forget the snapshot (a caller that just started or killed processes wants fresh rows). */
export function forgetPsTable(): void {
  cached = undefined;
}

/**
 * Parses `ps -axEww -o pid=,command=` output: pids whose line carries
 * `name=value` as a whole word. `ps -E` appends the environment after the
 * command, space separated, for processes of the same user.
 */
export function parsePidsWithEnv(out: string, name: string, value: string): number[] {
  const entry = `${name}=${value}`;
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const words = (m[2] ?? "").split(/\s+/);
    if (words.includes(entry)) pids.push(Number(m[1]));
  }
  return pids;
}

export function psPidsWithEnv(name: string, value: string): number[] {
  const out = run("ps", ["-axEww", "-o", "pid=,command="]);
  return out === undefined ? [] : parsePidsWithEnv(out, name, value);
}

/** Parses `ps -axo pid=,uid=,ruid=,svuid=,stat=`: live pids whose real, effective or saved uid is `uid`. */
export function parsePidsOfUid(out: string, uid: number): number[] {
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    if ((f[4] ?? "").startsWith("Z")) continue;
    if ([f[1], f[2], f[3]].map(Number).includes(uid)) pids.push(Number(f[0]));
  }
  return pids;
}

export function psPidsOfUid(uid: number): number[] {
  const out = run("ps", ["-axo", "pid=,uid=,ruid=,svuid=,stat="]);
  return out === undefined ? [] : parsePidsOfUid(out, uid);
}

/** Boot time in seconds from `sysctl kern.boottime`: a process recorded under another boot is gone. */
export function parseBootTime(out: string): string | undefined {
  return out.match(/sec\s*=\s*(\d+)/)?.[1];
}

export function macBootId(): string | undefined {
  const out = run("sysctl", ["-n", "kern.boottime"]);
  return out === undefined ? undefined : parseBootTime(out);
}

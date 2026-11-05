/**
 * Leftover processes in card workspaces: dev servers, preview servers and
 * watchers an agent started in the background (`(bin/rails server &)`,
 * `nohup vite &`) that outlive the agent. The process-tree kill finds a tree
 * by its environment marker, but a detached server leaves the agent's process
 * group, and Ruby's `$0 =` (puma's title) wipes the environment `ps -E`
 * reads, so these survived for hours (46 at once on one Mac, ~1.6 GB).
 *
 * They are found by working folder instead: `lsof` lists each process's cwd.
 * A process counts as a card's leftover only when ALL hold:
 *   - its cwd is inside `<workspace root>/<card>/`;
 *   - it is detached: its parent is launchd/init (pid 1), or it descends
 *     from such a process — an editor or terminal the person opened in the
 *     folder keeps its own parent and is never touched;
 *   - it has no terminal on stdin/stdout/stderr (the person's own shells do);
 *   - it is not this engine or one of its ancestors.
 *
 * New in Forge Desktop. Everything degrades to "nothing found" when `lsof`
 * can't run.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** One process as `lsof` reports it. */
export interface ListedProcess {
  pid: number;
  ppid: number;
  /** Command name (short, for logs). */
  command: string;
  /** Working folder; empty when unknown. */
  cwd: string;
  /** Whether stdin, stdout or stderr is a terminal. */
  terminal: boolean;
}

/** A leftover process and the card folder it belongs to. */
export interface Leftover extends ListedProcess {
  card: string;
}

const TERMINAL = /^\/dev\/(tty|pts\/)/;
const STD_FDS = new Set(["0", "1", "2"]);

/**
 * Parses `lsof -F pRcfn` output: a `p` line starts each process (then `R`
 * parent, `c` command), and each open file is an `f` line (fd) followed by
 * its `n` line (name).
 */
export function parseLsof(out: string): ListedProcess[] {
  const rows: ListedProcess[] = [];
  let row: ListedProcess | undefined;
  let fd = "";
  for (const line of out.split("\n")) {
    const tag = line.charAt(0);
    const value = line.slice(1);
    if (tag === "p") {
      row = { pid: Number(value), ppid: 0, command: "", cwd: "", terminal: false };
      rows.push(row);
      continue;
    }
    if (!row) continue;
    if (tag === "R") row.ppid = Number(value);
    else if (tag === "c") row.command = value;
    else if (tag === "f") fd = value;
    else if (tag === "n" && fd === "cwd") row.cwd = value;
    else if (tag === "n" && STD_FDS.has(fd) && TERMINAL.test(value)) row.terminal = true;
  }
  return rows.filter((r) => Number.isInteger(r.pid) && r.pid > 1);
}

const LSOF = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";

/** This user's processes with their cwd and terminal; empty when `lsof` can't run. */
export function listProcesses(): Promise<ListedProcess[]> {
  const uid = process.getuid?.();
  if (uid === undefined) return Promise.resolve([]);
  const args = ["-nP", "-w", "-u", String(uid), "-a", "-d", "cwd,0,1,2", "-F", "pRcfn"];
  return new Promise((done) => {
    // lsof exits 1 when some process vanished mid-scan; its output is still good.
    execFile(LSOF, args, { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }, (_err, stdout) =>
      done(parseLsof(String(stdout ?? ""))),
    );
  });
}

/** The root as given and with symlinks resolved (`lsof` reports real paths: /private/var). */
function rootForms(root: string): string[] {
  const forms = new Set([resolve(root)]);
  try {
    forms.add(realpathSync(root));
  } catch {
    // Root gone: its processes still report the old path.
  }
  return [...forms];
}

/** The card folder name `cwd` sits in under one of `roots`, if any. */
export function cardOf(cwd: string, roots: string[]): string | undefined {
  for (const root of roots) {
    if (!cwd.startsWith(root + sep)) continue;
    const card = cwd.slice(root.length + 1).split(sep)[0];
    if (card && !card.startsWith(".")) return card;
  }
  return undefined;
}

/** `pid` and its ancestors by parent link. */
export function selfAndAncestors(rows: ListedProcess[], pid = process.pid): Set<number> {
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  const chain = new Set<number>();
  for (let p: number | undefined = pid; p !== undefined && p > 1 && !chain.has(p); ) {
    chain.add(p);
    p = parent.get(p);
  }
  return chain;
}

export interface PickOptions {
  /** The engine's workspace root. */
  root: string;
  /** Cards to leave alone (an agent runs there now). */
  keep?: (card: string) => boolean;
  /** Only this card. */
  only?: string;
  /** Never these pids (defaults to this process and its ancestors). */
  protect?: Set<number>;
}

/** Which of `rows` are leftovers (see the file comment for the rules). */
export function pickLeftovers(rows: ListedProcess[], options: PickOptions): Leftover[] {
  const roots = rootForms(options.root);
  const protect = options.protect ?? selfAndAncestors(rows);
  const eligible = (r: ListedProcess) => !protect.has(r.pid) && !r.terminal;
  const found = new Map<number, Leftover>();
  for (const r of rows) {
    const card = cardOf(r.cwd, roots);
    if (!card || r.ppid !== 1 || !eligible(r)) continue;
    if (options.only !== undefined && card !== options.only) continue;
    if (options.keep?.(card)) continue;
    found.set(r.pid, { ...r, card });
  }
  // Children of a leftover belong to it, wherever their cwd is.
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      const parent = found.get(r.ppid);
      if (!parent || found.has(r.pid) || !eligible(r)) continue;
      found.set(r.pid, { ...r, card: parent.card });
      grew = true;
    }
  }
  return [...found.values()];
}

export interface StopResult {
  stopped: Leftover[];
  /** Still running after SIGKILL (e.g. EPERM). */
  survivors: Leftover[];
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms).unref?.());

function send(pids: number[], sig: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {
      // ESRCH: already gone; EPERM: reported as a survivor.
    }
  }
}

/**
 * SIGTERM every leftover, give them `graceMs` to exit, then SIGKILL those
 * still running in the same folder (re-listed, so a reused pid is never
 * signalled), and report what is left.
 */
export async function stopLeftovers(
  leftovers: Leftover[],
  {
    graceMs = 5000,
    list = listProcesses,
  }: { graceMs?: number; list?: () => Promise<ListedProcess[]> } = {},
): Promise<StopResult> {
  if (leftovers.length === 0) return { stopped: [], survivors: [] };
  const same = (rows: ListedProcess[]) => {
    const now = new Map(rows.map((r) => [r.pid, r]));
    return leftovers.filter((l) => now.get(l.pid)?.cwd === l.cwd);
  };
  send(
    leftovers.map((l) => l.pid),
    "SIGTERM",
  );
  const deadline = Date.now() + graceMs;
  let alive = same(await list());
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(250);
    alive = same(await list());
  }
  send(
    alive.map((l) => l.pid),
    "SIGKILL",
  );
  if (alive.length > 0) await sleep(500);
  const survivors = alive.length > 0 ? same(await list()) : [];
  const left = new Set(survivors.map((s) => s.pid));
  return { stopped: leftovers.filter((l) => !left.has(l.pid)), survivors };
}

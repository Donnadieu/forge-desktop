import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Logger } from "pino";
import { type Dir, TreeWalk } from "./kimi-tree.js";
import type { AgentEvent } from "./types.js";

/** The usage-tracking slice of a Kimi session's state (structurally shared with SessionState). */
export interface UsageWireState {
  /** Absolute workspace path the CLI runs in — used to locate the session dir by `cwd`
   *  BEFORE the end-of-turn `session.resume_hint` arrives, so usage can stream live. */
  workspacePath: string;
  /** kimi-code session id captured from the `session.resume_hint` stdout line. */
  kimiSessionId: string | null;
  /** Resolved session dir `<wd_*>/<sessionId>`, relative to `$KIMI_CODE_HOME/sessions`;
   *  set once discoverable. Re-walked from the root on every flush (see kimi-tree.ts). */
  sessionDir: string | null;
  /** Bytes already consumed per agent wire.jsonl (offset-tracked, per file). */
  wireOffsets: Map<string, number>;
  /** Fail-loud latch — warn about a missing usage source only once per session. */
  contractWarned: boolean;
  /** The session's `KIMI_CODE_HOME` when it runs on a per-session env; unset → the process's. */
  kimiCodeHome?: string;
}

/**
 * Emit new `usage.record` lines as per-call usage events. Usage is NOT on stdout — it is
 * only persisted to per-agent wire.jsonl files under the session dir. kimi-code spawns
 * parallel sub-agents (`agents/main`, `agents/agent-0`, …) and EACH bills its own tokens,
 * so we sum usage across every agent's wire.jsonl, not just `main` (reading only `main`
 * under-counts multi-agent builds by the sub-agents' share — ~65% observed). Every file is
 * offset-tracked independently so each turn only emits the usage appended since the last.
 * Fresh input, cache-read, and cache-creation are reported separately so each is priced at
 * its own rate downstream (no dedup: the orchestrator sums per-call events).
 */
export function* flushUsage(state: UsageWireState, logger: Logger): Generator<AgentEvent> {
  // Collected before yielding, so the walk's fds never outlive this call.
  const walk = new TreeWalk();
  let events: AgentEvent[];
  try {
    events = collectUsage(state, logger, walk);
  } finally {
    walk.close();
  }
  yield* events;
}

function collectUsage(state: UsageWireState, logger: Logger, walk: TreeWalk): AgentEvent[] {
  const sessions = sessionsRoot(walk, state.kimiCodeHome);
  if (!state.sessionDir && sessions) {
    // Prefer resolving by cwd — the session dir (with state.json) exists from the start of the
    // turn, whereas the `session.resume_hint` id only arrives at the end. Resolving early lets
    // usage stream live while the turn runs. Fall back to the id once we have it.
    state.sessionDir =
      resolveSessionDirByCwd(walk, sessions, state.workspacePath) ??
      resolveSessionDir(walk, sessions, state.kimiSessionId);
    // Backfill the id from the dir name so later turns can `-r` resume even if the
    // resume_hint stdout line was missed.
    if (state.sessionDir && !state.kimiSessionId) state.kimiSessionId = basename(state.sessionDir);
  }
  if (!state.sessionDir) {
    // The turn ran but the session dir is unresolvable — cost telemetry will silently read $0.
    // Fail loud once so a kimi-code layout change is detectable rather than invisibly
    // under-billing. Only warn once the turn has an id (i.e. it actually reached the model).
    if (state.kimiSessionId && !state.contractWarned) {
      state.contractWarned = true;
      logger.warn(
        { kimiSessionId: state.kimiSessionId, kimiCodeHome: kimiHome(state.kimiCodeHome) },
        "kimi-code usage source (session dir) not found — usage/cost telemetry will report " +
          "zero. The kimi-code on-disk session layout may have changed.",
      );
    }
    return [];
  }

  const [wd, id] = state.sessionDir.split("/");
  const agents = sessions ? walkDir(walk, sessions, wd, id, "agents") : null;
  if (!agents) return [];
  const events: AgentEvent[] = [];
  for (const name of walk.subdirs(agents)) {
    const agent = walk.dir(agents, name);
    if (agent) flushWireFile(state, walk, agent, `${state.sessionDir}/${name}`, events);
    walk.release(agent);
  }
  return events;
}

/** Most bytes one flush reads from a wire.jsonl; the rest waits for the next flush. */
export const MAX_WIRE_READ = 16 * 1024 * 1024;

/** Append to `events` the usage.record lines added to one agent's wire.jsonl since its
 *  tracked offset (`key` names the agent across flushes; `agent` is this walk's handle). */
function flushWireFile(
  state: UsageWireState,
  walk: TreeWalk,
  agent: Dir,
  key: string,
  events: AgentEvent[],
): void {
  const offset = state.wireOffsets.get(key) ?? 0;
  // wire.jsonl is append-only, so read only the bytes appended since the last flush.
  const read = walk.file(agent, "wire.jsonl", offset, MAX_WIRE_READ);
  if (!read?.text) return; // missing/unreadable file, or nothing appended
  const chunk = read.text;
  // Only advance past the last complete line — a partial trailing record (if a flush ever
  // races an in-progress append) is left for the next flush instead of being consumed
  // mid-line and lost.
  const lastNewline = chunk.lastIndexOf("\n");
  if (lastNewline === -1) {
    // A full read with no newline is one oversize record, never a usage line: skip past it
    // so every later flush does not re-read the same bytes. Its tail fails to parse below.
    if (read.bytes === MAX_WIRE_READ) state.wireOffsets.set(key, offset + read.bytes);
    return;
  }
  const fresh = chunk.slice(0, lastNewline + 1);
  state.wireOffsets.set(key, offset + Buffer.byteLength(fresh, "utf-8"));

  for (const line of fresh.split("\n")) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown> | null;
    try {
      rec = JSON.parse(line) as Record<string, unknown> | null;
    } catch {
      continue;
    }
    // The agent writes this file, so a line may be any JSON (`null` included).
    if (rec?.type !== "usage.record") continue;
    const usage = rec.usage as
      | {
          inputOther?: number;
          output?: number;
          inputCacheRead?: number;
          inputCacheCreation?: number;
        }
      | undefined;
    if (!usage) continue;
    events.push({
      type: "usage",
      inputTokens: usage.inputOther || 0,
      outputTokens: usage.output || 0,
      cacheReadTokens: usage.inputCacheRead || 0,
      cacheWriteTokens: usage.inputCacheCreation || 0,
    });
  }
}

/** Locate the session dir by matching the workspace `cwd` recorded in each session's
 *  `state.json`. kimi-code creates `sessions/<wd_*>/<sessionId>/state.json` (with `cwd`) at
 *  the START of a turn — long before the end-of-turn `session.resume_hint` — so this resolves
 *  the usage source early enough to stream usage live. Picks the newest matching session that
 *  already has an `agents/` dir. */
function resolveSessionDirByCwd(
  walk: TreeWalk,
  sessions: Dir,
  workspacePath: string,
): string | null {
  if (!workspacePath) return null;
  let target = workspacePath;
  try {
    target = realpathSync(workspacePath);
  } catch {
    // workspace may not exist yet — compare against the raw path
  }
  let best: { dir: string; mtime: number } | null = null;
  for (const wdName of walk.subdirs(sessions)) {
    const wd = walk.dir(sessions, wdName);
    if (!wd) continue;
    for (const id of walk.subdirs(wd)) {
      const session = walk.dir(wd, id);
      if (!session) continue;
      const mtime = sessionMtimeForCwd(walk, session, target);
      walk.release(session);
      if (mtime !== null && (!best || mtime > best.mtime)) best = { dir: `${wdName}/${id}`, mtime };
    }
    walk.release(wd);
  }
  return best?.dir ?? null;
}

/** The mtime of `session`'s state.json when its `cwd` resolves to `target` and the session
 *  already has an `agents/` dir; null otherwise. */
function sessionMtimeForCwd(walk: TreeWalk, session: Dir, target: string): number | null {
  const stateFile = walk.file(session, "state.json", 0, MAX_STATE_READ);
  if (!stateFile) return null;
  let cwd: unknown;
  try {
    cwd = (JSON.parse(stateFile.text) as { cwd?: unknown }).cwd;
  } catch {
    return null;
  }
  if (typeof cwd !== "string" || !cwd) return null;
  let cwdReal = cwd;
  try {
    cwdReal = realpathSync(cwd);
  } catch {
    // keep raw cwd
  }
  if (cwdReal !== target) return null;
  const agents = walk.dir(session, "agents");
  walk.release(agents);
  return agents ? stateFile.mtimeMs : null;
}

/** `$KIMI_CODE_HOME` — the session's own when set, else the process's. */
function kimiHome(home?: string): string {
  return home || process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
}

/** `$KIMI_CODE_HOME/sessions` (kimi-code's per-session data root), or null when either
 *  is not a plain directory. */
function sessionsRoot(walk: TreeWalk, home?: string): Dir | null {
  const root = walk.root(kimiHome(home));
  return root && walk.dir(root, "sessions");
}

/** The plain directory reached from `dir` through each name in turn, or null. The
 *  intermediate directories are released; the caller owns the one returned. */
function walkDir(walk: TreeWalk, dir: Dir, ...names: (string | undefined)[]): Dir | null {
  let current: Dir = dir;
  for (const name of names) {
    const next: Dir | null = name === undefined ? null : walk.dir(current, name);
    if (current !== dir) walk.release(current);
    if (!next) return null;
    current = next;
  }
  return current;
}

/** Most bytes read from a session's state.json (it holds a few short fields). */
const MAX_STATE_READ = 1024 * 1024;

/** Locate the session dir `<wd_*>/<sessionId>` under `sessions` (which holds the
 *  per-agent wire.jsonl usage files under `agents/`). */
function resolveSessionDir(walk: TreeWalk, sessions: Dir, sessionId: string | null): string | null {
  // The id comes from the agent's stdout; walk.dir refuses one that is not a single name.
  if (!sessionId) return null;
  for (const wd of walk.subdirs(sessions)) {
    const agents = walkDir(walk, sessions, wd, sessionId, "agents");
    walk.release(agents);
    if (agents) return `${wd}/${sessionId}`;
  }
  return null;
}

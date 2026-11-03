import type { AgentAdapter, AgentEvent, SessionHandle } from "./types.js";

/** How long a stop mid-handshake waits for the handshake before releasing the caller. */
const HANDSHAKE_STOP_GRACE_MS = 10_000;

interface RunOnceParams {
  prompt: string;
  workspacePath: string;
  /** The session is stopped and the run rejected after this long. */
  timeoutMs: number;
  /** Cancels the session like the deadline does, rejecting with a "was cancelled" error. */
  signal?: AbortSignal;
  /** Bounds the wait for a pending handshake once stopped (default 10s). */
  handshakeGraceMs?: number;
}

/**
 * Run one agent turn to completion and return its text output.
 *
 * The single-turn counterpart of the worker runner's loop (worker/runner.ts),
 * with the same adapter dispatch: a persistent adapter with `runTurn` is
 * handshaken first and fed the prompt through `runTurn`; any other adapter
 * takes the prompt on `startSession` and is drained through `streamEvents`.
 * Rejects when the turn ends unsuccessfully, times out or is cancelled,
 * carrying the agent's error events so the caller can report why.
 *
 * A stop that lands mid-handshake aborts the signal passed to `startSession`
 * (an adapter honouring it kills its child and rejects), then waits up to
 * `handshakeGraceMs` for `startSession` to settle and stops the session before
 * rejecting, so the caller does not release its slot or working tree under a
 * live child. A handshake that outlasts the grace is stopped once it settles.
 */
export async function runAgentOnce(agent: AgentAdapter, params: RunOnceParams): Promise<string> {
  if (params.signal?.aborted) throw new Error(`${agent.name} session was cancelled`);
  const useRunTurn = agent.persistentSession && typeof agent.runTurn === "function";
  let handle: SessionHandle | null = null;
  let starting: Promise<SessionHandle> | undefined;
  let stopping: Promise<void> | undefined;
  // Every path stops the session through here, so it is stopped exactly once.
  const stopSession = (h: SessionHandle) => (stopping ??= agent.stopSession(h));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  // Handed to startSession, so a stop kills an adapter's child mid-handshake.
  const handshake = new AbortController();

  // The deadline (and a cancel) covers the handshake too (codex answers
  // JSON-RPC before the first turn), so it races the whole session rather than
  // just the drain.
  const deadline = new Promise<never>((_, reject) => {
    const stop = (reason: string) => {
      stopped = true;
      handshake.abort();
      handle?.abortController.abort();
      reject(new Error(`${agent.name} session ${reason}`));
    };
    timer = setTimeout(() => stop(`timed out after ${params.timeoutMs / 1000}s`), params.timeoutMs);
    onAbort = () => stop("was cancelled");
    params.signal?.addEventListener("abort", onAbort, { once: true });
  });

  const session = async (): Promise<string> => {
    starting = agent.startSession({
      prompt: useRunTurn ? "" : params.prompt,
      workspacePath: params.workspacePath,
      handshakeOnly: useRunTurn,
      signal: handshake.signal,
    });
    const started = await starting;
    handle = started;
    // Stopped (deadline or cancel) mid-handshake: stop it rather than run the turn.
    if (stopped) {
      await stopSession(started);
      return "";
    }
    const events =
      useRunTurn && agent.runTurn
        ? agent.runTurn(started, params.prompt)
        : agent.streamEvents(started);
    const { text, errors, success } = await drain(events);
    // A throw after the deadline fired is discarded by the race.
    if (!success) {
      const reason = errors.join("; ").slice(0, 2000) || "no error reported";
      throw new Error(`${agent.name} session failed: ${reason}`);
    }
    return text;
  };

  try {
    return await Promise.race([session(), deadline]);
  } finally {
    clearTimeout(timer);
    if (onAbort) params.signal?.removeEventListener("abort", onAbort);
    if (stopped && !handle && starting) await settleWithin(starting, params.handshakeGraceMs);
    if (handle) await stopSession(handle);
  }
}

/** Wait for `pending` to settle (either way), but no longer than `graceMs`. */
async function settleWithin(
  pending: Promise<unknown>,
  graceMs = HANDSHAKE_STOP_GRACE_MS,
): Promise<void> {
  let grace: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending.catch(() => {}),
      new Promise<void>((resolve) => (grace = setTimeout(resolve, graceMs))),
    ]);
  } finally {
    clearTimeout(grace);
  }
}

async function drain(
  events: AsyncIterable<AgentEvent>,
): Promise<{ text: string; errors: string[]; success: boolean }> {
  const text: string[] = [];
  const errors: string[] = [];
  let success = false;
  for await (const event of events) {
    if (event.type === "text") text.push(event.content);
    else if (event.type === "error") errors.push(event.message);
    else if (event.type === "done") {
      success = event.success;
      break;
    }
  }
  return { text: text.join(""), errors, success };
}

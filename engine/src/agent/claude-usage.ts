import type { AgentEvent } from "./types.js";

/** The four billed token classes, kept separate so each prices at its own rate. */
export interface UsageTuple {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Per-turn token-accounting state for the Claude adapter. `turnEmitted` is the
 * running total already streamed for the current turn; `lastCallSnapshot`
 * collapses the repeated `assistant` lines the CLI emits for a single LLM call.
 *
 * Invariant: every turn enters through `streamEvents`, which calls
 * `resetTurnUsage` before consuming any line, so both fields start each turn at
 * zero. A turn that streams without resetting would carry usage across turns and
 * double-count — any future turn-entry path must preserve that reset.
 */
export interface UsageAccountingState {
  turnEmitted: UsageTuple;
  lastCallSnapshot: UsageTuple | null;
}

export function newUsageState(): UsageAccountingState {
  return { turnEmitted: zero(), lastCallSnapshot: null };
}

export function resetTurnUsage(state: UsageAccountingState): void {
  state.turnEmitted = zero();
  state.lastCallSnapshot = null;
}

/**
 * Per-turn token accounting. The Claude CLI reports usage in two shapes:
 * `assistant` lines carry accurate input/cache but only a *partial*
 * `output_tokens` snapshot, and the authoritative, fully-summed per-turn total
 * appears only on the terminal `result` line. We stream the per-call
 * `assistant` figures live so the orchestrator's counter climbs while the model
 * works, then emit a *signed* reconciling delta at `result` so the per-turn
 * total handed downstream (and persisted for cost) lands exactly on
 * `result.usage` — trued up where the live stream under-reported (the usual
 * case: partial `output_tokens`) and back down where it over-reported. Mid-turn
 * inaccuracy is expected and fine; the end-of-turn total is what must be exact.
 *
 * Returns the usage event to emit, or null when there's nothing to add (a
 * repeated line of the same call, or a fully-reconciled zero delta).
 */
export function accountUsage(
  state: UsageAccountingState,
  raw: Record<string, unknown>,
): AgentEvent | null {
  const type = raw.type as string;

  if (type === "assistant") {
    const message = raw.message as Record<string, unknown> | undefined;
    const snap = extractUsage(message?.usage as Record<string, number> | undefined);
    if (!snap) return null;
    // The CLI repeats one call's usage on each of its lines (e.g. thinking +
    // text). Count each distinct call once; distinct calls are summed.
    if (state.lastCallSnapshot && sameUsage(snap, state.lastCallSnapshot)) {
      return null;
    }
    state.lastCallSnapshot = snap;
    addUsage(state.turnEmitted, snap);
    return usageEvent(snap);
  }

  if (type === "result") {
    const total = extractUsage(raw.usage as Record<string, number> | undefined);
    if (!total) return null;
    const emitted = state.turnEmitted;
    // `result.usage` is authoritative. Reconcile the running turn total to it
    // EXACTLY with a signed per-axis correction: positive where the streamed
    // per-call figures under-reported (the usual case — assistant
    // `output_tokens` is partial), negative where they over-reported (e.g. a
    // distinct call was wrongly deduped by `sameUsage`, or the CLI ever reports
    // input/cache cumulatively rather than per-call). Downstream consumers
    // accumulate with `+=` into an unclamped TokenTotals (see worker/usage.ts),
    // so a negative delta correctly trues the persisted per-turn total back down
    // to result.usage rather than letting an over-count stand.
    const delta: UsageTuple = {
      input: total.input - emitted.input,
      output: total.output - emitted.output,
      cacheRead: total.cacheRead - emitted.cacheRead,
      cacheWrite: total.cacheWrite - emitted.cacheWrite,
    };
    addUsage(emitted, delta);
    if (!delta.input && !delta.output && !delta.cacheRead && !delta.cacheWrite) {
      return null;
    }
    return usageEvent(delta);
  }

  return null;
}

function zero(): UsageTuple {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Pull the four billed token classes out of a raw CLI usage object. */
function extractUsage(usage: Record<string, number> | undefined): UsageTuple | null {
  if (!usage) return null;
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0,
  };
}

function addUsage(into: UsageTuple, add: UsageTuple): void {
  into.input += add.input;
  into.output += add.output;
  into.cacheRead += add.cacheRead;
  into.cacheWrite += add.cacheWrite;
}

function sameUsage(a: UsageTuple, b: UsageTuple): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite
  );
}

/**
 * Build the normalized usage event. Fresh input and cache read/creation stay
 * separate so each is priced at its own rate downstream (Anthropic bills cache
 * reads at 0.1x, creation at 1.25x) rather than folded into full-rate input.
 */
function usageEvent(u: UsageTuple): AgentEvent {
  return {
    type: "usage",
    inputTokens: u.input,
    outputTokens: u.output,
    cacheReadTokens: u.cacheRead,
    cacheWriteTokens: u.cacheWrite,
  };
}

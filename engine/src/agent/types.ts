export interface AgentAdapter {
  readonly name: string;
  /** When true the runner sends continuation prompts between turns (Claude Code, Codex).
   *  When false the runner runs one turn and returns — orchestrator re-dispatches (Hermes). */
  readonly persistentSession: boolean;

  startSession(params: StartSessionParams): Promise<SessionHandle>;
  streamEvents(handle: SessionHandle): AsyncIterable<AgentEvent>;
  stopSession(handle: SessionHandle): Promise<void>;

  /** Run a single turn on a persistent session. Sends the prompt and yields events
   *  until the turn completes. Only needed for persistent-session adapters.
   *  Falls back to startSession + streamEvents if not implemented. */
  runTurn?(handle: SessionHandle, prompt: string): AsyncIterable<AgentEvent>;

  /** Forge Desktop: the person sends a message into a running session; it steers the turn in flight.
   *  False when the session isn't running (or the agent can't take a message mid-turn). */
  steer?(sessionId: string, text: string): boolean;
}

export interface StartSessionParams {
  prompt: string;
  workspacePath: string;
  mcpConfigPath?: string;
  sessionId?: string; // for resume/continuation
  maxTurns?: number;
  approvalPolicy?: string;
  sshHost?: string; // for remote execution via SSH
  sshConfigPath?: string; // path to SSH config file
  /** When true, only perform the handshake — don't send the first turn.
   *  Use with runTurn() to drive turns externally. */
  handshakeOnly?: boolean;
  /** Aborting it while `startSession` is pending kills any child the adapter
   *  spawned and rejects (honoured by codex; other adapters may ignore it).
   *  Once `startSession` resolves, stop through the returned handle instead. */
  signal?: AbortSignal;
}

export interface SessionHandle {
  id: string;
  pid?: number;
  abortController: AbortController;
}

export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; input: unknown }
  | { type: "tool_result"; output: unknown }
  | { type: "error"; message: string }
  | {
      /**
       * A usage event is an additive *increment*, not a cumulative snapshot: the
       * consumer (`addUsageTokens`, worker/usage.ts) sums every event into an
       * unclamped running total. Adapters must emit per-call/per-turn deltas.
       * Deltas may be negative — an adapter that streams optimistic per-call
       * figures and reconciles to an authoritative turn total (see
       * claude-usage.ts) emits a signed correction to land the total exactly.
       */
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      /** Fresh (non-cached) input excludes these; adapters that surface prompt
       *  caching report reads/writes separately so they can be priced at the
       *  provider's cache rates rather than the full input rate. Absent → 0. */
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | {
      /**
       * A helper the agent sent (a background subagent or background command)
       * started or finished. While any helper runs, the agent's turn is not over:
       * the runner keeps the session alive and waits (see worker/runner.ts).
       */
      type: "helper";
      id: string;
      status: "started" | "finished";
      description?: string;
    }
  | {
      /** A Claude subscription's usage window (Claude Code's rate_limit_event). */
      type: "rate_limit";
      window: string;
      /** How much of the window is used, 0 to 100, when Claude Code says. */
      percent: number | null;
      resetsAt: string | null;
      status: string;
    }
  | {
      /** The agent ended its turn but helpers still run; the session stays open until they finish. */
      type: "waiting_for_helpers";
      running: number;
    }
  | { type: "done"; success: boolean };

/**
 * What a session is, as the sessions host keeps it and sends it to the app.
 *
 * A session is one piece of work on one repo: its own folder and branch, one or more chats with an
 * agent, its diff and its pull request. `origin` says who started it: the person, Forge from a card,
 * or an import from Conductor. Design: docs/design/sessions.md.
 *
 * New in Forge Desktop.
 */

export type SessionOrigin = "person" | "card" | "import";
export type SessionStatus = "working" | "needs_you" | "review" | "merged" | "idle" | "archived";

export interface SessionRecord {
  id: string;
  workspaceId: string;
  origin: SessionOrigin;
  /** owner/name */
  repo: string;
  folder: string;
  branch: string;
  base: string;
  title: string;
  titleByHand: boolean;
  /** The GitHub account (gh login) that reaches the repo; null = gh's active one. */
  githubLogin: string | null;
  prNumber: number | null;
  prState: string | null;
  prTitle: string | null;
  unread: boolean;
  archived: boolean;
  /** The private ref holding the folder's last state when it was archived. */
  archiveRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChatState = "idle" | "working" | "needs_you" | "stopped" | "failed";

export interface ChatRecord {
  id: string;
  sessionId: string;
  title: string;
  provider: "claude" | "codex";
  model: string;
  effort: string;
  planMode: boolean;
  askBeforeChanges: boolean;
  /** The agent's own session id, used to resume it after a restart. */
  providerSessionId: string | null;
  /** Set after going back to before the first turn: the next start begins a new agent session with this id. */
  startSessionId?: string | null;
  state: ChatState;
  contextTokens: number;
  contextWindow: number;
  hidden: boolean;
  createdAt: string;
}

export type TurnStatus = "working" | "done" | "stopped" | "failed" | "interrupted";

export interface TurnRecord {
  id: string;
  chatId: string;
  seq: number;
  userText: string;
  status: TurnStatus;
  checkpointBefore: string | null;
  checkpointAfter: string | null;
  added: number;
  removed: number;
  files: number;
  startedAt: string;
  endedAt: string | null;
}

/**
 * One thing that happened in a turn. `text` grows while the agent writes (same id, longer text).
 * Big tool output is cut to a preview; `size` keeps the real length.
 */
export type EventKind =
  | "user"
  | "text"
  | "thinking"
  | "tool"
  | "tool_result"
  | "permission"
  | "question"
  | "plan"
  | "note"
  | "error"
  /** Sent once when an event leaves the transcript (the app removes it); never stored. */
  | "dropped";

export interface EventRecord {
  id: string;
  chatId: string;
  turnId: string;
  seq: number;
  kind: EventKind;
  /** Plain text for user, text, thinking, note and error events; the tool's one-line summary for tools. */
  text: string;
  /** Tool name, permission tool, or "steered" on a user message sent into a running turn. */
  name: string | null;
  /** Tool input, result preview, question options or permission input (JSON). */
  data: unknown;
  size: number;
  /** For tool results: the tool call this answers. */
  ref: string | null;
  isError: boolean;
  at: string;
}

export interface TurnWithEvents extends TurnRecord {
  events: EventRecord[];
}

export const PREVIEW_CHARS = 2000;

/** Cut a long text to its preview, keeping its real length in `size`. */
export function preview(text: string): { text: string; size: number } {
  return text.length > PREVIEW_CHARS
    ? { text: text.slice(0, PREVIEW_CHARS), size: text.length }
    : { text, size: text.length };
}

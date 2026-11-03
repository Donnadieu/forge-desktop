/**
 * One plain line about what an agent is doing right now, for the board
 * ("Editing login.tsx", "Running the tests"), and the lead's helpers. Built from
 * the agent's events; never shows tool names like "Bash" or internal words.
 *
 * New in Forge Desktop.
 */
import type { AgentEvent } from "../agent/types.js";

export interface HelperActivity {
  id: string;
  description: string;
  running: boolean;
}

const MAX = 90;

function cut(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX ? `${one.slice(0, MAX - 1).trimEnd()}…` : one;
}

function base(path: unknown): string {
  return typeof path === "string" ? (path.split("/").pop() ?? path) : "a file";
}

function input(event: { input: unknown }): Record<string, unknown> {
  return event.input && typeof event.input === "object"
    ? (event.input as Record<string, unknown>)
    : {};
}

/** A command, in words: the tests, a build, git, or the first word. */
function commandLine(cmd: string): string {
  const c = cmd.trim();
  if (/\b(test|vitest|jest|pytest|rspec|go test|cargo test)\b/.test(c)) return "Running the tests";
  if (/\bgh pr create\b/.test(c)) return "Opening the pull request";
  if (/\bgh pr merge\b/.test(c)) return "Merging the pull request";
  if (/\bgit push\b/.test(c)) return "Pushing the branch";
  if (/\bgit commit\b/.test(c)) return "Committing";
  if (/\b(build|tsc|make)\b/.test(c)) return "Building";
  if (/\b(lint|biome|eslint|ruff)\b/.test(c)) return "Checking the code style";
  if (/\b(npm|pnpm|yarn|pip|bundle) (i|install|add)\b/.test(c)) return "Installing packages";
  const first = c.split(/\s+/)[0]?.split("/").pop() ?? "";
  return first ? `Running ${first}` : "Running a command";
}

/** The plain line for one event, or null when the event says nothing new. */
export function plainActivity(event: AgentEvent): string | null {
  switch (event.type) {
    case "text": {
      const first = event.content.split(/(?<=[.!?])\s|\n/)[0] ?? "";
      return first.trim() ? cut(first) : null;
    }
    case "tool_use": {
      const i = input(event);
      switch (event.tool) {
        case "Edit":
        case "MultiEdit":
        case "Write":
        case "NotebookEdit":
          return cut(`Editing ${base(i.file_path ?? i.notebook_path)}`);
        case "Read":
          return cut(`Reading ${base(i.file_path)}`);
        case "Grep":
        case "Glob":
          return "Searching the code";
        case "Bash":
          return commandLine(String(i.command ?? ""));
        case "WebFetch":
        case "WebSearch":
          return "Looking something up on the web";
        case "Agent":
        case "Task":
          return cut(`Sending a helper: ${String(i.description ?? "a task")}`);
        case "TodoWrite":
          return "Planning the next steps";
        default:
          if (event.tool.startsWith("mcp__") && /linear/i.test(event.tool))
            return "Updating the card";
          return null;
      }
    }
    case "waiting_for_helpers":
      return `Waiting for ${event.running} helper${event.running === 1 ? "" : "s"} to finish`;
    default:
      return null;
  }
}

/** Keeps the lead's helpers up to date from `helper` events. */
export function applyHelperEvent(helpers: HelperActivity[], event: AgentEvent): void {
  if (event.type !== "helper") return;
  const found = helpers.find((h) => h.id === event.id);
  if (event.status === "started") {
    if (found) found.running = true;
    else
      helpers.push({
        id: event.id,
        description: cut(event.description ?? "A helper"),
        running: true,
      });
  } else if (found) {
    found.running = false;
  }
}

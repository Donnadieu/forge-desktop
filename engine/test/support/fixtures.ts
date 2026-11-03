import type {
  AgentAdapter,
  AgentEvent,
  SessionHandle,
  StartSessionParams,
} from "../../src/agent/types.js";
import type { NormalizedIssue } from "../../src/tracker/types.js";

/**
 * Create a mock agent that completes immediately with configurable events.
 */
export function createMockAgent(
  options: { events?: AgentEvent[][]; failOnTurn?: number } = {},
): AgentAdapter {
  let turnIndex = 0;
  const events = options.events || [[{ type: "done", success: true }]];

  return {
    name: "mock",
    persistentSession: true,
    async startSession(_params: StartSessionParams): Promise<SessionHandle> {
      return {
        id: `mock-session-${turnIndex}-${Date.now()}`,
        abortController: new AbortController(),
      };
    },
    async *streamEvents(_handle: SessionHandle): AsyncIterable<AgentEvent> {
      const currentTurn = turnIndex;
      turnIndex++;

      if (options.failOnTurn !== undefined && currentTurn === options.failOnTurn) {
        yield { type: "error", message: "Mock agent failure" };
        return;
      }

      const turnEvents = events[currentTurn] || events[events.length - 1] || [];
      for (const event of turnEvents) {
        yield event;
      }
    },
    async stopSession(_handle: SessionHandle): Promise<void> {},
  };
}

/**
 * Create a standard test issue.
 */
export function createTestIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    id: `issue-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    identifier: "MT-1",
    title: "Test issue",
    description: "Test description for the issue",
    state: "Todo",
    priority: 2,
    labels: ["test"],
    blockedBy: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

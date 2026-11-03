import type { Logger } from "pino";
import { ClaudeCodeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import type { CodexSandboxPolicy } from "./codex-sandbox.js";
import { checkAgentModelCompat } from "./compat.js";
import { KimiAdapter } from "./kimi.js";
import type { AgentAdapter } from "./types.js";

export { scrubAgentEnv, scrubMcpServerEnvs, workspaceHookEnv } from "./child-env.js";
export { ClaudeCodeAdapter } from "./claude.js";
export { CodexAdapter } from "./codex.js";
export { type CodexSandboxPolicy, tenantRepoSandboxPolicy } from "./codex-sandbox.js";
export { KimiAdapter } from "./kimi.js";
export { runAgentOnce } from "./run-once.js";
export type {
  AgentAdapter,
  AgentEvent,
  SessionHandle,
  StartSessionParams,
} from "./types.js";

export function createAgent(
  kind: string,
  options?: {
    command?: string;
    model?: string;
    logger?: Logger;
    env?: NodeJS.ProcessEnv;
    envDenylist?: string[];
    /** Codex only; the other kinds have no per-turn sandbox policy. */
    sandboxPolicy?: CodexSandboxPolicy;
  },
): AgentAdapter {
  checkAgentModelCompat(kind, options?.model);
  switch (kind) {
    case "claude":
    case "mimo":
      return new ClaudeCodeAdapter(options);
    case "kimi":
      return new KimiAdapter(options);
    case "codex":
      return new CodexAdapter(options);
    default:
      throw new Error(`Unknown agent kind: ${kind}`);
  }
}

/** The orchestrator's own card agent. Forge Desktop runs agents as the person, so this is `createAgent`. */
export function createWorkerAgent(
  kind: string,
  options: Parameters<typeof createAgent>[1] = {},
): AgentAdapter {
  return createAgent(kind, options);
}

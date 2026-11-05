/**
 * Roles (Forge Desktop): a different intelligence provider, account and model for some stages of the board.
 * Each role names its stages, its agent kind and model, and the prefix its account's environment arrives under
 * (`FORGE_ROLE_<n>_…`), so two accounts of the same provider never share a variable. The agent for a card is
 * chosen from the card's state when it's dispatched; a card that moves to another role's stage ends its run and
 * is dispatched again with that role's agent (worker/issue-state-checker.ts).
 */
import type { AgentAdapter } from "./types.js";

export interface AgentRole {
  states: string[];
  kind: string;
  model?: string;
  env_prefix?: string;
}

const ROLE_VAR = /^FORGE_ROLE_\d+_/;

/**
 * The environment one role's agent runs with: the engine's own, minus the default account's variables
 * (`FORGE_ACCOUNT_VARS`, comma-separated) and every role's prefixed ones, plus this role's with the prefix taken
 * off. Never mutates `env`.
 */
export function roleEnv(env: NodeJS.ProcessEnv, prefix: string | undefined): NodeJS.ProcessEnv {
  const out = defaultAgentEnv(env);
  for (const name of (env.FORGE_ACCOUNT_VARS ?? "").split(",")) {
    if (name.trim()) delete out[name.trim()];
  }
  if (!prefix) return out;
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith(prefix) && k.length > prefix.length) out[k.slice(prefix.length)] = v;
  }
  return out;
}

/** The default agent's environment: the engine's own without any role's account. */
export function defaultAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!ROLE_VAR.test(k)) out[k] = v;
  }
  return out;
}

/** Picks the agent for a card's state: the role that lists the state, else the default. */
export class RoleRouter {
  constructor(
    private readonly fallback: AgentAdapter,
    private readonly roles: { states: string[]; agent: AgentAdapter }[],
  ) {}

  /** Which role a state belongs to: its index, or -1 for the default agent. */
  roleOf(state: string): number {
    return this.roles.findIndex((r) => r.states.includes(state));
  }

  agentFor(state: string): AgentAdapter {
    const i = this.roleOf(state);
    return i < 0 ? this.fallback : (this.roles[i]?.agent ?? this.fallback);
  }
}

import { describe, expect, it } from "vitest";
import { defaultAgentEnv, RoleRouter, roleEnv } from "../../../src/agent/roles.js";
import type { AgentAdapter } from "../../../src/agent/types.js";
import { WorkflowConfigSchema } from "../../../src/config/schema.js";

const env: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  CLAUDE_CODE_OAUTH_TOKEN: "default-token",
  FORGE_ACCOUNT_VARS: "CLAUDE_CODE_OAUTH_TOKEN,CLAUDE_CONFIG_DIR",
  CLAUDE_CONFIG_DIR: "/accounts/default",
  FORGE_ROLE_0_CODEX_HOME: "/accounts/codex-work",
  FORGE_ROLE_1_CLAUDE_CODE_OAUTH_TOKEN: "review-token",
};

describe("roles (Forge Desktop)", () => {
  it("gives a role only its own account, under the plain names", () => {
    const codex = roleEnv(env, "FORGE_ROLE_0_");
    expect(codex.CODEX_HOME).toBe("/accounts/codex-work");
    expect(codex.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(codex.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(codex.FORGE_ROLE_1_CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(codex.PATH).toBe("/usr/bin");
  });

  it("a second Claude account replaces the default's sign-in", () => {
    const review = roleEnv(env, "FORGE_ROLE_1_");
    expect(review.CLAUDE_CODE_OAUTH_TOKEN).toBe("review-token");
    expect(review.CODEX_HOME).toBeUndefined();
  });

  it("the default agent never sees a role's account", () => {
    const d = defaultAgentEnv(env);
    expect(d.CLAUDE_CODE_OAUTH_TOKEN).toBe("default-token");
    expect(Object.keys(d).some((k) => k.startsWith("FORGE_ROLE_"))).toBe(false);
  });

  it("never changes the engine's own environment", () => {
    roleEnv(env, "FORGE_ROLE_0_");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("default-token");
  });

  it("picks the agent by the card's stage", () => {
    const a = (name: string) => ({ name }) as unknown as AgentAdapter;
    const fallback = a("claude");
    const codex = a("codex");
    const router = new RoleRouter(fallback, [{ states: ["In Progress", "Rework"], agent: codex }]);
    expect(router.agentFor("In Progress")).toBe(codex);
    expect(router.agentFor("Rework")).toBe(codex);
    expect(router.agentFor("AI Review")).toBe(fallback);
    expect(router.roleOf("Rework")).toBe(0);
    expect(router.roleOf("AI Review")).toBe(-1);
  });

  it("the workflow file takes roles, and only well-formed prefixes", () => {
    const base = { tracker: { kind: "linear", project_slug: "p" } };
    const ok = WorkflowConfigSchema.parse({
      ...base,
      agent: { roles: [{ states: ["AI Review"], kind: "codex", env_prefix: "FORGE_ROLE_0_" }] },
    });
    expect(ok.agent.roles[0]?.kind).toBe("codex");
    expect(WorkflowConfigSchema.parse(base).agent.roles).toEqual([]);
    expect(() =>
      WorkflowConfigSchema.parse({
        ...base,
        agent: { roles: [{ states: ["QA"], kind: "claude", env_prefix: "PATH" }] },
      }),
    ).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  ALWAYS_DENIED_AGENT_ENV_VARS,
  GIT_IDENTITY_OVERRIDE_VARS,
  hermesGitTokenEnv,
  nonClaudeAgentEnv,
  scrubAgentEnv,
  scrubMcpServerEnvs,
  workspaceHookEnv,
} from "../../../src/agent/child-env.js";
import { claudeChildEnv } from "../../../src/agent/claude-env.js";

describe("scrubAgentEnv (FRG-4081)", () => {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/forge",
    DATABASE_URL: "postgres://staging",
    DATABASE_URL_STAGING_RW: "postgres://staging-rw",
    DATABASE_URL_PROD_RO: "postgres://prod-ro",
    FORGE_PIPELINE_DATABASE_URL: "postgres://pipeline",
    PGPASSWORD: "secret",
    PGPASSWORD_HINT: "keep",
  };

  it("returns an equivalent copy for an empty or absent denylist (no vars beyond the always-denied set)", () => {
    expect(scrubAgentEnv(env, [])).toEqual(env);
    expect(scrubAgentEnv(env, undefined)).toEqual(env);
  });

  it("removes exact names, anchored to the whole name", () => {
    const child = scrubAgentEnv(env, ["PGPASSWORD", "DATABASE_URL"]);
    expect(child.PGPASSWORD).toBeUndefined();
    expect(child.DATABASE_URL).toBeUndefined();
    expect(child.PGPASSWORD_HINT).toBe("keep");
    expect(child.DATABASE_URL_STAGING_RW).toBe("postgres://staging-rw");
  });

  it("removes every var matching a * glob and keeps the rest", () => {
    const child = scrubAgentEnv(env, ["*DATABASE_URL*"]);
    expect(Object.keys(child).sort()).toEqual(["HOME", "PATH", "PGPASSWORD", "PGPASSWORD_HINT"]);
  });

  it("matches case-sensitively and treats regex metacharacters literally", () => {
    expect(scrubAgentEnv(env, ["*database_url*"]).DATABASE_URL).toBe("postgres://staging");
    expect(scrubAgentEnv({ A_B: "1", AXB: "2" }, ["A.B"])).toEqual({ A_B: "1", AXB: "2" });
  });

  it("never mutates the input env", () => {
    const before = { ...env };
    scrubAgentEnv(env, ["*DATABASE_URL*", "PGPASSWORD"]);
    expect(env).toEqual(before);
  });
});

// Nov 2026: the Basecamp tracker secret and its refresh credentials leaked
// into agent children and a workspace dev-server's own process listing
// (confirmed live: FORGE_BASECAMP_API_KEY in a ConstructEase `puma`
// process's env) because the default denylist is empty and nothing forced
// these out. They must never reach a child regardless of what the workflow
// configures.
describe("Basecamp secrets never leak into a child env (FRG: Basecamp token refresh)", () => {
  const envWithBasecampSecrets: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/forge",
    FORGE_BASECAMP_API_KEY: "bc_at_should_never_leak",
    FORGE_BASECAMP_REFRESH_TOKEN: "bc_rt_should_never_leak",
    FORGE_BASECAMP_CLIENT_ID: "client-id-should-never-leak",
    FORGE_BASECAMP_CLIENT_SECRET: "client-secret-should-never-leak",
    FORGE_BASECAMP_CREDENTIALS_FILE: "/should/never/leak/credentials.json",
    FORGE_BASECAMP_REFRESH_XDG_CONFIG_HOME: "/should/never/leak",
  };

  it("scrubAgentEnv strips every Basecamp secret var with no denylist configured at all", () => {
    const result = scrubAgentEnv(envWithBasecampSecrets, undefined);
    for (const name of ALWAYS_DENIED_AGENT_ENV_VARS) {
      expect(result[name]).toBeUndefined();
    }
    expect(result.PATH).toBe("/usr/bin");
  });

  it("scrubAgentEnv strips Basecamp secrets even with an empty denylist", () => {
    expect(scrubAgentEnv(envWithBasecampSecrets, []).FORGE_BASECAMP_API_KEY).toBeUndefined();
  });

  it("nonClaudeAgentEnv (kimi/codex/hermes) strips Basecamp secrets too", () => {
    expect(
      nonClaudeAgentEnv(envWithBasecampSecrets, undefined).FORGE_BASECAMP_API_KEY,
    ).toBeUndefined();
  });

  it("workspaceHookEnv strips Basecamp secrets from a worker's dev-server start hook, the exact leak that happened live", () => {
    const result = workspaceHookEnv(envWithBasecampSecrets, undefined, {
      isSmith: false,
      isWorker: true,
    });
    expect(result.FORGE_BASECAMP_API_KEY).toBeUndefined();
  });

  it("workspaceHookEnv strips Basecamp secrets on a personal orchestrator too", () => {
    const result = workspaceHookEnv(envWithBasecampSecrets, undefined, {
      isSmith: false,
      isWorker: false,
    });
    expect(result.FORGE_BASECAMP_API_KEY).toBeUndefined();
  });

  it("scrubMcpServerEnvs strips Basecamp secrets from an MCP server's own env with no denylist", () => {
    const servers = { tracker: { command: "node", env: { ...envWithBasecampSecrets } } };
    const result = scrubMcpServerEnvs(servers, undefined);
    expect((result.tracker.env as NodeJS.ProcessEnv).FORGE_BASECAMP_API_KEY).toBeUndefined();
  });
});

describe("scrubMcpServerEnvs (FRG-4081)", () => {
  const servers = {
    "forge-pipeline": {
      command: "node",
      args: ["server.js"],
      env: { DATABASE_URL: "postgres://staging", LINEAR_API_KEY: "lin" },
    },
    "no-env": { command: "node" },
  };

  it("returns an equivalent copy for an empty denylist", () => {
    expect(scrubMcpServerEnvs(servers, [])).toEqual(servers);
  });

  it("scrubs each server's env and keeps the rest of its config", () => {
    const scrubbed = scrubMcpServerEnvs(servers, ["*DATABASE_URL*"]);
    expect(scrubbed).toEqual({
      "forge-pipeline": { command: "node", args: ["server.js"], env: { LINEAR_API_KEY: "lin" } },
      "no-env": { command: "node" },
    });
    expect(servers["forge-pipeline"].env.DATABASE_URL).toBe("postgres://staging");
  });
});

describe("workspaceHookEnv (FRG-5414)", () => {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-owner",
    DATABASE_URL: "postgres://staging",
  };
  const smith = { isSmith: true, isWorker: false };
  const personal = { isSmith: false, isWorker: false };

  it("withholds the Claude subscription token and the denylist on a Smith", () => {
    expect(workspaceHookEnv(env, ["DATABASE_URL"], smith)).toEqual({ PATH: "/usr/bin" });
    expect(workspaceHookEnv(env, undefined, smith)).toEqual({
      PATH: "/usr/bin",
      DATABASE_URL: "postgres://staging",
    });
  });

  it("keeps the token on a personal orchestrator, applying only the denylist", () => {
    expect(workspaceHookEnv(env, ["DATABASE_URL"], personal)).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-owner",
    });
    expect(workspaceHookEnv(env, [], personal)).toEqual(env);
  });

  it("withholds the token from build-worker hooks but not from the Claude child (FRG-5687)", () => {
    const workerEnv: NodeJS.ProcessEnv = {
      ...env,
      FORGE_WORKER_MODEL_PROVIDER: "claude-subscription",
    };
    const worker = { isSmith: false, isWorker: true };
    expect(workspaceHookEnv(workerEnv, ["DATABASE_URL"], worker)).toEqual({
      PATH: "/usr/bin",
      FORGE_WORKER_MODEL_PROVIDER: "claude-subscription",
    });
    expect(workspaceHookEnv(workerEnv, undefined, worker).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(claudeChildEnv(workerEnv).CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-owner");
  });
});

// FRG-5696: ~/.gitconfig holds no token, only a helper reading GH_TOKEN from
// the git process's env, so worker hooks and agents keep authenticating only
// while the default scrub passes GH_TOKEN through.
describe("GH_TOKEN reaches build-worker git (FRG-5696)", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", GH_TOKEN: "ghp_worker" };

  it("is kept by the default hook and agent scrub, dropped only when denylisted", () => {
    const worker = { isSmith: false, isWorker: true };
    expect(workspaceHookEnv(env, undefined, worker).GH_TOKEN).toBe("ghp_worker");
    // The env each adapter actually spawns with: codex/kimi/hermes, then claude.
    expect(nonClaudeAgentEnv(env, undefined).GH_TOKEN).toBe("ghp_worker");
    expect(scrubAgentEnv(env, ["DATABASE_URL"]).GH_TOKEN).toBe("ghp_worker");
    expect(claudeChildEnv({ ...env, FORGE_WORKER_MODEL_PROVIDER: "anthropic" }).GH_TOKEN).toBe(
      "ghp_worker",
    );
    expect(workspaceHookEnv(env, ["GH_TOKEN"], worker).GH_TOKEN).toBeUndefined();
  });

  it("is re-exported for Hermes' terminal on a build worker only", () => {
    expect(hermesGitTokenEnv(env, true)).toEqual({ FORGE_GIT_HTTP_TOKEN: "ghp_worker" });
    expect(hermesGitTokenEnv(env, false)).toEqual({});
    expect(hermesGitTokenEnv({ PATH: "/usr/bin" }, true)).toEqual({});
  });
});

describe("the workspace commit identity is not overridden by git's own env vars", () => {
  const gitOverrides = {
    GIT_AUTHOR_NAME: "Operator Shell",
    GIT_AUTHOR_EMAIL: "operator@example.test",
    GIT_COMMITTER_NAME: "Operator Shell",
    GIT_COMMITTER_EMAIL: "operator@example.test",
  };
  const configured: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    FORGE_GIT_AUTHOR_NAME: "Test Agent",
    FORGE_GIT_AUTHOR_EMAIL: "agent@example.test",
    ...gitOverrides,
  };

  it("drops GIT_AUTHOR_*/GIT_COMMITTER_* from agent and hook children when the identity is set", () => {
    const personal = { isSmith: false, isWorker: false };
    const children = [
      scrubAgentEnv(configured, undefined),
      scrubAgentEnv(claudeChildEnv(configured), undefined),
      nonClaudeAgentEnv(configured, undefined),
      workspaceHookEnv(configured, undefined, personal),
    ];
    for (const child of children) {
      for (const name of GIT_IDENTITY_OVERRIDE_VARS) expect(child[name], name).toBeUndefined();
      expect(child.PATH).toBe("/usr/bin");
    }
  });

  it("keeps them untouched when no workspace identity is configured", () => {
    const unconfigured = { PATH: "/usr/bin", ...gitOverrides };
    expect(scrubAgentEnv(unconfigured, undefined)).toEqual(unconfigured);
    expect(
      scrubAgentEnv({ ...unconfigured, FORGE_GIT_AUTHOR_NAME: "Only Name" }, undefined)
        .GIT_AUTHOR_NAME,
    ).toBe("Operator Shell");
  });
});

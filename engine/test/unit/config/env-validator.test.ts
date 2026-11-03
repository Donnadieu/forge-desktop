import { afterEach, describe, expect, it } from "vitest";
import { extractEnvVarRefs, validateRequiredEnv } from "../../../src/config/env-validator.js";
import type { WorkflowConfig } from "../../../src/config/schema.js";

function makeConfig(overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    tracker: {
      kind: "linear",
      project_slug: "test",
      active_states: ["Todo"],
      terminal_states: ["Done"],
      ...overrides.tracker,
    },
    workspace: {
      root: "/tmp/forge",
      hooks: { timeout_ms: 60000 },
      ...overrides.workspace,
    },
    agent: {
      kind: "claude",
      max_concurrent_agents: 1,
      max_concurrent_agents_by_state: {},
      max_turns: 1,
      turn_timeout_ms: 60000,
      read_timeout_ms: 60000,
      stall_timeout_seconds: 300,
      approval_policy: "on-request",
      max_retry_backoff_ms: 300000,
      ...overrides.agent,
    },
    polling: { interval_ms: 30000 },
    retry: { max_attempts: 5, base_delay_seconds: 10, max_delay_seconds: 300 },
    server: {},
    observability: { dashboard_enabled: false, refresh_ms: 1000 },
  } as WorkflowConfig;
}

describe("validateRequiredEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws when LINEAR_API_KEY is missing for linear tracker", () => {
    delete process.env.LINEAR_API_KEY;
    const config = makeConfig();
    expect(() => validateRequiredEnv(config)).toThrow("LINEAR_API_KEY");
  });

  it("passes when LINEAR_API_KEY is set for linear tracker", () => {
    process.env.LINEAR_API_KEY = "lin_test_key";
    const config = makeConfig();
    expect(() => validateRequiredEnv(config)).not.toThrow();
  });

  it("does not require LINEAR_API_KEY for non-linear trackers", () => {
    delete process.env.LINEAR_API_KEY;
    const config = makeConfig({
      tracker: {
        kind: "github" as "linear",
        project_slug: "test",
        active_states: ["Todo"],
        terminal_states: ["Done"],
      },
    });
    expect(() => validateRequiredEnv(config)).not.toThrow();
  });

  it("throws when hook references a missing env var", () => {
    process.env.LINEAR_API_KEY = "lin_test_key";
    delete process.env.REPO_URL;
    const config = makeConfig({
      workspace: {
        root: "/tmp/forge",
        hooks: {
          after_create: "git clone $REPO_URL .",
          timeout_ms: 60000,
        },
      },
    });
    expect(() => validateRequiredEnv(config)).toThrow(
      "REPO_URL (referenced in hook: after_create)",
    );
  });

  it("does NOT require a var that a ${VAR:-default} expansion gives a default", () => {
    // Regression: the extractor used to capture the whole `VAR:-/path` string
    // as the var name, flagging an impossible-to-set var and failing the build.
    process.env.LINEAR_API_KEY = "lin_test_key";
    delete process.env.FORGE_STAMPED_REPO_FILE;
    const config = makeConfig({
      workspace: {
        root: "/tmp/forge",
        hooks: {
          before_run: 'echo "${FORGE_STAMPED_REPO_FILE:-/data/.forge/stamped-repo}"',
          timeout_ms: 60000,
        },
      },
    });
    expect(() => validateRequiredEnv(config)).not.toThrow();
  });

  it("still requires ${VAR} and ${VAR:?msg} (no default supplied)", () => {
    process.env.LINEAR_API_KEY = "lin_test_key";
    delete process.env.NEEDS_BRACE;
    delete process.env.NEEDS_ERRIF;
    expect(() =>
      validateRequiredEnv(
        makeConfig({
          workspace: {
            root: "/tmp/forge",
            hooks: { after_create: 'echo "${NEEDS_BRACE}"', timeout_ms: 60000 },
          },
        }),
      ),
    ).toThrow("NEEDS_BRACE");
    expect(() =>
      validateRequiredEnv(
        makeConfig({
          workspace: {
            root: "/tmp/forge",
            hooks: { after_create: 'echo "${NEEDS_ERRIF:?must be set}"', timeout_ms: 60000 },
          },
        }),
      ),
    ).toThrow("NEEDS_ERRIF");
  });

  it("passes when hook env vars are set", () => {
    process.env.LINEAR_API_KEY = "lin_test_key";
    process.env.REPO_URL = "https://github.com/test/repo.git";
    const config = makeConfig({
      workspace: {
        root: "/tmp/forge",
        hooks: {
          after_create: "git clone $REPO_URL .",
          timeout_ms: 60000,
        },
      },
    });
    expect(() => validateRequiredEnv(config)).not.toThrow();
  });

  it("ignores system-provided vars like ISSUE_BRANCH in hooks", () => {
    process.env.LINEAR_API_KEY = "lin_test_key";
    const config = makeConfig({
      workspace: {
        root: "/tmp/forge",
        hooks: {
          before_run: 'git checkout -b "$ISSUE_BRANCH" origin/main',
          timeout_ms: 60000,
        },
      },
    });
    expect(() => validateRequiredEnv(config)).not.toThrow();
  });

  it("lists all missing vars in a single error", () => {
    delete process.env.LINEAR_API_KEY;
    delete process.env.REPO_URL;
    const config = makeConfig({
      workspace: {
        root: "/tmp/forge",
        hooks: {
          after_create: "git clone $REPO_URL .",
          timeout_ms: 60000,
        },
      },
    });
    expect(() => validateRequiredEnv(config)).toThrow(/LINEAR_API_KEY.*REPO_URL/s);
  });

  it("does not require vars with default-value expansion ${VAR:-default}", () => {
    process.env.LINEAR_API_KEY = "lin_test_key";
    delete process.env.FORGE_STAMPED_REPO_FILE;
    const config = makeConfig({
      workspace: {
        root: "/tmp/forge",
        hooks: {
          before_run: '_stamped_marker="${FORGE_STAMPED_REPO_FILE:-/data/.forge/stamped-repo}"',
          timeout_ms: 60000,
        },
      },
    });
    expect(() => validateRequiredEnv(config)).not.toThrow();
  });
});

describe("extractEnvVarRefs", () => {
  it("treats ${FOO:-bar} as optional", () => {
    expect(extractEnvVarRefs('x="${FOO:-bar}"')).not.toContain("FOO");
  });

  it("treats ${FOO:=bar} as optional", () => {
    expect(extractEnvVarRefs('x="${FOO:=bar}"')).not.toContain("FOO");
  });

  it("treats ${FOO:+bar} as optional", () => {
    expect(extractEnvVarRefs('x="${FOO:+bar}"')).not.toContain("FOO");
  });

  it("treats ${FOO?msg} and ${FOO:?msg} as required", () => {
    expect(extractEnvVarRefs('x="${FOO?msg}"')).toContain("FOO");
    expect(extractEnvVarRefs('x="${FOO:?msg}"')).toContain("FOO");
  });

  it("treats ${FOO} and $FOO as required", () => {
    expect(extractEnvVarRefs('x="${FOO}"')).toContain("FOO");
    expect(extractEnvVarRefs("x=$FOO")).toContain("FOO");
  });

  it("strips prefix, suffix, and replace operators from captured names", () => {
    expect(extractEnvVarRefs('x="${FOO#prefix}"')).not.toContain("FOO#prefix");
    expect(extractEnvVarRefs('x="${FOO##prefix}"')).not.toContain("FOO##prefix");
    expect(extractEnvVarRefs('x="${FOO%suffix}"')).not.toContain("FOO%suffix");
    expect(extractEnvVarRefs('x="${FOO%%suffix}"')).not.toContain("FOO%%suffix");
    expect(extractEnvVarRefs('x="${FOO/a/b}"')).not.toContain("FOO/a/b");
    expect(extractEnvVarRefs('x="${FOO//a/b}"')).not.toContain("FOO//a/b");
  });

  it("never captures operators or punctuation as part of a var name", () => {
    const refs = extractEnvVarRefs('_m="${FORGE_STAMPED_REPO_FILE:-/data/.forge/stamped-repo}"');
    expect(refs).not.toContain("FORGE_STAMPED_REPO_FILE");
    expect(refs).not.toContain("FORGE_STAMPED_REPO_FILE:-/data/.forge/stamped-repo");
    expect(refs).not.toContain("FORGE_STAMPED_REPO_FILE:-");
    for (const ref of refs) {
      expect(ref).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });

  it("does not require a var the script assigns to itself and reads back", () => {
    const refs = extractEnvVarRefs('FOO="$(cat file)"\necho "$FOO"');
    expect(refs).not.toContain("FOO");
  });

  it("does not require self-assigned vars via export/local/declare/readonly", () => {
    expect(extractEnvVarRefs('export FOO=bar\necho "$FOO"')).not.toContain("FOO");
    expect(extractEnvVarRefs('local FOO=bar\necho "$FOO"')).not.toContain("FOO");
    expect(extractEnvVarRefs('declare FOO=bar\necho "$FOO"')).not.toContain("FOO");
    expect(extractEnvVarRefs('readonly FOO=bar\necho "$FOO"')).not.toContain("FOO");
  });

  it("does not require vars bound by `read`", () => {
    expect(extractEnvVarRefs('read FOO\necho "$FOO"')).not.toContain("FOO");
    expect(extractEnvVarRefs('read -r A B\necho "$A$B"')).not.toContain("A");
    expect(extractEnvVarRefs('read -r A B\necho "$A$B"')).not.toContain("B");
  });

  it("still requires a var that is only read, never assigned", () => {
    expect(extractEnvVarRefs('FOO=x\necho "$FOO $BAR"')).toContain("BAR");
    expect(extractEnvVarRefs('FOO=x\necho "$FOO $BAR"')).not.toContain("FOO");
  });

  it("does not treat `==` comparisons as assignments", () => {
    // `[ "$X" == y ]` reads X, does not assign it.
    expect(extractEnvVarRefs('if [ "$X" == y ]; then :; fi')).toContain("X");
  });

  it("recognizes assignment after a shell separator on the same line", () => {
    expect(extractEnvVarRefs('true && FOO=bar; echo "$FOO"')).not.toContain("FOO");
  });

  it("captures the full stamped-repo before_run block without false positives", () => {
    // Exact regression: the generated before_run hook assigns _stamped_marker,
    // _stamped_repo, _stamped_url and reads them back. None are external inputs.
    const hook = [
      '_stamped_marker="${FORGE_STAMPED_REPO_FILE:-/data/.forge/stamped-repo}"',
      'if [ -s "$_stamped_marker" ]; then',
      '  _stamped_repo="$(cat "$_stamped_marker")"',
      '  _stamped_url="https://github.com/$_stamped_repo.git"',
      '  if [ -n "$_stamped_repo" ] && [ "$(git remote get-url origin 2>/dev/null)" != "$_stamped_url" ]; then',
      '    git remote set-url origin "$_stamped_url" || true',
      "  fi",
      "fi",
      "git fetch origin",
    ].join("\n");
    const refs = extractEnvVarRefs(hook);
    expect(refs).not.toContain("_stamped_marker");
    expect(refs).not.toContain("_stamped_repo");
    expect(refs).not.toContain("_stamped_url");
    expect(refs).not.toContain("FORGE_STAMPED_REPO_FILE");
  });
});

import { homedir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, resolvePath } from "../../../src/config/resolver.js";

describe("resolveConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TEST_API_KEY = "lin_api_test123";
    process.env.TEST_PROJECT = "forge-dev";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves $ENV_VAR references", () => {
    const config = resolveConfig({
      tracker: {
        kind: "linear",
        project_slug: "$TEST_PROJECT",
        active_states: ["Todo"],
      },
    });
    expect(config.tracker.project_slug).toBe("forge-dev");
  });

  it("resolves env var references in config values", () => {
    const config = resolveConfig({
      tracker: {
        kind: "linear",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${} syntax is the input under test
        project_slug: "${TEST_PROJECT}",
        active_states: ["Todo"],
      },
    });
    expect(config.tracker.project_slug).toBe("forge-dev");
  });

  it("throws on unresolved env vars in non-hook strings", () => {
    expect(() =>
      resolveConfig({
        tracker: {
          kind: "linear",
          project_slug: "$NONEXISTENT_VAR",
          active_states: ["Todo"],
        },
      }),
    ).toThrow("Missing environment variable(s): NONEXISTENT_VAR");
  });

  it("does not expand env vars inside hooks", () => {
    process.env.REPO_URL = "https://github.com/test/repo.git";
    const config = resolveConfig({
      tracker: {
        kind: "linear",
        project_slug: "test",
        active_states: ["Todo"],
      },
      workspace: {
        hooks: {
          after_create: "git clone $REPO_URL .",
          before_run: 'git checkout -b "$ISSUE_BRANCH" origin/main',
        },
      },
    });
    // Hooks should be passed through verbatim — the shell expands them at runtime
    expect(config.workspace.hooks.after_create).toBe("git clone $REPO_URL .");
    expect(config.workspace.hooks.before_run).toBe('git checkout -b "$ISSUE_BRANCH" origin/main');
  });

  it("still expands env vars in non-hook config values", () => {
    const config = resolveConfig({
      tracker: {
        kind: "linear",
        project_slug: "$TEST_PROJECT",
        active_states: ["Todo"],
      },
      workspace: {
        hooks: {
          before_run: "echo $TEST_PROJECT",
        },
      },
    });
    expect(config.tracker.project_slug).toBe("forge-dev");
    // But hook should NOT be expanded
    expect(config.workspace.hooks.before_run).toBe("echo $TEST_PROJECT");
  });

  it("resolves ~ in workspace root", () => {
    const config = resolveConfig({
      tracker: {
        kind: "linear",
        project_slug: "test",
        active_states: ["Todo"],
      },
      workspace: { root: "~/forge-workspaces" },
    });
    expect(config.workspace.root).toBe(resolve(homedir(), "forge-workspaces"));
  });
});

describe("resolvePath", () => {
  it("expands ~ to home directory", () => {
    expect(resolvePath("~/foo/bar")).toBe(resolve(homedir(), "foo/bar"));
  });

  it("resolves relative paths", () => {
    expect(resolvePath("./foo")).toBe(resolve("./foo"));
  });

  it("leaves absolute paths unchanged", () => {
    expect(resolvePath("/tmp/forge")).toBe("/tmp/forge");
  });
});

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrubAgentEnv, workspaceHookEnv } from "../../../src/agent/index.js";
import { WorkspaceManager } from "../../../src/workspace/manager.js";

describe("WorkspaceManager", () => {
  let testRoot: string;
  let manager: WorkspaceManager;

  beforeEach(() => {
    testRoot = join(tmpdir(), `forge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testRoot, { recursive: true });
    manager = new WorkspaceManager({
      root: testRoot,
      hooks: {},
    });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  describe("toSafeId", () => {
    it("replaces special characters with underscore", () => {
      expect(manager.toSafeId("MT-123")).toBe("MT-123");
      expect(manager.toSafeId("PROJ/issue#1")).toBe("PROJ_issue_1");
      expect(manager.toSafeId("a b c")).toBe("a_b_c");
    });

    it("preserves alphanumeric, dots, hyphens, underscores", () => {
      expect(manager.toSafeId("my-issue_v1.0")).toBe("my-issue_v1.0");
    });
  });

  describe("ensureWorkspace", () => {
    it("creates a new workspace directory", async () => {
      const path = await manager.ensureWorkspace("MT-123");
      expect(existsSync(path)).toBe(true);
      expect(path).toBe(join(testRoot, "MT-123"));
    });

    it("reuses existing workspace directory", async () => {
      const path1 = await manager.ensureWorkspace("MT-123");
      writeFileSync(join(path1, "test.txt"), "hello");
      const path2 = await manager.ensureWorkspace("MT-123");
      expect(path1).toBe(path2);
      expect(readFileSync(join(path2, "test.txt"), "utf-8")).toBe("hello");
    });

    it("creates deterministic path from issue identifier", async () => {
      const path = await manager.ensureWorkspace({
        id: "uuid-1",
        identifier: "PROJ-42",
        title: "Test",
        description: "desc",
        state: "Todo",
        priority: 1,
        labels: [],
        blockedBy: [],
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });
      expect(path).toBe(join(testRoot, "PROJ-42"));
    });

    it("replaces non-directory file at workspace path", async () => {
      const wsPath = join(testRoot, "MT-123");
      writeFileSync(wsPath, "stale file");
      const path = await manager.ensureWorkspace("MT-123");
      expect(existsSync(path)).toBe(true);
      // Should be a directory now, not a file
      const stat = statSync(path);
      expect(stat.isDirectory()).toBe(true);
    });

    it("clears a partial workspace without .forge-ready marker and reruns after_create", async () => {
      // Simulate a failed after_create: directory exists but no marker
      const wsPath = join(testRoot, "MT-BROKEN");
      mkdirSync(wsPath, { recursive: true });
      writeFileSync(join(wsPath, "stale-file.txt"), "leftover from failed clone");

      const managerWithHook = new WorkspaceManager({
        root: testRoot,
        hooks: {
          after_create: "git init && touch created.marker",
        },
      });

      const path = await managerWithHook.ensureWorkspace("MT-BROKEN");
      // Stale file from the failed partial state should be gone so the clone
      // hook can run into an empty directory (FRG-1082).
      expect(existsSync(join(path, "stale-file.txt"))).toBe(false);
      // after_create SHOULD run because .forge-ready was missing (treated as new)
      expect(existsSync(join(path, "created.marker"))).toBe(true);
      // .forge-ready marker should exist now
      expect(existsSync(join(path, ".forge-ready"))).toBe(true);
    });

    it("preserves workspace when .forge-ready marker exists", async () => {
      const managerWithHook = new WorkspaceManager({
        root: testRoot,
        hooks: {
          after_create: "git init && echo created >> hook.log",
        },
      });

      // First call creates workspace and writes marker
      const path = await managerWithHook.ensureWorkspace("MT-GOOD");
      writeFileSync(join(path, "work-in-progress.txt"), "important data");

      // Second call should reuse — marker exists
      await managerWithHook.ensureWorkspace("MT-GOOD");
      expect(existsSync(join(path, "work-in-progress.txt"))).toBe(true);
      // after_create should have only run once
      const log = readFileSync(join(path, "hook.log"), "utf-8");
      expect(log.trim().split("\n")).toHaveLength(1);
    });

    it("writes .forge-ready marker even without after_create hook", async () => {
      const path = await manager.ensureWorkspace("MT-NOHOST");
      expect(existsSync(join(path, ".forge-ready"))).toBe(true);
    });

    it("throws when after_create hook succeeds but leaves no .git directory", async () => {
      const managerWithHook = new WorkspaceManager({
        root: testRoot,
        hooks: {
          // Exits 0 but does not clone — the pre-fix FRG-1000 pattern.
          after_create: "touch some-file",
        },
      });

      await expect(managerWithHook.ensureWorkspace("MT-NOGIT")).rejects.toThrow(
        /has no \.git directory/,
      );
    });

    it("recovers a workspace marked ready without .git by clearing and re-cloning", async () => {
      // Simulate the exact broken state left by the old after_create hook.
      const wsPath = join(testRoot, "MT-RECOVER");
      mkdirSync(wsPath, { recursive: true });
      writeFileSync(join(wsPath, ".forge-ready"), new Date().toISOString());
      writeFileSync(join(wsPath, "orphan.txt"), "leftover from failed clone");

      const managerWithHook = new WorkspaceManager({
        root: testRoot,
        hooks: {
          after_create: "git init && echo cloned > clone.marker",
        },
      });

      const path = await managerWithHook.ensureWorkspace("MT-RECOVER");
      expect(existsSync(join(path, ".git"))).toBe(true);
      expect(existsSync(join(path, "clone.marker"))).toBe(true);
      // The orphan file from the broken partial state should be gone.
      expect(existsSync(join(path, "orphan.txt"))).toBe(false);
      // Marker should be rewritten (still present).
      expect(existsSync(join(path, ".forge-ready"))).toBe(true);
    });

    it("clears leftover files when .forge-ready is missing so git clone can run (FRG-1082)", async () => {
      // This is the survivor-league failure: a previous attempt created files
      // but exited before writing .forge-ready, so the next attempt's git clone
      // failed with "destination path '.' already exists and is not an empty directory".
      const wsPath = join(testRoot, "MT-FRG1082");
      mkdirSync(wsPath, { recursive: true });
      writeFileSync(join(wsPath, "package.json"), "{}");
      writeFileSync(join(wsPath, "stale.txt"), "leftover");

      const managerWithHook = new WorkspaceManager({
        root: testRoot,
        hooks: {
          after_create: "git init && touch clone.marker",
        },
      });

      const path = await managerWithHook.ensureWorkspace("MT-FRG1082");
      expect(existsSync(join(path, "stale.txt"))).toBe(false);
      expect(existsSync(join(path, "package.json"))).toBe(false);
      expect(existsSync(join(path, "clone.marker"))).toBe(true);
      expect(existsSync(join(path, ".forge-ready"))).toBe(true);
    });
  });

  describe("hooks", () => {
    it("runs after_create hook on first creation", async () => {
      const managerWithHook = new WorkspaceManager({
        root: testRoot,
        hooks: {
          after_create: "git init && touch created.marker",
        },
      });

      const path = await managerWithHook.ensureWorkspace("MT-100");
      expect(existsSync(join(path, "created.marker"))).toBe(true);
    });

    it("does not run after_create on existing workspace", async () => {
      const hookRoot = join(testRoot, "hook-test");
      mkdirSync(hookRoot, { recursive: true });

      const managerWithHook = new WorkspaceManager({
        root: hookRoot,
        hooks: {
          after_create: "git init && echo created >> hook.log",
        },
      });

      const path = await managerWithHook.ensureWorkspace("MT-200");
      // Run again -- should NOT run after_create
      await managerWithHook.ensureWorkspace("MT-200");

      const log = readFileSync(join(path, "hook.log"), "utf-8");
      // Should only have one "created" entry
      expect(log.trim().split("\n")).toHaveLength(1);
    });

    it("runs before_run and after_run hooks", async () => {
      const managerWithHook = new WorkspaceManager({
        root: testRoot,
        hooks: {
          before_run: "touch before.marker",
          after_run: "touch after.marker",
        },
      });

      const path = await managerWithHook.ensureWorkspace("MT-300");
      await managerWithHook.runHook("before_run", path);
      await managerWithHook.runHook("after_run", path);

      expect(existsSync(join(path, "before.marker"))).toBe(true);
      expect(existsSync(join(path, "after.marker"))).toBe(true);
    });

    it("passes issue env vars to hooks", async () => {
      const managerWithHook = new WorkspaceManager({
        root: testRoot,
        hooks: {
          before_run: 'echo "$ISSUE_IDENTIFIER:$ISSUE_BRANCH" > env.log',
        },
      });

      const path = await managerWithHook.ensureWorkspace("MT-500");
      await managerWithHook.runHook("before_run", path, {
        ISSUE_ID: "uuid-1",
        ISSUE_IDENTIFIER: "MT-500",
        ISSUE_BRANCH: "forge/MT-500",
        ISSUE_TITLE: "Test issue",
        ISSUE_STATE: "Todo",
      });

      const log = readFileSync(join(path, "env.log"), "utf-8").trim();
      expect(log).toBe("MT-500:forge/MT-500");
    });

    it("runs hooks on the injected hookBaseEnv (FRG-4081 env_denylist)", async () => {
      vi.stubEnv("DATABASE_URL", "postgres://staging");
      vi.stubEnv("DATABASE_URL_STAGING_RW", "postgres://staging-rw");
      try {
        const managerWithHook = new WorkspaceManager({
          root: testRoot,
          hooks: { before_run: "env > env.log" },
          hookBaseEnv: () => scrubAgentEnv(process.env, ["*DATABASE_URL*"]),
        });

        const path = await managerWithHook.ensureWorkspace("MT-502");
        await managerWithHook.runHook("before_run", path, { ISSUE_IDENTIFIER: "MT-502" });

        const log = readFileSync(join(path, "env.log"), "utf-8");
        expect(log).not.toContain("DATABASE_URL");
        expect(log).toContain("ISSUE_IDENTIFIER=MT-502");
        expect(log).toContain(`WORKSPACE_PATH=${path}`);
        expect(log).toMatch(/^PATH=/m);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("withholds CLAUDE_CODE_OAUTH_TOKEN from Smith and build-worker hooks only", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-owner");
      vi.stubEnv("DATABASE_URL", "postgres://staging");
      try {
        const runEnvHook = async (identifier: string, isSmith: boolean, isWorker: boolean) => {
          const managerWithHook = new WorkspaceManager({
            root: testRoot,
            hooks: { before_run: "env > env.log" },
            hookBaseEnv: () =>
              workspaceHookEnv(process.env, ["*DATABASE_URL*"], { isSmith, isWorker }),
          });
          const path = await managerWithHook.ensureWorkspace(identifier);
          await managerWithHook.runHook("before_run", path, { ISSUE_IDENTIFIER: identifier });
          return { path, log: readFileSync(join(path, "env.log"), "utf-8") };
        };

        const smith = await runEnvHook("MT-503", true, false);
        expect(smith.log).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
        expect(smith.log).not.toContain("DATABASE_URL");
        expect(smith.log).toContain("ISSUE_IDENTIFIER=MT-503");
        expect(smith.log).toContain(`WORKSPACE_PATH=${smith.path}`);
        expect(smith.log).toMatch(/^PATH=/m);

        const worker = await runEnvHook("MT-505", false, true);
        expect(worker.log).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
        expect(worker.log).not.toContain("DATABASE_URL");

        const personal = await runEnvHook("MT-504", false, false);
        expect(personal.log).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-owner");
        expect(personal.log).not.toContain("DATABASE_URL");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("hooks work without issue env vars", async () => {
      const managerWithHook = new WorkspaceManager({
        root: testRoot,
        hooks: {
          before_run: "touch no-env.marker",
        },
      });

      const path = await managerWithHook.ensureWorkspace("MT-501");
      await managerWithHook.runHook("before_run", path);
      expect(existsSync(join(path, "no-env.marker"))).toBe(true);
    });

    it("throws on hook failure", async () => {
      const managerWithHook = new WorkspaceManager({
        root: testRoot,
        hooks: {
          before_run: "exit 1",
        },
      });

      const path = await managerWithHook.ensureWorkspace("MT-400");
      await expect(managerWithHook.runHook("before_run", path)).rejects.toThrow(
        /Hook 'before_run' failed/,
      );
    });

    it("skips hooks that are not configured", async () => {
      const path = await manager.ensureWorkspace("MT-500");
      // Should not throw
      await manager.runHook("before_run", path);
      await manager.runHook("after_run", path);
    });
  });

  describe("removeWorkspace", () => {
    it("is a no-op — does not remove workspace directory", async () => {
      const path = await manager.ensureWorkspace("MT-600");
      expect(existsSync(path)).toBe(true);
      await manager.removeWorkspace(path);
      // Workspace should still exist — removeWorkspace is a no-op
      expect(existsSync(path)).toBe(true);
    });

    it("is a no-op — does not run before_remove hook", async () => {
      const markerPath = join(testRoot, "remove-marker");
      const managerWithHook = new WorkspaceManager({
        root: testRoot,
        hooks: {
          before_remove: `touch ${markerPath}`,
        },
      });

      const path = await managerWithHook.ensureWorkspace("MT-700");
      await managerWithHook.removeWorkspace(path);
      // Hook should NOT have run — removeWorkspace is a no-op
      expect(existsSync(markerPath)).toBe(false);
    });
  });

  describe("writeMcpConfig", () => {
    it("writes MCP config to .forge/mcp.json", async () => {
      const path = await manager.ensureWorkspace("MT-800");
      const configPath = await manager.writeMcpConfig(path, {
        "forge-linear": {
          command: "node",
          args: ["linear-server.js"],
          env: { LINEAR_API_KEY: "test" },
        },
      });

      expect(configPath).toBe(join(path, ".forge", "mcp.json"));
      const content = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(content.mcpServers["forge-linear"].command).toBe("node");
    });
  });

  describe("skills injection", () => {
    it("copies skill files into workspace .forge/skills/", async () => {
      // Create a skills directory with test skills
      const skillsDir = join(testRoot, "_skills_source");
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(
        join(skillsDir, "commit.md"),
        "---\nname: commit\ndescription: Git commit skill\n---\n# Commit\nSteps...",
      );
      writeFileSync(
        join(skillsDir, "push.md"),
        "---\nname: push\ndescription: Git push skill\n---\n# Push\nSteps...",
      );
      // Non-.md file should be ignored
      writeFileSync(join(skillsDir, "notes.txt"), "not a skill");

      const skillsManager = new WorkspaceManager({
        root: testRoot,
        hooks: {},
        skillsDir,
      });

      const path = await skillsManager.ensureWorkspace("MT-500");
      const copiedCommit = join(path, ".forge", "skills", "commit.md");
      const copiedPush = join(path, ".forge", "skills", "push.md");
      const copiedTxt = join(path, ".forge", "skills", "notes.txt");

      expect(existsSync(copiedCommit)).toBe(true);
      expect(existsSync(copiedPush)).toBe(true);
      expect(existsSync(copiedTxt)).toBe(false);
      expect(readFileSync(copiedCommit, "utf-8")).toContain("# Commit");
    });

    it("copies skill files from subdirectories (e.g. frontend-design/SKILL.md)", async () => {
      const skillsDir = join(testRoot, "_skills_source_nested");
      mkdirSync(join(skillsDir, "frontend-design"), { recursive: true });
      writeFileSync(
        join(skillsDir, "frontend-design", "SKILL.md"),
        "---\nname: frontend-design\n---\n# Design\nPatterns...",
      );
      // Also a sub-subdirectory
      mkdirSync(join(skillsDir, "code-review", "utilities"), { recursive: true });
      writeFileSync(
        join(skillsDir, "code-review", "SKILL.md"),
        "---\nname: code-review\n---\n# Review\nSteps...",
      );
      writeFileSync(join(skillsDir, "code-review", "utilities", "analyzer.md"), "# Analyzer");

      const skillsManager = new WorkspaceManager({
        root: testRoot,
        hooks: {},
        skillsDir,
      });

      const path = await skillsManager.ensureWorkspace("MT-502");
      const fdSkill = join(path, ".forge", "skills", "frontend-design", "SKILL.md");
      const crSkill = join(path, ".forge", "skills", "code-review", "SKILL.md");
      const crUtil = join(path, ".forge", "skills", "code-review", "utilities", "analyzer.md");
      const fdClaude = join(path, ".claude", "skills", "frontend-design", "SKILL.md");

      expect(existsSync(fdSkill)).toBe(true);
      expect(existsSync(crSkill)).toBe(true);
      expect(existsSync(crUtil)).toBe(true);
      expect(existsSync(fdClaude)).toBe(true);
      expect(readFileSync(fdSkill, "utf-8")).toContain("# Design");
    });

    it("handles missing skills directory gracefully", async () => {
      const skillsManager = new WorkspaceManager({
        root: testRoot,
        hooks: {},
        skillsDir: join(testRoot, "_nonexistent_skills"),
      });

      // Should not throw
      const path = await skillsManager.ensureWorkspace("MT-501");
      expect(existsSync(path)).toBe(true);
    });
  });

  describe("path safety", () => {
    it("rejects path that equals root", async () => {
      const badManager = new WorkspaceManager({
        root: testRoot,
        hooks: {},
      });
      // Trying to use empty identifier would resolve to root
      await expect(badManager.ensureWorkspace("")).rejects.toThrow();
    });

    it("rejects path traversal attempts", async () => {
      await expect(manager.ensureWorkspace("../../etc")).rejects.toThrow(/escapes root/);
    });

    it("rejects symlink escapes via ensureWorkspace", async () => {
      // ensureWorkspace with path traversal should reject
      await expect(manager.ensureWorkspace("../../etc")).rejects.toThrow(/escapes root/);
    });
  });

  describe("non-root worker chown gating", () => {
    // The chown that hands the prepared workspace to the dropped-privilege agent
    // child (chownWorkspaceForWorker) is gated on running as root. CI/dev never
    // runs as root, so the gate must be a clean no-op there: the workspace is
    // still created, and FORGE_WORKER_UID being set must not break anything.
    const origUid = process.env.FORGE_WORKER_UID;
    const origGid = process.env.FORGE_WORKER_GID;

    afterEach(() => {
      if (origUid === undefined) delete process.env.FORGE_WORKER_UID;
      else process.env.FORGE_WORKER_UID = origUid;
      if (origGid === undefined) delete process.env.FORGE_WORKER_GID;
      else process.env.FORGE_WORKER_GID = origGid;
    });

    it("is a no-op when not root even with FORGE_WORKER_UID set (workspace still created)", async () => {
      // Guard: this test asserts the non-root path. If a future CI ever runs as
      // root, skip rather than chown a temp dir to a uid that may not exist.
      if (typeof process.getuid === "function" && process.getuid() === 0) return;
      process.env.FORGE_WORKER_UID = "10001";
      process.env.FORGE_WORKER_GID = "10001";
      const path = await manager.ensureWorkspace("MT-CHOWN");
      expect(existsSync(path)).toBe(true);
      // Ownership must be unchanged from the creating (current, non-root) user.
      expect(statSync(path).uid).toBe(process.getuid?.());
    });
  });

  describe("runHook — non-blocking async execution", () => {
    // Regression: after_create runs `git clone` + `npm install`, whose combined
    // stdout on a large repo exceeds execSync's default 1MB maxBuffer (ENOBUFS →
    // "Command failed" with no real error) AND blocks the Node event loop for the
    // whole install, freezing the HTTP dashboard, the poll loop, and every other
    // concurrently-dispatched worker. Hooks now run via async exec with a raised
    // maxBuffer.
    it("succeeds when a hook emits more than the old 1MB stdout buffer", async () => {
      const wsPath = join(testRoot, "BIG-OUTPUT");
      mkdirSync(wsPath, { recursive: true });
      const m = new WorkspaceManager({
        root: testRoot,
        // ~2MB of stdout — would trip ENOBUFS under the previous execSync default.
        hooks: { after_create: "dd if=/dev/zero bs=1024 count=2048 2>/dev/null | tr '\\0' 'a'" },
      });
      await expect(m.runHook("after_create", wsPath)).resolves.toBeUndefined();
    });

    it("does not block the event loop while a hook runs", async () => {
      const wsPath = join(testRoot, "NON-BLOCKING");
      mkdirSync(wsPath, { recursive: true });
      const m = new WorkspaceManager({
        root: testRoot,
        hooks: { after_create: "sleep 0.3" },
      });
      // With a blocking execSync the interval callback cannot fire during the
      // 300ms sleep; with async exec the loop keeps ticking.
      let ticks = 0;
      const interval = setInterval(() => {
        ticks++;
      }, 20);
      try {
        await m.runHook("after_create", wsPath);
      } finally {
        clearInterval(interval);
      }
      expect(ticks).toBeGreaterThan(3);
    });
  });
});

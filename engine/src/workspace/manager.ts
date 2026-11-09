import { exec } from "node:child_process";
import { lstat, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { NormalizedIssue } from "../tracker/types.js";
import { type CleanupWorkspaceResult, cleanupCompletedWorkspaceImpl } from "./cleanup.js";
import { copyWorkspaceAssets, type OrgSkillFile } from "./copy-assets.js";
import { stopLeftoverServers } from "./leftover-sweep.js";
import { acquireWorkspaceLock, liveLockHolder, type WorkspaceLockResult } from "./lock.js";
import { writeMcpConfig as writeMcpConfigFile } from "./mcp-config.js";

export interface WorkspaceConfig {
  root: string;
  hooks: {
    after_create?: string;
    before_run?: string;
    after_run?: string;
    before_remove?: string;
  };
  hookTimeoutMs?: number;
  skillsDir?: string;
  templatesDir?: string;
  sshConfigPath?: string;
  /** "Keep Forge invisible": the guard each card folder gets (marks-guard.ts). */
  marksGuard?: string;
  /**
   * Supplies the org-owned skills to overlay on top of the built-in ones.
   * Injected rather than resolved here because deciding *which* skills apply
   * needs the feature gate and the database, and the workspace layer may depend
   * on neither — see `pipeline/org-skills-loader.ts` for the wiring. Absent ⇒
   * the run loads only built-in skills, which is what an unflagged deploy does.
   */
  loadOrgSkills?: () => Promise<OrgSkillFile[]>;
  /**
   * Base env for local hook shells, read at each hook run. Injected so the
   * orchestrator's `agent.env_denylist` scrub (agent/child-env.ts) applies to
   * hooks too without this layer importing `agent/`. Absent ⇒ `process.env`.
   */
  hookBaseEnv?: () => NodeJS.ProcessEnv;
  /**
   * Stops what earlier runs left running in a card's workspace (dev servers),
   * called while the card's lock is held. Absent ⇒ `stopLeftoverServers`.
   */
  stopLeftovers?: (root: string, card: string) => Promise<unknown>;
}

const defaultStopLeftovers = (root: string, card: string) =>
  stopLeftoverServers(root, { only: card });

export class WorkspaceManager {
  public readonly config: WorkspaceConfig;
  private createdPaths = new Set<string>();

  constructor(config: WorkspaceConfig) {
    this.config = config;
  }

  /**
   * Ensure a workspace exists for the given issue.
   * Creates the directory if it doesn't exist, runs after_create hook on first creation.
   */
  async ensureWorkspace(issue: NormalizedIssue | string): Promise<string> {
    const workspacePath = await this.resolveWorkspacePath(issue);
    await mkdir(this.config.root, { recursive: true });

    let isNew: boolean;
    const readyMarker = join(workspacePath, ".forge-ready");
    const gitDir = join(workspacePath, ".git");
    const hasAfterCreate = Boolean(this.config.hooks.after_create);

    if (await this.pathExists(workspacePath)) {
      const fileStat = await lstat(workspacePath);
      if (!fileStat.isDirectory()) {
        // Exists as a file — remove and recreate as directory
        await rm(workspacePath);
        await mkdir(workspacePath, { recursive: true });
        isNew = true;
      } else {
        // Directory exists — reuse it only when it was marked ready. A missing
        // .forge-ready marker means a previous after_create failed part-way
        // through and left a partial workspace; the clone hook requires an empty
        // directory (FRG-1082). In the older FRG-1000 case the marker was
        // written even though .git was missing; we also recover that.
        const markerExists = await this.pathExists(readyMarker);
        const gitExists = await this.pathExists(gitDir);
        if (hasAfterCreate && markerExists && !gitExists) {
          // Clear the broken partial state so after_create can clone into an
          // empty directory. Work-in-progress files are not recoverable without
          // a .git directory anyway.
          for (const entry of await readdir(workspacePath)) {
            if (entry === "." || entry === "..") continue;
            await rm(join(workspacePath, entry), { recursive: true, force: true });
          }
          isNew = true;
        } else if (hasAfterCreate && !markerExists) {
          // FRG-1082: previous after_create failed before .forge-ready was
          // written (e.g. git clone into a non-empty directory on retry).
          // Clear leftover files so the clone hook can start fresh.
          for (const entry of await readdir(workspacePath)) {
            if (entry === "." || entry === "..") continue;
            await rm(join(workspacePath, entry), { recursive: true, force: true });
          }
          isNew = true;
        } else {
          // Valid worktree: marker exists (and .git exists if after_create is
          // configured). Never delete existing valid worktrees.
          isNew = !markerExists;
        }
      }
    } else {
      await mkdir(workspacePath, { recursive: true });
      isNew = true;
    }

    // Run after_create hook only on first creation
    if (isNew && hasAfterCreate) {
      await this.runHook("after_create", workspacePath);
    }

    // Safety check: a workspace is only "ready" if it actually contains a git
    // repository. A missing .git after a supposedly successful after_create
    // means the hook exited 0 without cloning (e.g. an un-normalized GH_REPO
    // URL failing silently before `set -e` was added — FRG-1000).
    if (isNew && hasAfterCreate && !(await this.pathExists(gitDir))) {
      throw new Error(
        `Workspace ${workspacePath} was initialized but has no .git directory; ` +
          "the after_create hook did not clone a repository.",
      );
    }

    // Mark workspace as successfully initialized
    if (isNew) {
      await writeFile(readyMarker, new Date().toISOString());
    }

    await copyWorkspaceAssets(workspacePath, this.config);

    this.createdPaths.add(workspacePath);
    return workspacePath;
  }

  /**
   * Remove a workspace directory — DISABLED. Worktrees are never deleted.
   * Kept as a no-op for callers that reference it.
   */
  async removeWorkspace(_workspacePath: string): Promise<void> {
    // Intentionally a no-op. Worktrees must never be deleted.
  }

  /** See {@link cleanupCompletedWorkspaceImpl}. Kept thin for the 400-line arch cap. */
  async cleanupCompletedWorkspace(
    workspacePath: string,
    options: { minAgeMs?: number } = {},
  ): Promise<CleanupWorkspaceResult> {
    const result = await cleanupCompletedWorkspaceImpl(
      workspacePath,
      {
        validatePath: (p) => this.validatePath(p),
        runBeforeRemoveHook: this.config.hooks.before_remove
          ? (p) => this.runHook("before_remove", p).then(() => undefined)
          : null,
      },
      options,
    );
    if (result.removed) this.createdPaths.delete(workspacePath);
    return result;
  }

  /** Run a named lifecycle hook in the workspace directory. */
  async runHook(
    hookName: keyof WorkspaceConfig["hooks"],
    workspacePath: string,
    issueEnv?: Record<string, string>,
  ): Promise<void> {
    const command = this.config.hooks[hookName];
    if (!command) return;

    const timeout = this.config.hookTimeoutMs ?? 300_000; // 5 min default

    try {
      // Async exec (not execSync) so a slow hook can't freeze the event loop.
      await promisify(exec)(command, {
        cwd: workspacePath,
        shell: "/bin/sh",
        timeout,
        maxBuffer: 64 * 1024 * 1024, // clone+install stdout exceeds the 1MB default (ENOBUFS)
        env: {
          ...(this.config.hookBaseEnv?.() ?? process.env),
          WORKSPACE_PATH: workspacePath,
          ...issueEnv,
        },
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Hook '${hookName}' failed in ${workspacePath}: ${msg}`);
    }
  }

  /** Write MCP config file for agent to use in the workspace. */
  async writeMcpConfig(
    workspacePath: string,
    mcpServers: Record<string, unknown>,
  ): Promise<string> {
    return writeMcpConfigFile(workspacePath, mcpServers);
  }

  /**
   * Take the issue's workspace dispatch lock; usable before {@link ensureWorkspace}.
   * Holding it, stop whatever earlier runs left running in the workspace (a dev
   * server on the port the agent wants), and again on release, after the agent.
   */
  async acquireLock(issue: NormalizedIssue | string): Promise<WorkspaceLockResult> {
    const workspacePath = await this.resolveWorkspacePath(issue);
    await mkdir(this.config.root, { recursive: true });
    const result = await acquireWorkspaceLock(workspacePath);
    if (!result.acquired) return result;
    const stop = () =>
      (this.config.stopLeftovers ?? defaultStopLeftovers)(this.config.root, basename(workspacePath))
        .then(() => undefined)
        .catch(() => undefined);
    await stop();
    const { lock } = result;
    const release = async () => {
      await stop();
      await lock.release();
    };
    return { acquired: true, lock: { recordAgentPid: (pid) => lock.recordAgentPid(pid), release } };
  }

  /** The live holder of the issue's workspace dispatch lock, or `null` when free. */
  async lockHolder(issue: NormalizedIssue | string) {
    return liveLockHolder(await this.resolveWorkspacePath(issue));
  }

  /** Validated `<root>/<safe id>`; the raw identifier is checked for traversal too. */
  private async resolveWorkspacePath(issue: NormalizedIssue | string): Promise<string> {
    const identifier = typeof issue === "string" ? issue : issue.identifier;
    await this.validatePath(join(this.config.root, identifier));
    const workspacePath = join(this.config.root, this.toSafeId(identifier));
    await this.validatePath(workspacePath);
    return workspacePath;
  }

  /** Workspace directory name: characters outside `[A-Za-z0-9._-]` become `_`. */
  toSafeId(identifier: string): string {
    return identifier.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  /**
   * Validate that a workspace path is safe:
   * - Must be under the configured root
   * - Must not equal the root
   * - No symlink escape
   */
  private async validatePath(workspacePath: string): Promise<void> {
    const canonicalRoot = resolve(this.config.root);
    const canonicalWorkspace = resolve(workspacePath);

    if (canonicalWorkspace === canonicalRoot) {
      throw new Error(`Workspace path cannot be the root directory: ${canonicalWorkspace}`);
    }

    if (!canonicalWorkspace.startsWith(`${canonicalRoot}/`)) {
      throw new Error(
        `Workspace path escapes root: ${canonicalWorkspace} is not under ${canonicalRoot}`,
      );
    }

    // Check for symlink escape if the path exists
    if (await this.pathExists(workspacePath)) {
      const realPath = await this.resolveSymlinks(workspacePath);
      const realRoot = await this.resolveSymlinks(this.config.root);

      if (!realPath.startsWith(`${realRoot}/`) && realPath !== realRoot) {
        throw new Error(
          `Symlink escape detected: ${workspacePath} resolves to ${realPath} which is outside ${realRoot}`,
        );
      }
    }
  }

  /**
   * Resolve symlinks to their real path.
   */
  private async resolveSymlinks(targetPath: string): Promise<string> {
    try {
      return await realpath(targetPath);
    } catch {
      return resolve(targetPath);
    }
  }

  /** fs/promises has no `exists`; use stat and swallow ENOENT. */
  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await stat(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}

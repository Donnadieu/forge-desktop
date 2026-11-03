import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The commit identity agents use inside a workspace, taken from the operator's
 * environment (twelve-factor: no name, email or key id lives in a committed
 * file — the operator sets them in a git-ignored `.env`).
 *
 * Why this exists: nothing used to give a workspace its own identity, so every
 * agent commit fell through to the operator's global `~/.gitconfig`. On a host
 * whose global config signs with an SSH key under `~/.ssh` (which the agent
 * can't read), every commit went out unsigned under whatever name that global
 * config happened to hold.
 *
 * Contract (shared with `agent/child-env.ts`, which re-reads the same keys —
 * workspace must not import agent, see the dependency rules):
 *   - FORGE_GIT_AUTHOR_NAME + FORGE_GIT_AUTHOR_EMAIL — both required to opt in.
 *   - FORGE_GIT_SIGNING_KEY — optional GPG key id. Signing goes through the
 *     host's own gpg-agent; the private key is never read, copied or printed.
 */
export interface WorkspaceGitIdentity {
  name: string;
  email: string;
  signingKey?: string;
}

/** The identity the env asks for, or `undefined` when the operator set none. */
export function resolveWorkspaceGitIdentity(
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceGitIdentity | undefined {
  const name = env.FORGE_GIT_AUTHOR_NAME?.trim();
  const email = env.FORGE_GIT_AUTHOR_EMAIL?.trim();
  if (!name || !email) return undefined;
  const signingKey = env.FORGE_GIT_SIGNING_KEY?.trim();
  return signingKey ? { name, email, signingKey } : { name, email };
}

/**
 * Write the env-configured identity into the workspace's LOCAL git config
 * (never the operator's global one). A no-op when the env sets no identity or
 * the workspace isn't a git checkout yet, so unconfigured hosts keep exactly
 * the behavior they had. Idempotent: `git config --local` overwrites.
 *
 * Failures throw on purpose: a workspace that can't take its identity would
 * otherwise commit under the wrong name or unsigned without anyone noticing.
 */
export function configureWorkspaceGitIdentity(
  workspacePath: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const identity = resolveWorkspaceGitIdentity(env);
  if (!identity || !existsSync(join(workspacePath, ".git"))) return;

  const set = (key: string, value: string) =>
    execFileSync("git", ["config", "--local", key, value], { cwd: workspacePath, stdio: "pipe" });

  set("user.name", identity.name);
  set("user.email", identity.email);
  if (!identity.signingKey) return;

  set("user.signingkey", identity.signingKey);
  set("gpg.format", "openpgp");
  set("commit.gpgsign", "true");
}

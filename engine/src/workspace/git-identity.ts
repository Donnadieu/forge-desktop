import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
 *   - FORGE_GIT_SIGNING_KEY — optional GPG key id, or (with
 *     FORGE_GIT_SIGNING_FORMAT=ssh) the path of the public half of an SSH key
 *     the Mac's ssh-agent holds. Signing goes through the host's own agent; the
 *     private key is never read, copied or printed.
 *   - FORGE_GIT_UNSIGNED_OK=1 — the person chose unsigned commits. Without it, an
 *     identity with no signing key never starts a card.
 */
export interface WorkspaceGitIdentity {
  name: string;
  email: string;
  signingKey?: string;
  /** "openpgp" (a GPG key id) or "ssh" (the public key's path). */
  format?: "openpgp" | "ssh";
}

/** The identity the env asks for, or `undefined` when the operator set none. */
export function resolveWorkspaceGitIdentity(
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceGitIdentity | undefined {
  const name = env.FORGE_GIT_AUTHOR_NAME?.trim();
  const email = env.FORGE_GIT_AUTHOR_EMAIL?.trim();
  if (!name || !email) return undefined;
  const signingKey = env.FORGE_GIT_SIGNING_KEY?.trim();
  if (!signingKey) return { name, email };
  const format = env.FORGE_GIT_SIGNING_FORMAT?.trim() === "ssh" ? "ssh" : "openpgp";
  return format === "ssh" ? { name, email, signingKey, format } : { name, email, signingKey };
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
  set("gpg.format", identity.format ?? "openpgp");
  set("commit.gpgsign", "true");
}

const verified = new Map<string, number>();
const VERIFY_TTL_MS = 10 * 60 * 1000;

/**
 * Before a card starts: does the chosen key really sign? One signed commit in a
 * scratch repo (plan section 6). Throws, so the card never starts, when the key
 * doesn't sign, or when commits would go out unsigned without the person having
 * chosen that (FORGE_GIT_UNSIGNED_OK). A pass is remembered for ten minutes.
 */
export function verifyWorkspaceSigning(env: NodeJS.ProcessEnv = process.env): void {
  const identity = resolveWorkspaceGitIdentity(env);
  if (!identity) return;
  if (!identity.signingKey) {
    if (env.FORGE_GIT_UNSIGNED_OK === "1") return;
    throw new Error(
      "Forge didn't start this card: its commits would go out unsigned, and unsigned wasn't chosen in setup.",
    );
  }
  const cacheKey = `${identity.format ?? "openpgp"}:${identity.signingKey}:${env.SSH_AUTH_SOCK ?? ""}`;
  if (Date.now() - (verified.get(cacheKey) ?? 0) < VERIFY_TTL_MS) return;
  const dir = mkdtempSync(join(tmpdir(), "forge-sign-check-"));
  try {
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        stdio: "pipe",
        env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      }).toString();
    git(["init", "-q"]);
    git(["config", "--local", "user.name", identity.name]);
    git(["config", "--local", "user.email", identity.email]);
    git(["config", "--local", "user.signingkey", identity.signingKey]);
    git(["config", "--local", "gpg.format", identity.format ?? "openpgp"]);
    git(["commit", "-q", "-S", "--allow-empty", "-m", "Forge signing check"]);
    const signed =
      identity.format === "ssh"
        ? git(["cat-file", "commit", "HEAD"]).includes("-----BEGIN SSH SIGNATURE-----")
        : ["G", "U"].includes(git(["log", "-1", "--format=%G?"]).trim());
    if (!signed) throw new Error("no signature on the test commit");
    verified.set(cacheKey, Date.now());
  } catch (err) {
    const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new Error(
      `Forge didn't start this card: the signing key didn't sign a test commit (${why}). Check it in setup.`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

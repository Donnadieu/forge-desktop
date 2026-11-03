/**
 * Agent commit identity comes from the operator's env (twelve-factor), lands in
 * the workspace's LOCAL git config only, and does nothing when unset.
 *
 * The bug this guards: no workspace had an identity of its own, so agents
 * inherited the operator's global git config, whose SSH signing key under
 * `~/.ssh` the agent can't read — and every commit went out unsigned.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { copyWorkspaceAssets } from "../../../src/workspace/copy-assets.js";
import {
  configureWorkspaceGitIdentity,
  resolveWorkspaceGitIdentity,
} from "../../../src/workspace/git-identity.js";

const IDENTITY_ENV = {
  FORGE_GIT_AUTHOR_NAME: "Test Agent",
  FORGE_GIT_AUTHOR_EMAIL: "agent@example.test",
  FORGE_GIT_SIGNING_KEY: "TEST-SIGNING-KEY",
};

let root: string;
let ws: string;

function localConfig(key: string): string | undefined {
  const r = spawnSync("git", ["config", "--local", "--get", key], { cwd: ws });
  return r.status === 0 ? r.stdout.toString().trim() : undefined;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-git-identity-"));
  ws = join(root, "ws");
  mkdirSync(ws);
  execFileSync("git", ["init", "-q"], { cwd: ws });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("resolveWorkspaceGitIdentity", () => {
  it("has no built-in default: an empty env yields no identity", () => {
    expect(resolveWorkspaceGitIdentity({})).toBeUndefined();
  });

  it("needs both name and email", () => {
    expect(resolveWorkspaceGitIdentity({ FORGE_GIT_AUTHOR_NAME: "A" })).toBeUndefined();
    expect(resolveWorkspaceGitIdentity({ FORGE_GIT_AUTHOR_EMAIL: "a@b.test" })).toBeUndefined();
    expect(
      resolveWorkspaceGitIdentity({
        FORGE_GIT_AUTHOR_NAME: " ",
        FORGE_GIT_AUTHOR_EMAIL: "a@b.test",
      }),
    ).toBeUndefined();
  });

  it("returns exactly what the env says", () => {
    expect(resolveWorkspaceGitIdentity(IDENTITY_ENV)).toEqual({
      name: "Test Agent",
      email: "agent@example.test",
      signingKey: "TEST-SIGNING-KEY",
    });
    const other = { FORGE_GIT_AUTHOR_NAME: "Someone Else", FORGE_GIT_AUTHOR_EMAIL: "x@y.test" };
    expect(resolveWorkspaceGitIdentity(other)).toEqual({ name: "Someone Else", email: "x@y.test" });
  });
});

describe("configureWorkspaceGitIdentity", () => {
  it("does nothing when the env sets no identity (current behavior kept)", () => {
    configureWorkspaceGitIdentity(ws, {});
    for (const key of [
      "user.name",
      "user.email",
      "user.signingkey",
      "gpg.format",
      "commit.gpgsign",
    ]) {
      expect(localConfig(key), key).toBeUndefined();
    }
  });

  it("writes name, email and GPG signing to the workspace's local config", () => {
    configureWorkspaceGitIdentity(ws, IDENTITY_ENV);
    expect(localConfig("user.name")).toBe("Test Agent");
    expect(localConfig("user.email")).toBe("agent@example.test");
    expect(localConfig("user.signingkey")).toBe("TEST-SIGNING-KEY");
    expect(localConfig("gpg.format")).toBe("openpgp");
    expect(localConfig("commit.gpgsign")).toBe("true");
  });

  it("sets only name and email when no signing key is given", () => {
    const { FORGE_GIT_SIGNING_KEY: _unused, ...noKey } = IDENTITY_ENV;
    configureWorkspaceGitIdentity(ws, noKey);
    expect(localConfig("user.name")).toBe("Test Agent");
    expect(localConfig("user.signingkey")).toBeUndefined();
    expect(localConfig("commit.gpgsign")).toBeUndefined();
  });

  it("skips a workspace that isn't a git checkout yet", () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(() => configureWorkspaceGitIdentity(plain, IDENTITY_ENV)).not.toThrow();
  });

  it("is applied on every workspace preparation from process.env", async () => {
    for (const [k, v] of Object.entries(IDENTITY_ENV)) vi.stubEnv(k, v);
    // A made-up key can't sign, so the card must not start: the identity is still written first.
    await expect(copyWorkspaceAssets(ws, {})).rejects.toThrow(/didn't start this card/);
    expect(localConfig("user.name")).toBe("Test Agent");
    expect(localConfig("user.signingkey")).toBe("TEST-SIGNING-KEY");
  });
});

const hasGpg = spawnSync("gpg", ["--version"]).status === 0;

describe.skipIf(!hasGpg)("a commit in the configured workspace is GPG-signed", () => {
  it("shows a good signature from the env's key", () => {
    // Short path on purpose: gpg-agent's socket lives in GNUPGHOME, and a deep
    // TMPDIR (the gate's .context/tmp) overflows the socket-path limit.
    const gnupgHome = mkdtempSync("/tmp/forge-gpg-");
    onTestFinished(() => {
      spawnSync("gpgconf", ["--kill", "gpg-agent"], { env: gpgEnv });
      rmSync(gnupgHome, { recursive: true, force: true });
    });
    const gpgEnv = { ...process.env, GNUPGHOME: gnupgHome };
    execFileSync(
      "gpg",
      [
        "--batch",
        "--passphrase",
        "",
        "--quick-gen-key",
        "Test Agent <agent@example.test>",
        "ed25519",
        "sign",
        "1d",
      ],
      { env: gpgEnv, stdio: "pipe" },
    );
    const keyId = execFileSync("gpg", ["--list-secret-keys", "--with-colons"], { env: gpgEnv })
      .toString()
      .split("\n")
      .find((line) => line.startsWith("sec:"))
      ?.split(":")[4];
    expect(keyId).toBeTruthy();

    configureWorkspaceGitIdentity(ws, { ...IDENTITY_ENV, FORGE_GIT_SIGNING_KEY: keyId });
    writeFileSync(join(ws, "a.txt"), "a");
    execFileSync("git", ["add", "a.txt"], { cwd: ws, env: gpgEnv });
    execFileSync("git", ["commit", "-q", "-m", "signed"], { cwd: ws, env: gpgEnv });

    const log = execFileSync("git", ["log", "-1", "--format=%G?|%GK|%an <%ae>"], {
      cwd: ws,
      env: gpgEnv,
    }).toString();
    expect(log.trim()).toBe(`G|${keyId}|Test Agent <agent@example.test>`);
  });
});

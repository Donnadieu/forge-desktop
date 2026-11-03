/**
 * Before a card starts, Forge checks the chosen key really signs (plan section 6),
 * and a card never starts if its commits would go out unsigned without that being chosen.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyWorkspaceSigning } from "../../../src/workspace/git-identity.js";

const who = { FORGE_GIT_AUTHOR_NAME: "Test Agent", FORGE_GIT_AUTHOR_EMAIL: "agent@example.test" };

describe("the signing check before a card starts", () => {
  it("does nothing when no identity is set", () => {
    expect(() => verifyWorkspaceSigning({})).not.toThrow();
  });

  it("refuses unsigned commits nobody chose", () => {
    expect(() => verifyWorkspaceSigning({ ...who })).toThrow(/unsigned wasn't chosen/);
  });

  it("allows unsigned commits when they were chosen", () => {
    expect(() => verifyWorkspaceSigning({ ...who, FORGE_GIT_UNSIGNED_OK: "1" })).not.toThrow();
  });

  it("refuses a key that can't sign", () => {
    const env = {
      ...process.env,
      ...who,
      FORGE_GIT_SIGNING_KEY: "NO-SUCH-KEY-1",
      GNUPGHOME: tmpdir(),
    };
    expect(() => verifyWorkspaceSigning(env)).toThrow(/didn't sign a test commit/);
  });
});

const hasSsh =
  spawnSync("ssh-agent", ["-h"]).error === undefined &&
  spawnSync("ssh-keygen", ["-?"]).error === undefined;

describe.skipIf(!hasSsh)("an SSH key held only by an agent signs", () => {
  let dir: string;
  let agent: { sock: string; pid: string };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-ssh-sign-"));
    const sock = join(dir, "agent.sock");
    const out = execFileSync("ssh-agent", ["-s", "-a", sock]).toString();
    agent = { sock, pid: out.match(/SSH_AGENT_PID=(\d+)/)?.[1] ?? "" };
    const key = join(dir, "k");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "forge-test", "-f", key]);
    execFileSync("ssh-add", ["-q", key], { env: { ...process.env, SSH_AUTH_SOCK: sock } });
    rmSync(key); // only the agent holds the private half now
  });

  afterAll(() => {
    if (agent.pid) process.kill(Number(agent.pid));
    rmSync(dir, { recursive: true, force: true });
  });

  it("signs a test commit through the agent with only the public half on disk", () => {
    const env = {
      ...process.env,
      ...who,
      SSH_AUTH_SOCK: agent.sock,
      FORGE_GIT_SIGNING_FORMAT: "ssh",
      FORGE_GIT_SIGNING_KEY: join(dir, "k.pub"),
    };
    expect(() => verifyWorkspaceSigning(env)).not.toThrow();
  });

  it("refuses when the agent no longer holds the key", () => {
    const env = {
      ...process.env,
      ...who,
      SSH_AUTH_SOCK: join(dir, "no-agent.sock"),
      FORGE_GIT_SIGNING_FORMAT: "ssh",
      FORGE_GIT_SIGNING_KEY: join(dir, "k.pub"),
    };
    expect(() => verifyWorkspaceSigning(env)).toThrow(/didn't sign/);
  });
});

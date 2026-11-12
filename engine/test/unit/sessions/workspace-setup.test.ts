import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionsHost } from "../../../src/sessions/host.js";
import { SessionStore } from "../../../src/sessions/store.js";
import type { SessionRecord } from "../../../src/sessions/types.js";
import {
  copyFiles,
  maskSecrets,
  parseSetup,
  SECRET_MASK,
} from "../../../src/sessions/workspace-setup.js";

const FAKE = join(import.meta.dirname, "../../fixtures/sessions/fake-claude.mjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SECRET = "sk_test_never_on_disk_8f3a91";

const g = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf-8" },
  ).trim();

/** Every file under `dir`, read as bytes, so a test can look for a value anywhere on disk. */
function everyFile(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...everyFile(p));
    else out.push(p);
  }
  return out;
}

describe("workspace setup for new sessions", { timeout: 30_000 }, () => {
  let dir: string;
  let home: string;
  let local: string;
  let store: SessionStore;
  let host: SessionsHost;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-ws-setup-"));
    home = join(dir, "home");
    mkdirSync(home);
    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    local = join(dir, "local");
    execFileSync("git", ["clone", "-q", origin, local]);
    writeFileSync(join(local, ".gitignore"), "config/master.key\nstorage/\n.env\n");
    mkdirSync(join(local, "config"));
    writeFileSync(join(local, "config", "app.yml"), "tracked: true\n");
    g(local, "add", ".");
    g(local, "commit", "-q", "-m", "start");
    g(local, "push", "-q", "origin", "HEAD:main");
    // What git ignores, only in the person's checkout.
    writeFileSync(join(local, "config", "master.key"), "abc123\n");
    mkdirSync(join(local, "storage", "seeds"), { recursive: true });
    writeFileSync(join(local, "storage", "seeds", "one.sql"), "select 1;\n");
    writeFileSync(join(local, ".env"), "A=1\n");
    writeFileSync(join(local, "config", "app.yml"), "tracked: changed locally\n");
    store = new SessionStore(join(home, "sessions.sqlite"));
    host = new SessionsHost(store, {
      home,
      command: FAKE,
      notify: () => {},
      account: async () => null,
    });
  });

  afterEach(async () => {
    await host.chats.closeAll();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const create = async (message = "hello") => {
    const r = await host.create({
      workspaceId: "w1",
      repo: "acme/app",
      local,
      base: "main",
      prefix: "",
      message,
      model: "haiku",
      effort: "low",
    });
    expect(r.problem).toBeUndefined();
    return r.session as SessionRecord;
  };

  async function until(what: () => boolean, label: string, ms = 8000) {
    for (let i = 0; i < ms / 50; i++) {
      if (what()) return;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  const firstAnswer = (sessionId: string) => {
    const chat = store.chats(sessionId)[0];
    const t = chat ? store.turns(chat.id, null, 10)[0] : undefined;
    return t?.status === "done" ? (t.events.at(-1)?.text ?? "") : "";
  };

  it("copies the listed git-ignored files and folders into every new session's folder", async () => {
    host.setWorkspaceSetup(
      "w1",
      parseSetup({ copy: ["config/master.key", "storage/", "../outside", "config/app.yml"] }),
    );
    const s = await create();
    expect(readFileSync(join(s.folder, "config", "master.key"), "utf-8")).toBe("abc123\n");
    expect(readFileSync(join(s.folder, "storage", "seeds", "one.sql"), "utf-8")).toBe(
      "select 1;\n",
    );
    // .env files still come along by themselves.
    expect(existsSync(join(s.folder, ".env"))).toBe(true);
    // A tracked file keeps the branch's version, and nothing outside the repo is reached.
    expect(readFileSync(join(s.folder, "config", "app.yml"), "utf-8")).toBe("tracked: true\n");
    expect(existsSync(join(dir, "outside"))).toBe(false);
  });

  it("never copies a path that leaves the checkout", () => {
    const to = join(dir, "to");
    mkdirSync(to);
    const r = copyFiles(local, to, ["../origin.git", "/etc/hosts", "config/master.key"]);
    expect(r.copied).toEqual(["config/master.key"]);
    expect(r.skipped.sort()).toEqual(["../origin.git", "/etc/hosts"]);
  });

  it("runs the setup script in the new folder with the workspace's environment, then the agent starts", async () => {
    host.setWorkspaceSetup(
      "w1",
      parseSetup({
        setup:
          'pwd; echo "mode=$APP_MODE"; echo "root=$FORGE_ROOT_PATH"; test -f config/master.key && echo copied-first',
        copy: ["config/master.key"],
        env: { APP_MODE: "dev" },
      }),
    );
    const s = await create();
    await until(() => store.session(s.id)?.setup?.state === "done", "the setup script");
    const run = store.session(s.id)?.setup;
    expect(run?.exitCode).toBe(0);
    expect(run?.output).toContain(s.folder.split("/").at(-1));
    expect(run?.output).toContain("mode=dev");
    expect(run?.output).toContain(`root=${local}`);
    expect(run?.output).toContain("copied-first");
    await until(() => firstAnswer(s.id) !== "", "the first turn");
    expect(firstAnswer(s.id)).toBe("answer: hello");
  });

  it("shows a failed setup script plainly and still starts the agent", async () => {
    host.setWorkspaceSetup("w1", parseSetup({ setup: "echo 'bundle: no gem pg' >&2; exit 3" }));
    const s = await create();
    await until(() => store.session(s.id)?.setup?.state === "failed", "the failed setup");
    const run = store.session(s.id)?.setup;
    expect(run?.exitCode).toBe(3);
    expect(run?.output).toContain("bundle: no gem pg");
    await until(() => firstAnswer(s.id) !== "", "the first turn after a failed setup");
    expect(firstAnswer(s.id)).toBe("answer: hello");
  });

  it("runs the cleanup script in the session's folder with the environment when it's archived", async () => {
    const marker = join(dir, "cleaned.txt");
    host.setWorkspaceSetup(
      "w1",
      parseSetup({
        cleanup: `pwd > "${marker}"; echo "$APP_MODE" >> "${marker}"`,
        env: { APP_MODE: "dev" },
      }),
    );
    const s = await create();
    await until(() => firstAnswer(s.id) !== "", "the first turn");
    expect((await host.archive(s.id)).ok).toBe(true);
    const lines = readFileSync(marker, "utf-8").trim().split("\n");
    expect(lines[0]?.endsWith(s.folder.split("/").at(-1) ?? "?")).toBe(true);
    expect(lines[1]).toBe("dev");
    expect(store.session(s.id)?.cleanup?.state).toBe("done");
    expect(existsSync(s.folder)).toBe(false);
  });

  it("gives every agent the workspace's variables", async () => {
    host.setWorkspaceSetup("w1", parseSetup({ env: { APP_MODE: "dev" } }));
    const s = await create("printenv APP_MODE");
    await until(() => firstAnswer(s.id) !== "", "the first turn");
    expect(firstAnswer(s.id)).toBe("env APP_MODE=dev");
  });

  it("never writes a secret variable to disk, and masks it in what the setup prints", async () => {
    host.setWorkspaceSetup(
      "w1",
      parseSetup({
        setup:
          'echo "key is $STRIPE_KEY"; test "$STRIPE_KEY" = "' + SECRET + '" && echo has-secret',
        env: { STRIPE_KEY: SECRET },
        secrets: ["STRIPE_KEY"],
      }),
    );
    const s = await create("printenv STRIPE_KEY");
    await until(() => firstAnswer(s.id) !== "", "the first turn");
    const run = store.session(s.id)?.setup;
    expect(run?.output).toContain(`key is ${SECRET_MASK}`);
    expect(run?.output).toContain("has-secret");
    // The agent had it.
    expect(firstAnswer(s.id)).toBe(`env STRIPE_KEY=${SECRET_MASK}`);
    await host.archive(s.id);
    store.close();
    for (const f of everyFile(home)) {
      expect(readFileSync(f).includes(Buffer.from(SECRET)), f).toBe(false);
    }
    store = new SessionStore(join(home, "sessions.sqlite"));
  });

  it("masks every secret's value in a text", () => {
    const setup = parseSetup({ env: { A: "tok-123", B: "plain" }, secrets: ["A"] });
    expect(maskSecrets("tok-123 and plain", setup)).toBe(`${SECRET_MASK} and plain`);
  });
});

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it, onTestFinished } from "vitest";
import { fdWalk, TreeWalk } from "../../../src/agent/kimi-tree.js";
import { flushUsage, MAX_WIRE_READ, type UsageWireState } from "../../../src/agent/kimi-usage.js";

// FRG-5154: KIMI_CODE_HOME is written by the agent, so a planted FIFO, symlink
// or hard link must be skipped — never block the event loop or leave the tree.

const USAGE = `${JSON.stringify({ type: "usage.record", usage: { inputOther: 7, output: 3 } })}\n`;
const logger = pino({ level: "silent" });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A KIMI_CODE_HOME with one session for `cwd`; returns the session's agents dir. */
function seedSession(home: string, cwd: string): string {
  const session = join(home, "sessions", "wd_x", "session-1");
  mkdirSync(join(session, "agents"), { recursive: true });
  writeFileSync(join(session, "state.json"), JSON.stringify({ cwd }));
  return join(session, "agents");
}

function state(home: string, workspacePath: string): UsageWireState {
  return {
    workspacePath,
    kimiSessionId: null,
    sessionDir: null,
    wireOffsets: new Map(),
    contractWarned: false,
    kimiCodeHome: home,
  };
}

const totals = (s: UsageWireState) =>
  [...flushUsage(s, logger)].reduce(
    (sum, e) => sum + (e.type === "usage" ? e.inputTokens + e.outputTokens : 0),
    0,
  );

describe("flushUsage on an agent-written session tree (FRG-5154)", () => {
  it("counts a plain wire.jsonl and skips a FIFO, a symlink and a hard link beside it", () => {
    const home = tempDir("kimi-usage-");
    const outside = tempDir("kimi-outside-");
    const repo = tempDir("kimi-repo-");
    const agents = seedSession(home, repo);
    mkdirSync(join(agents, "main"));
    writeFileSync(join(agents, "main", "wire.jsonl"), USAGE);

    mkdirSync(join(agents, "fifo"));
    execFileSync("mkfifo", [join(agents, "fifo", "wire.jsonl")]);
    // Separate targets, so the symlink's (single-name) target is refused by O_NOFOLLOW alone.
    writeFileSync(join(outside, "symlinked.jsonl"), USAGE.repeat(5));
    mkdirSync(join(agents, "symlink"));
    symlinkSync(join(outside, "symlinked.jsonl"), join(agents, "symlink", "wire.jsonl"));
    writeFileSync(join(outside, "hardlinked.jsonl"), USAGE.repeat(5));
    mkdirSync(join(agents, "hardlink"));
    linkSync(join(outside, "hardlinked.jsonl"), join(agents, "hardlink", "wire.jsonl"));
    // A symlinked agent dir is not listed at all.
    mkdirSync(join(outside, "agent"));
    writeFileSync(join(outside, "agent", "wire.jsonl"), USAGE.repeat(5));
    symlinkSync(join(outside, "agent"), join(agents, "linked-dir"));

    expect(totals(state(home, repo))).toBe(10);
  });

  it("does not resolve a session through a symlinked state.json or sessions dir", () => {
    const repo = tempDir("kimi-repo-");
    const outside = tempDir("kimi-outside-");
    const statePath = join(outside, "state.json");
    writeFileSync(statePath, JSON.stringify({ cwd: repo }));

    const home = tempDir("kimi-usage-");
    const agents = seedSession(home, repo);
    const sessionState = join(agents, "..", "state.json");
    rmSync(sessionState);
    symlinkSync(statePath, sessionState);
    mkdirSync(join(agents, "main"));
    writeFileSync(join(agents, "main", "wire.jsonl"), USAGE);
    expect(totals(state(home, repo))).toBe(0);

    rmSync(sessionState);
    writeFileSync(sessionState, JSON.stringify({ cwd: repo }));
    const linkedHome = tempDir("kimi-linked-");
    symlinkSync(join(home, "sessions"), join(linkedHome, "sessions"));
    expect(totals(state(linkedHome, repo))).toBe(0);
    expect(totals(state(home, repo))).toBe(10);
  });

  it("never resolves a stdout session id that names a path outside its wd dir", () => {
    const home = tempDir("kimi-usage-");
    const agents = seedSession(home, "/nonexistent/other-repo");
    mkdirSync(join(agents, "main"));
    writeFileSync(join(agents, "main", "wire.jsonl"), USAGE);
    const s = { ...state(home, tempDir("kimi-repo-")), kimiSessionId: "../wd_x/session-1" };
    expect(totals(s)).toBe(0);
    expect(totals({ ...s, kimiSessionId: "." })).toBe(0);
    expect(totals({ ...s, kimiSessionId: ".." })).toBe(0);
    expect(totals({ ...s, kimiSessionId: "session-1" })).toBe(10);
  });

  it("skips past a newline-free record longer than one read instead of re-reading it", () => {
    const home = tempDir("kimi-usage-");
    const repo = tempDir("kimi-repo-");
    const agents = seedSession(home, repo);
    mkdirSync(join(agents, "main"));
    writeFileSync(join(agents, "main", "wire.jsonl"), `${"x".repeat(MAX_WIRE_READ + 10)}\n`);
    const s = state(home, repo);

    expect(totals(s)).toBe(0);
    expect([...s.wireOffsets.values()]).toEqual([MAX_WIRE_READ]);
    appendFileSync(join(agents, "main", "wire.jsonl"), USAGE);
    expect(totals(s)).toBe(10);
  });
});

// FRG-5676: a Smith's root orchestrator reads usage from a tree its dropped kimi
// child owns, so no path component (not just the last) may redirect the read.
describe.skipIf(!fdWalk())("flushUsage walks every path component by fd (FRG-5676)", () => {
  /** A home whose session (resolved by cwd) has one main agent with one usage line. */
  function seeded() {
    const home = tempDir("kimi-usage-");
    const repo = tempDir("kimi-repo-");
    const agents = seedSession(home, repo);
    mkdirSync(join(agents, "main"));
    writeFileSync(join(agents, "main", "wire.jsonl"), USAGE);
    return { home, repo, agents };
  }

  /** An outside copy of the session layout holding more usage, swapped in by symlink. */
  function outsideSession(): string {
    const outside = tempDir("kimi-outside-");
    const agents = seedSession(outside, "/elsewhere");
    mkdirSync(join(agents, "main"));
    writeFileSync(join(agents, "main", "wire.jsonl"), USAGE.repeat(5));
    return outside;
  }

  it("stops reading once a resolved session's wd dir is swapped for a symlink", () => {
    const { home, repo } = seeded();
    const s = state(home, repo);
    expect(totals(s)).toBe(10);
    renameSync(join(home, "sessions", "wd_x"), join(home, "sessions", "wd_old"));
    symlinkSync(join(outsideSession(), "sessions", "wd_x"), join(home, "sessions", "wd_x"));
    expect(totals(s)).toBe(0);
  });

  it("does not follow a symlinked agents dir or a symlinked KIMI_CODE_HOME", () => {
    const { home, repo, agents } = seeded();
    const outside = outsideSession();
    rmSync(agents, { recursive: true });
    symlinkSync(join(outside, "sessions", "wd_x", "session-1", "agents"), agents);
    expect(totals(state(home, repo))).toBe(0);

    const other = seeded();
    const linkedHome = join(tempDir("kimi-linked-"), ".kimi-code");
    symlinkSync(other.home, linkedHome);
    expect(totals(state(linkedHome, other.repo))).toBe(0);
    expect(totals(state(other.home, other.repo))).toBe(10);
  });

  it("closes every directory it opens", () => {
    const { home, repo } = seeded();
    for (let i = 0; i < 20; i++)
      mkdirSync(join(home, "sessions", `wd_${i}`, "s", "agents"), { recursive: true });
    const before = readdirSync("/proc/self/fd").length;
    const s = state(home, repo);
    for (let i = 0; i < 5; i++) totals(s);
    totals(state(home, "/no/such/repo"));
    expect(readdirSync("/proc/self/fd").length).toBe(before);
  });

  it("release closes one directory at once, and ignores null or a repeat", () => {
    const walk = new TreeWalk();
    const dir = walk.root(tempDir("kimi-tree-"));
    const fd = Number(dir?.split("/").pop());
    expect(fstatSync(fd).isDirectory()).toBe(true);
    walk.release(dir);
    expect(() => fstatSync(fd)).toThrow();
    walk.release(dir);
    walk.release(null);
    walk.close();
  });
});

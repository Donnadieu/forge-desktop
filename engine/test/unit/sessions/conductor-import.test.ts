import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewImport, repoFromRemote, runImport } from "../../../src/sessions/conductor.js";
import { SessionStore } from "../../../src/sessions/store.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/** A small Conductor database: two workspaces on acme/app, one on acme/site, one archived. */
function conductorDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE repos (id TEXT, remote_url TEXT, default_branch TEXT, name TEXT, root_path TEXT);
    CREATE TABLE workspaces (id TEXT, repository_id TEXT, workspace_path TEXT, directory_name TEXT, branch TEXT,
      intended_target_branch TEXT, pr_title TEXT, workspace_name TEXT, state TEXT);
    CREATE TABLE sessions (id TEXT, workspace_id TEXT, claude_session_id TEXT, model TEXT, claude_effort_level TEXT,
      title TEXT, is_hidden INTEGER, agent_type TEXT, created_at TEXT);
    CREATE TABLE session_messages (session_id TEXT, role TEXT, content TEXT, turn_id TEXT, created_at TEXT,
      cancelled_at TEXT);
    INSERT INTO repos VALUES ('r1', 'git@github.com:acme/app.git', 'main', 'app', '/r/app'),
                             ('r2', 'https://github.com/acme/site', 'main', 'site', '/r/site');
    INSERT INTO workspaces VALUES
      ('w1', 'r1', '/c/app/paris', 'paris', 'omar/login', 'main', 'Fix the login', NULL, 'ready'),
      ('w2', 'r1', '/c/app/oslo', 'oslo', 'omar/billing', 'main', NULL, 'Billing page', 'ready'),
      ('w3', 'r2', '/c/site/rome', 'rome', 'omar/hero', 'main', 'New hero', NULL, 'ready'),
      ('w4', 'r1', '/c/app/old', 'old', 'omar/old', 'main', 'Old one', NULL, 'archived');
    INSERT INTO sessions VALUES
      ('c1', 'w1', 'cs1', 'opus', 'high', 'Chat', 0, 'claude', '2026-11-01'),
      ('c2', 'w1', 'cs2', 'opus', 'high', 'Review', 0, 'claude', '2026-11-02'),
      ('c3', 'w2', 'cs3', 'sonnet', 'high', 'Chat', 0, 'claude', '2026-11-03'),
      ('c4', 'w3', 'cs4', 'opus', 'high', 'Chat', 0, 'claude', '2026-11-04');
    INSERT INTO session_messages VALUES ('c1', 'user', 'Fix the login', 't1', '2026-11-01', NULL),
                                        ('c3', 'user', 'Add billing', 't2', '2026-11-03', NULL);
  `);
  db.close();
}

describe("bringing Conductor work into one workspace", () => {
  let dir: string;
  let db: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-conductor-"));
    db = join(dir, "conductor.db");
    conductorDb(db);
    store = new SessionStore(join(dir, "s.sqlite"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the repo from a remote that uses an SSH host alias (git@github.com-work:owner/name)", () => {
    expect(repoFromRemote("git@github.com-andela:andela-technology/andela.git")).toBe(
      "andela-technology/andela",
    );
    expect(repoFromRemote("git@github.com:acme/app.git")).toBe("acme/app");
    expect(repoFromRemote("https://github.com/acme/site")).toBe("acme/site");
  });

  it("lists only this workspace's repo, one row per Conductor workspace", () => {
    const p = previewImport(store, db, "Acme/App");
    expect(p.workspaces.map((w) => w.id)).toEqual(["w1", "w2"]);
    expect(p.workspaces[0]).toMatchObject({
      title: "Fix the login",
      branch: "omar/login",
      chats: 2,
      imported: false,
    });
    expect(p.repos.map((r) => r.repo)).toEqual(["acme/app"]);
    expect(p.sessions).toBe(2);
  });

  it("imports only the picked workspaces, into this workspace, once", () => {
    const r = runImport(store, { ids: ["w2"], workspace: "ws-app" }, db);
    expect(r.sessions).toBe(1);
    expect(store.session("conductor-w2")?.workspaceId).toBe("ws-app");
    expect(store.session("conductor-w1")).toBeFalsy();
    expect(store.session("conductor-w3")).toBeFalsy();
    expect(runImport(store, { ids: ["w2"], workspace: "ws-app" }, db).sessions).toBe(0);
    const p = previewImport(store, db, "acme/app");
    expect(p.workspaces.find((w) => w.id === "w2")?.imported).toBe(true);
  });
});

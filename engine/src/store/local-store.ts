/**
 * The engine's one local file: `forge.sqlite` in Forge's Application Support
 * folder. It keeps what must survive a restart: whether the person left the
 * board running or stopped, and a row per finished card run with its tokens
 * (the board's usage line reads these). Written only by the engine.
 *
 * New in Forge Desktop (Forge keeps this in Postgres). Uses Node's built-in
 * SQLite, so the bundle needs no native module.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

// Loaded through require: test tooling (Vite) can't resolve the newer `node:sqlite` builtin.
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

export type DesiredState = "running" | "stopped";

export interface RunRecord {
  issueId: string;
  identifier: string;
  outcome: string;
  startedAt: string;
  finishedAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UsageTotals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** A card waiting on the person (orchestrator/parking.ts), as kept in forge.sqlite. */
export interface ParkedRow {
  issueId: string;
  identifier: string;
  state: string;
  next: string | null;
  line: string;
  parkedAt: string;
}

export interface LocalStore {
  readDesired(): DesiredState;
  writeDesired(desired: DesiredState): void;
  recordRun(run: RunRecord): void;
  /** Token totals for runs that finished at or after `sinceIso` (all runs when omitted). */
  usageSince(sinceIso?: string): UsageTotals;
  /** Parked cards ("Waiting on you"), so they stay parked after a restart. */
  listParked(): ParkedRow[];
  putParked(card: ParkedRow): void;
  removeParked(issueId: string): void;
  /** Steps picked from the Orchestrator that wait to run (a card's stage with no column). */
  listStageRuns(): Array<{ issueId: string; stage: string }>;
  putStageRun(issueId: string, stage: string): void;
  removeStageRun(issueId: string): void;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS desired_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  desired TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  identifier TEXT NOT NULL,
  outcome TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_finished_at ON runs (finished_at);
CREATE TABLE IF NOT EXISTS parked_cards (
  issue_id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  state TEXT NOT NULL,
  next_stage TEXT,
  line TEXT NOT NULL,
  parked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stage_runs (
  issue_id TEXT PRIMARY KEY,
  stage TEXT NOT NULL
);
`;

export function openLocalStore(path: string): LocalStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

  const readDesired = db.prepare("SELECT desired FROM desired_state WHERE id = 1");
  const writeDesired = db.prepare(
    "INSERT INTO desired_state (id, desired, updated_at) VALUES (1, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET desired = excluded.desired, updated_at = excluded.updated_at",
  );
  const insertRun = db.prepare(
    "INSERT INTO runs (issue_id, identifier, outcome, started_at, finished_at, input_tokens, " +
      "output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const usage = db.prepare(
    "SELECT COUNT(*) AS runs, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o, " +
      "COALESCE(SUM(cache_read_tokens), 0) AS cr, COALESCE(SUM(cache_write_tokens), 0) AS cw " +
      "FROM runs WHERE finished_at >= ?",
  );

  const listParked = db.prepare(
    "SELECT issue_id, identifier, state, next_stage, line, parked_at FROM parked_cards ORDER BY parked_at",
  );
  const putParked = db.prepare(
    "INSERT INTO parked_cards (issue_id, identifier, state, next_stage, line, parked_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(issue_id) DO UPDATE SET identifier = excluded.identifier, state = excluded.state, " +
      "next_stage = excluded.next_stage, line = excluded.line, parked_at = excluded.parked_at",
  );
  const removeParked = db.prepare("DELETE FROM parked_cards WHERE issue_id = ?");
  const listRuns = db.prepare("SELECT issue_id, stage FROM stage_runs ORDER BY rowid");
  const putRun = db.prepare(
    "INSERT INTO stage_runs (issue_id, stage) VALUES (?, ?) ON CONFLICT(issue_id) DO UPDATE SET stage = excluded.stage",
  );
  const removeRun = db.prepare("DELETE FROM stage_runs WHERE issue_id = ?");

  return {
    listParked: () =>
      (listParked.all() as Array<Record<string, string | null>>).map((r) => ({
        issueId: String(r.issue_id),
        identifier: String(r.identifier),
        state: String(r.state),
        next: r.next_stage ?? null,
        line: String(r.line),
        parkedAt: String(r.parked_at),
      })),
    putParked: (c) => {
      putParked.run(c.issueId, c.identifier, c.state, c.next, c.line, c.parkedAt);
    },
    removeParked: (id) => {
      removeParked.run(id);
    },
    listStageRuns: () =>
      (listRuns.all() as Array<{ issue_id: string; stage: string }>).map((r) => ({
        issueId: String(r.issue_id),
        stage: String(r.stage),
      })),
    putStageRun: (id, stage) => {
      putRun.run(id, stage);
    },
    removeStageRun: (id) => {
      removeRun.run(id);
    },
    readDesired: () => {
      const row = readDesired.get() as { desired?: string } | undefined;
      return row?.desired === "running" ? "running" : "stopped";
    },
    writeDesired: (desired) => {
      writeDesired.run(desired, new Date().toISOString());
    },
    recordRun: (r) => {
      insertRun.run(
        r.issueId,
        r.identifier,
        r.outcome,
        r.startedAt,
        r.finishedAt,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
        r.cacheWriteTokens,
      );
    },
    usageSince: (sinceIso) => {
      const row = usage.get(sinceIso ?? "") as {
        runs: number;
        i: number;
        o: number;
        cr: number;
        cw: number;
      };
      return {
        runs: Number(row.runs),
        inputTokens: Number(row.i),
        outputTokens: Number(row.o),
        cacheReadTokens: Number(row.cr),
        cacheWriteTokens: Number(row.cw),
      };
    },
    close: () => db.close(),
  };
}

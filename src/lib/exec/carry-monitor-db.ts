/**
 * carry-monitor-db — the LOCAL (not cloud) persistence for the carry monitor. A single SQLite file that
 * lives on the My Passport drive (data off the full system disk). Stores one snapshot row per candidate per
 * run, plus an alert row whenever a candidate ESCALATES (off→watch→armed). better-sqlite3 is synchronous and
 * already a repo dependency. Path resolution: CARRY_DB_PATH env → else /Volumes/My Passport/hft-data/ if the
 * drive is mounted → else ./data (so tests + dev work without the drive). Pass ":memory:" for tests.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { TriggerState } from "./carry-triggers.ts";

const PASSPORT_DIR = "/Volumes/My Passport/hft-data";

/** Resolve where the DB file lives: explicit env → My Passport (if mounted) → local ./data fallback. */
export function resolveCarryDbPath(): string {
  if (process.env.CARRY_DB_PATH) return process.env.CARRY_DB_PATH;
  if (existsSync("/Volumes/My Passport")) return resolve(PASSPORT_DIR, "carry-monitor.db");
  return resolve(process.cwd(), "data", "carry-monitor.db");          // fallback (drive not mounted)
}

export type SnapshotRow = {
  ts: number; iso: string; strategy: string; venue: string; candidate: string;
  grossApr: number; netApr: number; persistence: number | null; basisBps: number | null;
  depthUsd: number | null; executable: boolean; state: TriggerState; reason: string; raw: unknown;
};
export type AlertRow = { ts: number; iso: string; strategy: string; candidate: string; prevState: TriggerState | null; newState: TriggerState; grossApr: number; netApr: number; message: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS carry_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, iso TEXT NOT NULL,
  strategy TEXT NOT NULL, venue TEXT NOT NULL, candidate TEXT NOT NULL,
  gross_apr REAL, net_apr REAL, persistence REAL, basis_bps REAL, depth_usd REAL,
  executable INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT, raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_snap_cand ON carry_snapshots(strategy, candidate, ts);
CREATE INDEX IF NOT EXISTS idx_snap_ts ON carry_snapshots(ts);
CREATE TABLE IF NOT EXISTS carry_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, iso TEXT NOT NULL,
  strategy TEXT, candidate TEXT, prev_state TEXT, new_state TEXT,
  gross_apr REAL, net_apr REAL, message TEXT
);`;

export type CarryDb = Database.Database;

/** Open (and migrate) the carry-monitor DB. Creates parent dirs. Pass an explicit path or ":memory:". */
export function openCarryDb(path: string = resolveCarryDbPath()): CarryDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

export function insertSnapshot(db: CarryDb, r: SnapshotRow): void {
  db.prepare(
    `INSERT INTO carry_snapshots (ts, iso, strategy, venue, candidate, gross_apr, net_apr, persistence, basis_bps, depth_usd, executable, state, reason, raw)
     VALUES (@ts,@iso,@strategy,@venue,@candidate,@grossApr,@netApr,@persistence,@basisBps,@depthUsd,@executable,@state,@reason,@raw)`,
  ).run({ ...r, executable: r.executable ? 1 : 0, raw: JSON.stringify(r.raw ?? null) });
}

/** The most recent recorded trigger state for a candidate (for escalation detection), or null if unseen. */
export function lastStateFor(db: CarryDb, strategy: string, candidate: string): TriggerState | null {
  const row = db.prepare(`SELECT state FROM carry_snapshots WHERE strategy=? AND candidate=? ORDER BY ts DESC LIMIT 1`).get(strategy, candidate) as { state: TriggerState } | undefined;
  return row?.state ?? null;
}

export function insertAlert(db: CarryDb, a: AlertRow): void {
  db.prepare(
    `INSERT INTO carry_alerts (ts, iso, strategy, candidate, prev_state, new_state, gross_apr, net_apr, message)
     VALUES (@ts,@iso,@strategy,@candidate,@prevState,@newState,@grossApr,@netApr,@message)`,
  ).run(a);
}

export function recentAlerts(db: CarryDb, limit = 20): AlertRow[] {
  return db.prepare(`SELECT ts, iso, strategy, candidate, prev_state as prevState, new_state as newState, gross_apr as grossApr, net_apr as netApr, message FROM carry_alerts ORDER BY ts DESC LIMIT ?`).all(limit) as AlertRow[];
}

export function snapshotCount(db: CarryDb): number {
  return (db.prepare(`SELECT COUNT(*) as n FROM carry_snapshots`).get() as { n: number }).n;
}

/**
 * wallet-store — the LONGITUDINAL dataset for the wallet-copy program. One SQLite file (off the system disk,
 * on My Passport when mounted) that accrues a timestamped snapshot of every tracked wallet on every run, so
 * over weeks we build the "organized dataset" the strategy reverse-engineering needs: how each wallet's
 * positions, hold-time, directionality, realized PnL and copyability EVOLVE — not a one-shot photo.
 *
 * A snapshot is the wallet's state at a moment; a round-trip is a closed trade (the copyable unit). We store
 * both: snapshots for drift/regime study, round-trips so a copy engine can replay exactly what to mirror.
 * better-sqlite3 is synchronous and already a dep. Pass ":memory:" for tests.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const PASSPORT_DIR = "/Volumes/My Passport/hft-data";

export function resolveWalletDbPath(): string {
  if (process.env.WALLET_DB_PATH) return process.env.WALLET_DB_PATH;
  if (existsSync("/Volumes/My Passport")) return resolve(PASSPORT_DIR, "wallets.db");
  return resolve(process.cwd(), "data", "wallets.db");
}

export type WalletSnapshot = {
  ts: number; iso: string; address: string;
  accountValue: number; archetype: string; label: string; horizon: string; directionality: string;
  copyabilityScore: number; copyabilityVerdict: string;
  tradesPerDay: number; medianHoldMs: number; longShare: number; topCoin: string; topCoinShare: number; nCoins: number;
  nTrips: number; winRate: number; expectancyUsd: number; realizedPnl: number;
  verified: boolean; flowDistorted: boolean; withdrawnUsd: number; openPositions: string;
};
export type TripRow = { address: string; coin: string; side: string; entryTime: number; exitTime: number; holdMs: number; entryPx: number; exitPx: number; sz: number; pnl: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wallet_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, iso TEXT NOT NULL, address TEXT NOT NULL,
  account_value REAL, archetype TEXT, label TEXT, horizon TEXT, directionality TEXT,
  copyability_score REAL, copyability_verdict TEXT,
  trades_per_day REAL, median_hold_ms REAL, long_share REAL, top_coin TEXT, top_coin_share REAL, n_coins INTEGER,
  n_trips INTEGER, win_rate REAL, expectancy_usd REAL, realized_pnl REAL,
  verified INTEGER, flow_distorted INTEGER, withdrawn_usd REAL, open_positions TEXT
);
CREATE INDEX IF NOT EXISTS idx_wsnap_addr ON wallet_snapshots(address, ts);
CREATE INDEX IF NOT EXISTS idx_wsnap_ts ON wallet_snapshots(ts);
CREATE TABLE IF NOT EXISTS wallet_trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL, coin TEXT NOT NULL, side TEXT NOT NULL,
  entry_time INTEGER NOT NULL, exit_time INTEGER NOT NULL, hold_ms INTEGER NOT NULL,
  entry_px REAL, exit_px REAL, sz REAL, pnl REAL,
  UNIQUE(address, coin, side, entry_time, exit_time, sz)
);
CREATE INDEX IF NOT EXISTS idx_wtrip_addr ON wallet_trips(address, exit_time);
`;

// snake_case columns aliased back to the camelCase WalletSnapshot shape on read
const SNAP_COLS = `ts, iso, address, account_value AS accountValue, archetype, label, horizon, directionality,
  copyability_score AS copyabilityScore, copyability_verdict AS copyabilityVerdict,
  trades_per_day AS tradesPerDay, median_hold_ms AS medianHoldMs, long_share AS longShare,
  top_coin AS topCoin, top_coin_share AS topCoinShare, n_coins AS nCoins,
  n_trips AS nTrips, win_rate AS winRate, expectancy_usd AS expectancyUsd, realized_pnl AS realizedPnl,
  verified, flow_distorted AS flowDistorted, withdrawn_usd AS withdrawnUsd, open_positions AS openPositions`;

export type WalletDb = ReturnType<typeof openWalletDb>;

export function openWalletDb(path = resolveWalletDbPath()) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const insSnap = db.prepare(`INSERT INTO wallet_snapshots
    (ts,iso,address,account_value,archetype,label,horizon,directionality,copyability_score,copyability_verdict,
     trades_per_day,median_hold_ms,long_share,top_coin,top_coin_share,n_coins,n_trips,win_rate,expectancy_usd,realized_pnl,
     verified,flow_distorted,withdrawn_usd,open_positions)
    VALUES (@ts,@iso,@address,@accountValue,@archetype,@label,@horizon,@directionality,@copyabilityScore,@copyabilityVerdict,
     @tradesPerDay,@medianHoldMs,@longShare,@topCoin,@topCoinShare,@nCoins,@nTrips,@winRate,@expectancyUsd,@realizedPnl,
     @verified,@flowDistorted,@withdrawnUsd,@openPositions)`);
  // round-trips are immutable history — ignore duplicates so re-runs are idempotent
  const insTrip = db.prepare(`INSERT OR IGNORE INTO wallet_trips
    (address,coin,side,entry_time,exit_time,hold_ms,entry_px,exit_px,sz,pnl)
    VALUES (@address,@coin,@side,@entryTime,@exitTime,@holdMs,@entryPx,@exitPx,@sz,@pnl)`);

  return {
    db,
    saveSnapshot(s: WalletSnapshot) { insSnap.run({ ...s, verified: s.verified ? 1 : 0, flowDistorted: s.flowDistorted ? 1 : 0 }); },
    saveTrips(rows: readonly TripRow[]) { const tx = db.transaction((rs: readonly TripRow[]) => { for (const r of rs) insTrip.run(r); }); tx(rows); return rows.length; },
    /** Latest snapshot per address (the current dossier state). */
    latest(): WalletSnapshot[] { return db.prepare(`SELECT ${SNAP_COLS} FROM wallet_snapshots w WHERE ts = (SELECT MAX(ts) FROM wallet_snapshots WHERE address = w.address)`).all() as unknown as WalletSnapshot[]; },
    /** Full history for one wallet, oldest→newest (for drift/regime study). */
    history(address: string): WalletSnapshot[] { return db.prepare(`SELECT ${SNAP_COLS} FROM wallet_snapshots WHERE address = ? ORDER BY ts ASC`).all(address) as unknown as WalletSnapshot[]; },
    tripCount(address: string): number { return (db.prepare(`SELECT COUNT(*) n FROM wallet_trips WHERE address = ?`).get(address) as { n: number }).n; },
    snapshotCount(): number { return (db.prepare(`SELECT COUNT(*) n FROM wallet_snapshots`).get() as { n: number }).n; },
    close() { db.close(); },
  };
}

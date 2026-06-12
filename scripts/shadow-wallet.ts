/**
 * shadow-wallet — settleable 2-week forward shadow of the copy-backtest
 * survivors (COPY-BACKTEST-2026-06-11.md "Forward shadow-tracking" section).
 *
 * For EVERY new leader trade detected (poll data-api /trades?user=…) it records:
 *   1. detection latency — leader fill ts vs our poll detection ts,
 *   2. the LIVE executable book for a copier — best bid/ask + spread from the
 *      public CLOB /book, sampled at detection AND at +60s AND at +300s after
 *      the LEADER's fill (scheduled follow-ups, persisted so restarts resume),
 *   3. leader clip size in USD (alwaysfade's ≥$1k filter needs it),
 *   4. market metadata (conditionId / tokenId / question / leader price/side).
 *
 * Persistence: append-only SQLite, passport-first like binary-maker-paper.db
 * (falls back to data/). Judge with `npm run shadow:report`.
 *
 * READ-ONLY market data. No orders, no keys, no positions — a paper shadow.
 *
 *   npm run shadow:run                                   # the two survivors, 30s poll
 *   npm run shadow:run -- --addresses 0xA,0xB --interval 30
 *
 * Deployed via ~/Library/LaunchAgents/com.isaiahdupree.hft.shadow.plist
 * (KeepAlive — relaunches on crash; logs: /tmp/hft-shadow.log).
 *
 * Pre-registered success criteria (do not move): 0x418d51e1 shadow-copy ROI at
 * recorded-latency entry > +5% over ≥25 new bets; alwaysfade ≥$1k-clip
 * follow-edge > 0 over ≥20 positions. Kill on the data, either way.
 */
import "./_env.ts";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  normalizeLeaderTrade,
  detectionLatencyMs,
  sampleDueTimes,
  bookTop,
  type RawLeaderTrade,
} from "../src/lib/wallets/shadow.ts";

// ── config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** The two copy-backtest survivors (full addresses: SWEEP-2026-06-10.md). */
const DEFAULT_ADDRESSES = [
  "0x418d51e13d019913bb027db22ecc723fe1ad88a3", // (anon) slow NBA/MLB value — COPYABLE ≤300s
  "0xe5b70fd855af9258d9463992e4f1ed7987905ee3", // alwaysfade — conditional on ≥$1k clips
];

const INTERVAL_SEC = Number(flag("interval") ?? 30);
const TICK_MS = 5_000; // sample-queue tick (finer than the poll so +60s lands near 60s)
const TRADES_LIMIT = 100;
/** On startup, record unseen trades up to this old (covers brief restarts);
 *  older ones are only marked seen. */
const LOOKBACK_MS = 10 * 60_000;
/** Latency above this ⇒ row flagged stale=1 (restart catch-up, not a live
 *  detection) — report excludes stale rows from latency/slippage stats. */
const STALE_MS = 120_000;
const MAX_SAMPLE_ATTEMPTS = 3;

const DATA_HOST = process.env.POLYMARKET_DATA_HOST ?? "https://data-api.polymarket.com";
const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com";
const UA = "HFT-work-shadow-tracker/0.1 (research; contact isaiahdupree33@gmail.com)";

const log = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);

// ── DB (passport-first, same pattern as binary-maker-paper) ─────────────────

export const SHADOW_DB_PATH =
  process.env.SHADOW_WALLET_DB_PATH ??
  (existsSync("/Volumes/My Passport")
    ? "/Volumes/My Passport/hft-data/shadow-wallet.db"
    : resolve(process.cwd(), "data", "shadow-wallet.db"));

const db = new Database(SHADOW_DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS shadow_trades (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet               TEXT NOT NULL,
    tx_hash              TEXT NOT NULL,
    token_id             TEXT NOT NULL,
    condition_id         TEXT,
    event_slug           TEXT,
    question             TEXT,
    outcome              TEXT,
    outcome_index        INTEGER,
    side                 TEXT NOT NULL,             -- leader's BUY / SELL
    leader_price         REAL NOT NULL,
    leader_size          REAL NOT NULL,             -- shares
    leader_usd           REAL NOT NULL,             -- clip size in USD (≥$1k filter)
    leader_ts_ms         INTEGER NOT NULL,          -- leader fill time
    detected_ts_ms       INTEGER NOT NULL,          -- our poll detection time
    detection_latency_ms INTEGER NOT NULL,
    stale                INTEGER NOT NULL DEFAULT 0, -- 1 = detected >${STALE_MS / 1000}s late (restart catch-up)
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(wallet, tx_hash, token_id)
  );
  CREATE INDEX IF NOT EXISTS idx_shadow_trades_wallet ON shadow_trades(wallet, leader_ts_ms);
  CREATE INDEX IF NOT EXISTS idx_shadow_trades_condition ON shadow_trades(condition_id);

  CREATE TABLE IF NOT EXISTS shadow_samples (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id      INTEGER NOT NULL,
    offset_sec    INTEGER NOT NULL,    -- 0 = at detection; 60 / 300 = after LEADER fill
    due_ts_ms     INTEGER NOT NULL,
    sampled_ts_ms INTEGER,             -- actual sample time (achieved offset = this − leader_ts_ms)
    best_bid      REAL,
    best_ask      REAL,
    spread        REAL,
    mid           REAL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    err           TEXT,
    UNIQUE(trade_id, offset_sec)
  );
  CREATE INDEX IF NOT EXISTS idx_shadow_samples_pending
    ON shadow_samples(due_ts_ms) WHERE sampled_ts_ms IS NULL;

  -- resolution cache, filled by shadow-wallet-report (Gamma join)
  CREATE TABLE IF NOT EXISTS shadow_resolutions (
    condition_id   TEXT PRIMARY KEY,
    resolved       INTEGER NOT NULL,
    winning_index  INTEGER,
    clob_token_ids TEXT,               -- JSON array, order matches winning_index
    closed_time    INTEGER,
    checked_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const insertTrade = db.prepare(`
  INSERT OR IGNORE INTO shadow_trades
    (wallet, tx_hash, token_id, condition_id, event_slug, question, outcome, outcome_index,
     side, leader_price, leader_size, leader_usd, leader_ts_ms, detected_ts_ms, detection_latency_ms, stale)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertSample = db.prepare(`
  INSERT OR IGNORE INTO shadow_samples (trade_id, offset_sec, due_ts_ms) VALUES (?, ?, ?)
`);
const duePending = db.prepare(`
  SELECT s.id, s.trade_id, s.offset_sec, s.attempts, t.token_id
    FROM shadow_samples s JOIN shadow_trades t ON t.id = s.trade_id
   WHERE s.sampled_ts_ms IS NULL AND s.due_ts_ms <= ?
   ORDER BY s.due_ts_ms LIMIT 25
`);
const fillSample = db.prepare(`
  UPDATE shadow_samples
     SET sampled_ts_ms = ?, best_bid = ?, best_ask = ?, spread = ?, mid = ?, attempts = ?, err = ?
   WHERE id = ?
`);
const bumpAttempts = db.prepare(`UPDATE shadow_samples SET attempts = ?, err = ? WHERE id = ?`);

// ── HTTP (public endpoints, sane UA, 10s timeout) ───────────────────────────

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, {
    method: "GET",
    headers: { "User-Agent": UA, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json() as Promise<T>;
}

const fetchLeaderTrades = (wallet: string) =>
  getJson<RawLeaderTrade[]>(`${DATA_HOST}/trades?user=${wallet}&limit=${TRADES_LIMIT}`);
const fetchBook = (tokenId: string) => getJson<any>(`${CLOB_HOST}/book?token_id=${tokenId}`);

// ── poll: detect new leader trades ──────────────────────────────────────────

const startupMs = Date.now();

function primeSeen(): Set<string> {
  const seen = new Set<string>();
  const rows = db.prepare(`SELECT wallet, tx_hash, token_id FROM shadow_trades`).all() as Array<{
    wallet: string; tx_hash: string; token_id: string;
  }>;
  for (const r of rows) seen.add(`${r.wallet}|${r.tx_hash}|${r.token_id}`);
  return seen;
}

function pollWallet(wallet: string, seen: Set<string>, raw: RawLeaderTrade[]): number {
  if (!Array.isArray(raw)) return 0;
  const detectedTsMs = Date.now();
  let recorded = 0;
  for (const row of raw) {
    const t = normalizeLeaderTrade(row);
    if (!t) continue;
    const key = `${wallet}|${t.txHash}|${t.tokenId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Pre-startup history: mark seen, never record (those trades' +60s/+300s
    // books are gone — recording them would poison the latency/slippage stats).
    if (t.leaderTsMs < startupMs - LOOKBACK_MS) continue;

    const latency = detectionLatencyMs(t.leaderTsMs, detectedTsMs);
    const stale = latency > STALE_MS ? 1 : 0;
    const res = insertTrade.run(
      wallet, t.txHash, t.tokenId, t.conditionId, t.eventSlug, t.question, t.outcome,
      t.outcomeIndex, t.side, t.price, t.size, t.usd, t.leaderTsMs, detectedTsMs, latency, stale,
    );
    if (res.changes === 0) continue; // raced a previous insert
    const tradeId = Number(res.lastInsertRowid);
    for (const s of sampleDueTimes(t.leaderTsMs, detectedTsMs)) {
      insertSample.run(tradeId, s.offsetSec, s.dueMs);
    }
    recorded++;
    log(
      `  [+] ${wallet.slice(0, 10)}… ${t.side} ${t.outcome ?? "?"} @ ${t.price.toFixed(3)} ` +
      `$${t.usd.toFixed(0)} latency ${(latency / 1000).toFixed(1)}s${stale ? " STALE" : ""} ` +
      `"${(t.question ?? t.eventSlug ?? "?").slice(0, 60)}"`,
    );
  }
  return recorded;
}

// ── sample queue: fill due book snapshots ───────────────────────────────────

async function processDueSamples(): Promise<number> {
  const now = Date.now();
  const rows = duePending.all(now) as Array<{
    id: number; trade_id: number; offset_sec: number; attempts: number; token_id: string;
  }>;
  let filled = 0;
  for (const row of rows) {
    try {
      const top = bookTop(await fetchBook(row.token_id));
      fillSample.run(Date.now(), top.bestBid, top.bestAsk, top.spread, top.mid, row.attempts + 1, null, row.id);
      filled++;
    } catch (err) {
      const attempts = row.attempts + 1;
      const msg = (err as Error).message.slice(0, 160);
      if (attempts >= MAX_SAMPLE_ATTEMPTS) {
        // give up — keep the row (sampled_ts set, prices NULL) so the report
        // can count the miss instead of waiting forever
        fillSample.run(Date.now(), null, null, null, null, attempts, msg, row.id);
      } else {
        bumpAttempts.run(attempts, msg, row.id);
      }
    }
  }
  return filled;
}

// ── main loop ───────────────────────────────────────────────────────────────

(async () => {
  let addresses = DEFAULT_ADDRESSES;
  const override = flag("addresses");
  if (override) {
    addresses = override.split(",").map((s) => s.trim().toLowerCase())
      .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
    if (!addresses.length) { console.error("no valid --addresses"); process.exit(1); }
  }
  const seen = primeSeen();
  log(`shadow-wallet up — ${addresses.length} wallets, poll ${INTERVAL_SEC}s, db ${SHADOW_DB_PATH}`);
  log(`  ${seen.size} previously-recorded fills primed; READ-ONLY market data, no orders`);

  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  let lastPollMs = 0;
  let cycles = 0;
  while (!stopping) {
    const now = Date.now();
    if (now - lastPollMs >= INTERVAL_SEC * 1000) {
      lastPollMs = now;
      cycles++;
      let recorded = 0;
      for (const wallet of addresses) {
        try {
          recorded += pollWallet(wallet, seen, await fetchLeaderTrades(wallet));
        } catch (err) {
          log(`  [!] poll ${wallet.slice(0, 10)}…: ${(err as Error).message.slice(0, 140)}`);
        }
      }
      if (cycles % 20 === 0 || recorded > 0) {
        const n = db.prepare(`SELECT COUNT(*) c FROM shadow_trades`).get() as { c: number };
        const pend = db.prepare(`SELECT COUNT(*) c FROM shadow_samples WHERE sampled_ts_ms IS NULL`).get() as { c: number };
        log(`heartbeat cycle ${cycles}: +${recorded} new, ${n.c} trades recorded, ${pend.c} samples pending`);
      }
    }
    try {
      await processDueSamples();
    } catch (err) {
      log(`  [!] sample tick: ${(err as Error).message.slice(0, 140)}`);
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
  log("shadow-wallet stopped.");
  db.close();
})().catch((err) => {
  console.error("[shadow-wallet] FATAL:", err);
  process.exit(1);
});

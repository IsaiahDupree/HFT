/**
 * Backfills historical 1-minute OHLCV from CoinDesk Data API into
 * coindesk_candles. Walks BACKWARDS from now (or from the oldest row we
 * already have, resumable) toward each instrument's FIRST_TRADE_TIMESTAMP.
 *
 * Usage:
 *   tsx scripts/coindesk-backfill.ts                              # default: last 30 days
 *   tsx scripts/coindesk-backfill.ts --days 90                    # last 90 days
 *   tsx scripts/coindesk-backfill.ts --full                       # ALL the way to origination
 *   tsx scripts/coindesk-backfill.ts --instruments BTC-USD,ETH-USD
 *
 * Default instruments come from ARENA_SNAPSHOT_CB_PRODUCTS (e.g. BTC-USD,ETH-USD,...).
 * Throttle: 5 req/sec to stay well under CoinDesk's per-second ceiling.
 * Idempotent: ON CONFLICT IGNORE on the UNIQUE(market, instrument, granularity, start_unix) index.
 */
import "./_env.ts";
import { coindesk, type CoinDeskCandle } from "../src/lib/coindesk/client.ts";
import { db } from "../src/lib/db/client.ts";

const BATCH_LIMIT = 2000;
const REQ_INTERVAL_MS = 200; // 5 req/sec

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1] ?? "true";
  return fallback;
}

const FULL = process.argv.includes("--full");
const DAYS = Number(arg("days") ?? "30");
const MARKET = arg("market") ?? "coinbase";
const INSTRUMENTS = (arg("instruments") ?? process.env.ARENA_SNAPSHOT_CB_PRODUCTS ?? "BTC-USD,ETH-USD,SOL-USD,XRP-USD,DOGE-USD")
  .split(",").map((s) => s.trim()).filter(Boolean);

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

const insertStmt = db().prepare(
  `INSERT OR IGNORE INTO coindesk_candles
     (market, instrument, granularity, start_unix, open, high, low, close, volume, quote_volume, total_trades)
   VALUES (@market, @instrument, 'ONE_MINUTE', @start_unix, @open, @high, @low, @close, @volume, @quote_volume, @total_trades)`,
);
const insertBatch = db().transaction((rows: CoinDeskCandle[]) => {
  let inserted = 0;
  for (const r of rows) {
    const res = insertStmt.run({
      market: r.MARKET, instrument: r.INSTRUMENT,
      start_unix: r.TIMESTAMP,
      open: r.OPEN, high: r.HIGH, low: r.LOW, close: r.CLOSE,
      volume: r.VOLUME ?? null, quote_volume: r.QUOTE_VOLUME ?? null,
      total_trades: r.TOTAL_TRADES ?? null,
    });
    if ((res.changes ?? 0) > 0) inserted += 1;
  }
  return inserted;
});

function oldestRow(market: string, instrument: string): number | null {
  const row = db().prepare(
    `SELECT MIN(start_unix) AS s FROM coindesk_candles
      WHERE market = ? AND instrument = ? AND granularity = 'ONE_MINUTE'`,
  ).get(market, instrument) as { s: number | null };
  return row?.s ?? null;
}

async function backfillInstrument(instrument: string): Promise<{ instrument: string; inserted: number; calls: number; oldest: number; newest: number; stopped: string }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const lowerBoundSec = FULL ? 0 : nowSec - DAYS * 86_400;
  let toTs = nowSec;
  let inserted = 0;
  let calls = 0;
  let oldest = nowSec;
  let newest = 0;
  let stopped = "completed";

  // If we have rows already, start before the oldest existing — resumable.
  const existing = oldestRow(MARKET, instrument);
  if (existing != null) {
    toTs = Math.min(toTs, existing - 60);
    console.log(`  [${instrument}] resuming below existing oldest=${new Date(existing * 1000).toISOString().slice(0, 16)}`);
  }

  while (true) {
    if (toTs <= lowerBoundSec) { stopped = "reached --days/full bound"; break; }
    let resp;
    try {
      resp = await coindesk.historicalMinutes({ market: MARKET, instrument, limit: BATCH_LIMIT, to_ts: toTs });
    } catch (err) {
      stopped = `error: ${(err as Error).message.slice(0, 80)}`;
      break;
    }
    calls += 1;
    const rows = (resp as { Data?: CoinDeskCandle[] }).Data ?? [];
    if (rows.length === 0) { stopped = "empty response"; break; }
    const n = insertBatch(rows);
    inserted += n;
    const earliest = Math.min(...rows.map((r) => r.TIMESTAMP));
    const latest = Math.max(...rows.map((r) => r.TIMESTAMP));
    if (earliest < oldest) oldest = earliest;
    if (latest > newest) newest = latest;
    process.stdout.write(`\r  [${instrument}] call ${calls} ${new Date(earliest * 1000).toISOString().slice(0, 16)} +${n} (cum ${inserted})    `);
    // Walk back: next to_ts is earliest - 60s (CoinDesk uses inclusive to_ts).
    const nextToTs = earliest - 60;
    if (nextToTs >= toTs) { stopped = "no backward progress"; break; }
    toTs = nextToTs;
    await sleep(REQ_INTERVAL_MS);
  }
  process.stdout.write("\n");
  return { instrument, inserted, calls, oldest, newest, stopped };
}

(async () => {
  if (!process.env.COINDESK_API_KEY) {
    console.error("COINDESK_API_KEY not set in .env.local — aborting.");
    process.exit(1);
  }
  console.log(`coindesk-backfill: market=${MARKET}  instruments=[${INSTRUMENTS.join(", ")}]  ${FULL ? "--full (to origination)" : `--days ${DAYS}`}`);
  console.log(`(throttle ${1000 / REQ_INTERVAL_MS} req/sec, batch ${BATCH_LIMIT})\n`);
  const results = [];
  for (const inst of INSTRUMENTS) {
    const r = await backfillInstrument(inst);
    results.push(r);
    const oldestIso = r.oldest > 0 ? new Date(r.oldest * 1000).toISOString().slice(0, 16) : "—";
    const newestIso = r.newest > 0 ? new Date(r.newest * 1000).toISOString().slice(0, 16) : "—";
    console.log(`  → ${inst}: ${r.inserted} new bars in ${r.calls} calls (oldest=${oldestIso}, newest=${newestIso}, stopped=${r.stopped})`);
  }
  const totalInserted = results.reduce((s, r) => s + r.inserted, 0);
  const totalCalls = results.reduce((s, r) => s + r.calls, 0);
  console.log(`\nbackfill complete: ${totalInserted} new bars across ${INSTRUMENTS.length} instruments in ${totalCalls} API calls.`);
  process.exit(0);
})();

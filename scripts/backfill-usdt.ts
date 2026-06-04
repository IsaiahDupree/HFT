/**
 * backfill-usdt — close the warehouse SPLICE. The 66+ Binance "USDT" symbols stop on
 * 2024-12-31 while the 12 Coinbase "-USD" symbols run to today, so any portfolio backtest
 * crossing that date sees its universe collapse 78→12 (see src/lib/backtest/candle/universe.ts).
 * This extends each USDT coin from its last bar to now using the SAME source (Binance public
 * data mirror data-api.binance.vision — api.binance.com is geo-blocked here, the mirror is not),
 * so there's no cross-source splice. Idempotent (ON CONFLICT DO NOTHING) and dry-run-first.
 *
 *   npm run backfill:usdt -- --dry-run      # preview what WOULD be inserted (no writes)
 *   npm run backfill:usdt                   # write
 *   npm run backfill:usdt -- --limit-coins 3
 */
import "./_env.ts";
import { listProducts, candleRange, upsertCandles, closeTsdb, type CandleRow } from "../src/lib/db/candle-store.ts";

const DAY = 86_400;
const HOST = process.env.BINANCE_DATA_HOST ?? "https://data-api.binance.vision";
const MAX_VALID = 2_000_000_000; // mirror the warehouse sanity bound
const dryRun = process.argv.includes("--dry-run");
const limIdx = process.argv.indexOf("--limit-coins");
const limitCoins = limIdx >= 0 && process.argv[limIdx + 1] ? Number(process.argv[limIdx + 1]) : Infinity;

const nowSec = Math.floor(Date.now() / 1000);

/** Fetch daily klines from `startUnix` (inclusive) forward; drop the still-open current candle. */
async function fetchDailyKlines(symbol: string, startUnix: number): Promise<CandleRow[]> {
  const url = `${HOST}/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${startUnix * 1000}&limit=1000`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${symbol} → HTTP ${r.status}`);
  const raw = (await r.json()) as Array<[number, string, string, string, string, string, number, ...unknown[]]>;
  const out: CandleRow[] = [];
  for (const k of raw) {
    const start = Math.floor(k[0] / 1000);   // openTime ms → s (daily = 00:00 UTC)
    const closeTime = Math.floor(k[6] / 1000);
    if (closeTime > nowSec) continue;          // in-progress day → skip (no partial bar)
    if (start >= MAX_VALID || start < startUnix) continue;
    const o = +k[1], h = +k[2], l = +k[3], c = +k[4], v = +k[5];
    if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) continue;
    out.push({ start_unix: start, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0 });
  }
  return out;
}

const all = await listProducts("ONE_DAY");
const usdt = all.filter((c) => /USDT$/i.test(c)).slice(0, limitCoins);
console.log(`\nbackfill-usdt — ${usdt.length} USDT coins · source ${HOST} · ${dryRun ? "DRY RUN (no writes)" : "WRITING"}\n`);

let totalNew = 0, totalInserted = 0, gapless = 0, skipped = 0, failed = 0;
const iso = (u: number) => new Date(u * 1000).toISOString().slice(0, 10);

for (const coin of usdt) {
  const { mx } = await candleRange(coin, "ONE_DAY");
  if (mx == null) { skipped++; continue; }
  const from = mx + DAY; // first missing day
  if (from > nowSec) { gapless++; continue; } // already current
  try {
    const rows = (await fetchDailyKlines(coin, from)).filter((r) => r.start_unix >= from);
    if (!rows.length) { skipped++; console.log(`  ${coin.padEnd(12)} no new bars on mirror (delisted?) — last ${iso(mx)}`); continue; }
    totalNew += rows.length;
    if (dryRun) {
      console.log(`  ${coin.padEnd(12)} +${String(rows.length).padStart(4)} bars  ${iso(rows[0].start_unix)} → ${iso(rows[rows.length - 1].start_unix)}`);
    } else {
      const ins = await upsertCandles(coin, "ONE_DAY", rows);
      totalInserted += ins;
      console.log(`  ${coin.padEnd(12)} +${String(ins).padStart(4)} inserted  ${iso(rows[0].start_unix)} → ${iso(rows[rows.length - 1].start_unix)}`);
    }
  } catch (e) {
    failed++;
    console.log(`  ${coin.padEnd(12)} ERROR ${(e as Error).message.slice(0, 70)}`);
  }
  await new Promise((res) => setTimeout(res, 120)); // be polite to the mirror
}

console.log(`\n  ${dryRun ? "would insert" : "inserted"} ${dryRun ? totalNew : totalInserted} bars across ${usdt.length} coins` +
  ` · ${gapless} already current · ${skipped} no-data · ${failed} failed`);
console.log(dryRun ? `  re-run without --dry-run to write, then: npm run analyze:regime -- --universe all (should show no splice)\n`
                   : `  done. Verify: npm run analyze:regime -- --universe all  (the ⚠ SPLICE warning should be gone)\n`);
await closeTsdb();

/**
 * load-binance-history — load Binance kline ZIPs archived on the passport drive
 * (by scripts/download-binance-history.sh) into the TimescaleDB warehouse, so the
 * backtest + robustness stack (harden:priors, backtest-xsection, momentum, the
 * regime classifier) consumes them with zero new wiring — same coinbase_candles
 * landing zone the Coinbase ingest uses, keyed on (product_id, granularity,
 * start_unix), idempotent ON CONFLICT DO NOTHING.
 *
 *   npx tsx scripts/load-binance-history.ts --archive "/Volumes/My Passport/hft-data/binance" \
 *     [--market spot] [--symbols BTCUSDT,ETHUSDT] [--intervals 1d,1h,1m]
 *
 * Binance symbols land under their native id ("BTCUSDT") — distinct from Coinbase
 * "BTC-USD", so they form an additive, broader universe (don't double-count the
 * SAME asset in cross-sectional backtests: run those filtered to one source).
 */
import "./_env.ts";
import { execSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { upsertCandles, closeTsdb, type CandleRow } from "../src/lib/db/candle-store.ts";

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const archive = arg("--archive");
if (!archive) { console.error("need --archive <dir> (the passport binance dir)"); process.exit(1); }
const market = arg("--market") ?? "spot";
const symFilter = arg("--symbols")?.split(",").map((s) => s.trim());
const ivFilter = arg("--intervals")?.split(",").map((s) => s.trim());

// Binance interval → our warehouse granularity label (only the ones the backtests use).
const IV_LABEL: Record<string, string> = { "1m": "ONE_MINUTE", "1h": "ONE_HOUR", "6h": "SIX_HOUR", "1d": "ONE_DAY" };
const CHUNK = 2000; // batch upserts so 1m×5yr (~2.6M rows) doesn't blow pg param limits

const klinesRoot = join(archive, market, "klines");
if (!existsSync(klinesRoot)) { console.error(`no klines dir at ${klinesRoot} — run download-binance-history.sh first`); process.exit(1); }

(async () => {
  let totalUpserted = 0, totalFiles = 0, cells = 0;
  for (const sym of readdirSync(klinesRoot).sort()) {
    if (symFilter && !symFilter.includes(sym)) continue;
    const symDir = join(klinesRoot, sym);
    let intervals: string[];
    try { intervals = readdirSync(symDir); } catch { continue; }
    for (const iv of intervals.sort()) {
      if (ivFilter && !ivFilter.includes(iv)) continue;
      const label = IV_LABEL[iv];
      if (!label) { console.log(`  skip ${sym}/${iv} (no warehouse label for interval)`); continue; }
      const ivDir = join(symDir, iv);
      const zips = readdirSync(ivDir).filter((f) => f.endsWith(".zip")).sort();
      if (!zips.length) continue;
      const rows: CandleRow[] = [];
      for (const z of zips) {
        const csv = execSync(`unzip -p ${JSON.stringify(join(ivDir, z))}`, { maxBuffer: 512 * 1024 * 1024 }).toString();
        for (const line of csv.split("\n")) {
          if (!line) continue;
          const c = line.split(",");
          const t = Number(c[0]);
          if (!Number.isFinite(t)) continue; // skips a header row if present
          rows.push({ start_unix: Math.floor(t / 1000), open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] });
        }
      }
      let up = 0;
      for (let i = 0; i < rows.length; i += CHUNK) up += await upsertCandles(sym, label, rows.slice(i, i + CHUNK));
      totalUpserted += up; totalFiles += zips.length; cells++;
      console.log(`  ${sym} ${label.padEnd(11)} ${String(zips.length).padStart(3)} files → ${String(rows.length).padStart(8)} bars (${up} new)`);
    }
  }
  console.log(`\nloaded ${cells} (symbol×granularity) cells · ${totalFiles} archives · ${totalUpserted} new candle rows → warehouse.`);
  console.log(`backtest now: npx tsx scripts/backtest-xsection.ts   robustness: npx tsx scripts/harden-priors.ts`);
  await closeTsdb();
})();

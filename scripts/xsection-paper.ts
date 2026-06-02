/**
 * xsection-paper — live FORWARD paper track record for cross-sectional momentum.
 * Each run: realize the return of the PREVIOUS day's basket over the price move to
 * the latest warehouse close, store today's new basket, and report the cumulative
 * forward PnL + live Sharpe. This is the honest out-of-sample validation — the edge
 * either holds going forward or it doesn't, recorded day by day.
 *
 *   npm run xsection:paper      (run daily, after `npm run ingest:history`)
 *
 * No lookahead: yesterday's weights were computed from data ≤ yesterday; the
 * realized return is the subsequent price move. State lives in SQLite (xsection_paper).
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { listProducts, getCandles, closeTsdb } from "../src/lib/db/candle-store.ts";
import { momentumSignal, type CoinCloses } from "../src/lib/strategies/xsection-momentum.ts";

db().exec(`CREATE TABLE IF NOT EXISTS xsection_paper (
  as_of_date      TEXT PRIMARY KEY,
  weights_json    TEXT NOT NULL,
  realized_return REAL NOT NULL DEFAULT 0,   -- return of the PRIOR basket over prior→as_of
  cum_return      REAL NOT NULL DEFAULT 0,   -- compounded forward cumulative
  trending        INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const lookback = (() => { const i = process.argv.indexOf("--lookback"); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 20; })();
const dstr = (u: number) => new Date(u * 1000).toISOString().slice(0, 10);

const coins = await listProducts("ONE_DAY");
const closeAt: Record<string, Map<string, number>> = {};
const bars: CoinCloses[] = [];
let btcCloses: number[] = [];
let asOf = "";
for (const c of coins) {
  const candles = await getCandles(c, "ONE_DAY");
  const m = new Map<string, number>();
  for (const k of candles) m.set(dstr(k.start_unix), k.close);
  closeAt[c] = m;
  bars.push({ coin: c, closes: candles.map((k) => k.close) });
  if (c === "BTC-USD") btcCloses = candles.map((k) => k.close);
  if (candles.length) { const d = dstr(candles[candles.length - 1].start_unix); if (d > asOf) asOf = d; }
}

const prev = db().prepare(`SELECT as_of_date, weights_json, cum_return FROM xsection_paper ORDER BY as_of_date DESC LIMIT 1`).get() as
  { as_of_date: string; weights_json: string; cum_return: number } | undefined;

// realize the prior basket over prev → asOf (only if a new day has arrived)
let realized = 0;
if (prev && asOf > prev.as_of_date) {
  for (const [coin, w] of Object.entries(JSON.parse(prev.weights_json) as Record<string, number>)) {
    const a = closeAt[coin]?.get(asOf), b = closeAt[coin]?.get(prev.as_of_date);
    if (a && b && b > 0) realized += w * (a / b - 1);
  }
}
const cum = (prev ? 1 + prev.cum_return : 1) * (1 + realized) - 1; // compounded forward

const { trending, weights } = momentumSignal(bars, btcCloses, { lookback });
if (asOf) {
  db().prepare(`INSERT INTO xsection_paper (as_of_date, weights_json, realized_return, cum_return, trending)
    VALUES (?,?,?,?,?)
    ON CONFLICT(as_of_date) DO UPDATE SET weights_json=excluded.weights_json, realized_return=excluded.realized_return, cum_return=excluded.cum_return, trending=excluded.trending`)
    .run(asOf, JSON.stringify(weights), realized, cum, trending ? 1 : 0);
}

const rows = db().prepare(`SELECT realized_return FROM xsection_paper WHERE realized_return != 0 ORDER BY as_of_date`).all() as Array<{ realized_return: number }>;
console.log(`\nxsection-paper — live FORWARD track record of cross-sectional momentum\n`);
console.log(`  as of ${asOf}: ${trending ? "TRENDING → basket deployed" : "CHOP → flat"}`);
console.log(`  realized since prev: ${prev ? `${(realized * 100).toFixed(2)}%` : "(bootstrap — first day, no prior basket)"}`);
console.log(`  cumulative forward (compounded): ${(cum * 100).toFixed(2)}%  over ${rows.length} realized day(s)`);
if (rows.length >= 5) {
  const r = rows.map((x) => x.realized_return);
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  console.log(`  live ann.Sharpe (forward, ${r.length}d): ${(sd > 0 ? (m / sd) * Math.sqrt(365) : 0).toFixed(2)}`);
}
console.log(`\n  Run daily (after ingest:history) — the forward record IS the live OOS test.\n`);
await closeTsdb();

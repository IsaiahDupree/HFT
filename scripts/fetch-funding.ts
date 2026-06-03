/**
 * fetch-funding — pull perp funding-rate history from Hyperliquid's KEYLESS public API
 * (Binance funding is geo-blocked from here) → data/funding/<coin>.jsonl. Feeds the
 * funding-aware carry strategies in src/lib/backtest/candle/funding.ts.
 *
 *   npm run fetch:funding -- --coins BTC,ETH,SOL --days 365
 *
 * Hyperliquid returns HOURLY funding rows: {coin, fundingRate, premium, time(ms)}. Paginated
 * by advancing startTime past the last row's time.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const arg = (n: string, def: string): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const coins = arg("--coins", "BTC,ETH,SOL").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const days = Number(arg("--days", "365"));
const startMs = (Math.floor(Date.now() / 1000) - days * 86_400) * 1000;
const dir = resolve(process.cwd(), "data", "funding");
mkdirSync(dir, { recursive: true });

type Row = { coin: string; fundingRate: string; premium: string; time: number };

for (const coin of coins) {
  const all: Array<{ time: number; fundingRate: number; premium: number }> = [];
  let cursor = startMs;
  for (let page = 0; page < 100; page++) {
    let rows: Row[] = [];
    try {
      const res = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "fundingHistory", coin, startTime: cursor }),
      });
      rows = (await res.json()) as Row[];
    } catch (e) {
      console.error(`${coin}: fetch error on page ${page}: ${(e as Error).message}`);
      break;
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) all.push({ time: r.time, fundingRate: Number(r.fundingRate), premium: Number(r.premium) });
    const last = rows[rows.length - 1].time;
    if (last <= cursor) break;          // no forward progress → done
    cursor = last + 1;
    if (rows.length < 500) break;       // short page → last page
  }
  // de-dup by time (pagination boundaries can overlap) + sort chronologically
  const byTime = new Map(all.map((r) => [r.time, r]));
  const out = [...byTime.values()].sort((a, b) => a.time - b.time);
  const path = resolve(dir, `${coin}.jsonl`);
  writeFileSync(path, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`${coin}: ${out.length} hourly funding rows (${days}d) → data/funding/${coin}.jsonl`);
}

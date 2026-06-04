/**
 * fetch-funding-binance — pull REAL Binance perp funding history via the proxy (now that the
 * geo-block is bypassed) → data/funding/<COIN>.binance.jsonl. Replaces the Hyperliquid fallback
 * for the funding-carry backtest. Binance funding is 8-HOURLY (3/day) at 00/08/16 UTC.
 * Convention stored: rate = fraction the LONG pays that interval (positive = long pays).
 *
 *   npm run fetch:funding:binance -- --coins BTC,ETH,SOL --days 500
 */
import "./_env.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchBinanceFunding } from "../src/lib/data/binance.ts";
import { dataProxyStatus } from "../src/lib/data/proxy-fetch.ts";

const arg = (n: string, def: string): string => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const DEFAULT = "BTC,ETH,SOL,BNB,XRP,DOGE,ADA,AVAX,LINK,DOT,LTC,TRX,UNI,NEAR,APT,ARB,SUI,TIA,SEI,ATOM";
const coins = arg("--coins", DEFAULT).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const days = Number(arg("--days", "500"));
const nowSec = Math.floor(Date.now() / 1000);
const dir = resolve(process.cwd(), "data", "funding");
mkdirSync(dir, { recursive: true });

const st = dataProxyStatus();
console.log(`\nfetch-funding-binance — ${coins.length} coins · ${days}d · proxy ${st.enabled ? `ON (${st.host})` : "OFF — will 451"}\n`);

let ok = 0, empty = 0;
for (const coin of coins) {
  const symbol = `${coin}USDT`;
  const all: Array<{ time: number; rate: number }> = [];
  let cursor = nowSec - days * 86_400;
  try {
    for (let page = 0; page < 12; page++) {
      const rows = await fetchBinanceFunding(symbol, { startUnix: cursor, limit: 1000 });
      if (!rows.length) break;
      all.push(...rows);
      const last = rows[rows.length - 1].time;
      if (last <= cursor) break;
      cursor = last + 1;
      if (rows.length < 1000) break; // short page → caught up
    }
  } catch (e) {
    console.log(`  ${symbol.padEnd(12)} ERROR ${(e as Error).message.slice(0, 70)}`);
    continue;
  }
  const byTime = new Map(all.map((r) => [r.time, r]));
  const out = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (!out.length) { empty++; console.log(`  ${symbol.padEnd(12)} no funding (no perp?) — skipped`); continue; }
  writeFileSync(resolve(dir, `${coin}.binance.jsonl`), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
  ok++;
  const d0 = new Date(out[0].time * 1000).toISOString().slice(0, 10), d1 = new Date(out[out.length - 1].time * 1000).toISOString().slice(0, 10);
  console.log(`  ${symbol.padEnd(12)} ${String(out.length).padStart(5)} rows  ${d0} → ${d1}  → data/funding/${coin}.binance.jsonl`);
}
console.log(`\n  ${ok} coins written · ${empty} no-perp · data/funding/*.binance.jsonl\n`);

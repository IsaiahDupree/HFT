/**
 * tsdb-migrate — one-time backfill of coinbase_candles from the legacy SQLite
 * stores (the dev checkout's data/polymarket.db AND the runtime ~/hft-live one)
 * into the TimescaleDB warehouse. Reads both, upserts with ON CONFLICT, so the
 * two diverged files are merged + deduped into a single source of truth.
 *   npm run tsdb:migrate
 */
import "./_env.ts";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { upsertCandles, candleRange, closeTsdb } from "../src/lib/db/candle-store.ts";

type Row = { product_id: string; granularity: string; start_unix: number; open: number; high: number; low: number; close: number; volume: number };

const SOURCES = [
  resolve(process.cwd(), "data/polymarket.db"),
  resolve(homedir(), "hft-live/data/polymarket.db"),
];

let grandRead = 0, grandNew = 0;
for (const src of SOURCES) {
  if (!existsSync(src)) { console.log(`  skip (missing): ${src}`); continue; }
  const sdb = new Database(src, { readonly: true });
  const has = sdb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='coinbase_candles'`).get();
  if (!has) { console.log(`  skip (no coinbase_candles): ${src}`); sdb.close(); continue; }
  const rows = sdb.prepare(
    `SELECT product_id, granularity, start_unix, open, high, low, close, volume FROM coinbase_candles`,
  ).all() as Row[];
  sdb.close();
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.product_id}|${r.granularity}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  let srcNew = 0;
  for (const [key, g] of groups) {
    const [product, gran] = key.split("|");
    srcNew += await upsertCandles(product, gran, g.map((r) => ({ start_unix: Number(r.start_unix), open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +(r.volume ?? 0) })));
  }
  grandRead += rows.length; grandNew += srcNew;
  console.log(`  ${src}\n    read ${rows.length} rows · ${srcNew} new into warehouse`);
}

console.log(`\n  total: ${grandRead} read · ${grandNew} new. Warehouse coverage:`);
for (const gran of ["ONE_DAY", "ONE_HOUR", "ONE_MINUTE"]) {
  for (const p of ["BTC-USD", "ETH-USD", "SOL-USD"]) {
    const r = await candleRange(p, gran);
    if (r.n > 0) console.log(`    ${p.padEnd(10)} ${gran.padEnd(11)} ${String(r.n).padStart(7)} · ${r.mn ? new Date(r.mn * 1000).toISOString().slice(0, 10) : "—"} → ${r.mx ? new Date(r.mx * 1000).toISOString().slice(0, 10) : "—"}`);
  }
}
await closeTsdb();

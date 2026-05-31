/**
 * candle-store — the ONE data-access path for the market-data warehouse
 * (TimescaleDB). Repointing ingestion + backtests here ends the SQLite file
 * divergence (HFT-work/data vs hft-live/data) — every process reads/writes the
 * same Postgres server over TSDB_URL. The in-memory backtest engine is untouched;
 * only the load/store boundary became async.
 *
 *   TSDB_URL=postgres://hft:<pw>@localhost:5544/hft   (default: localhost:5544, pw from TSDB_PASSWORD)
 *   (host port 5544 → container 5432; a local Postgres already owns host 5432.)
 */
import { Pool } from "pg";
import { type DailyCandle } from "../backtest/candle/engine";

const TSDB_URL = process.env.TSDB_URL
  ?? `postgres://hft:${process.env.TSDB_PASSWORD ?? "hft_local_dev"}@localhost:5544/hft`;

let pool: Pool | null = null;
/** Lazily-created shared connection pool. */
export function tsdb(): Pool {
  if (!pool) pool = new Pool({ connectionString: TSDB_URL, max: 8 });
  return pool;
}
/** Close the pool so a script's process can exit cleanly. */
export async function closeTsdb(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}

export type CandleRow = { start_unix: number; open: number; high: number; low: number; close: number; volume: number };

/** All candles for a product+granularity, ascending by time (backtest order). */
export async function getCandles(product: string, granularity: string): Promise<DailyCandle[]> {
  const r = await tsdb().query(
    `SELECT start_unix, open, high, low, close, volume FROM coinbase_candles
       WHERE product_id = $1 AND granularity = $2 ORDER BY start_unix ASC`,
    [product, granularity],
  );
  // bigint comes back as a string; doubles as numbers.
  return r.rows.map((x) => ({
    start_unix: Number(x.start_unix), open: +x.open, high: +x.high,
    low: +x.low, close: +x.close, volume: +(x.volume ?? 0),
  }));
}

/** Distinct products that have candles at this granularity, sorted. */
export async function listProducts(granularity: string): Promise<string[]> {
  const r = await tsdb().query(
    `SELECT DISTINCT product_id FROM coinbase_candles WHERE granularity = $1 ORDER BY product_id`,
    [granularity],
  );
  return r.rows.map((x) => x.product_id as string);
}

/** Per-product coverage (count + min/max start), for ingest/verify summaries. */
export async function candleRange(product: string, granularity: string): Promise<{ n: number; mn: number | null; mx: number | null }> {
  const r = await tsdb().query(
    `SELECT COUNT(*)::int n, MIN(start_unix) mn, MAX(start_unix) mx
       FROM coinbase_candles WHERE product_id = $1 AND granularity = $2`,
    [product, granularity],
  );
  const row = r.rows[0];
  return { n: row.n, mn: row.mn == null ? null : Number(row.mn), mx: row.mx == null ? null : Number(row.mx) };
}

/** Idempotent batched upsert (ON CONFLICT DO NOTHING). Returns rows inserted. */
export async function upsertCandles(product: string, granularity: string, rows: CandleRow[]): Promise<number> {
  if (!rows.length) return 0;
  const client = await tsdb().connect();
  try {
    let inserted = 0;
    const BATCH = 1000; // 1000 × 8 params = 8000 < pg's 65535 bind limit
    for (let off = 0; off < rows.length; off += BATCH) {
      const slice = rows.slice(off, off + BATCH);
      const vals: unknown[] = [];
      const tuples = slice.map((r, k) => {
        const b = k * 8;
        vals.push(product, granularity, r.start_unix, r.open, r.high, r.low, r.close, r.volume);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
      });
      const res = await client.query(
        `INSERT INTO coinbase_candles (product_id, granularity, start_unix, open, high, low, close, volume)
         VALUES ${tuples.join(",")}
         ON CONFLICT (product_id, granularity, start_unix) DO NOTHING`,
        vals,
      );
      inserted += res.rowCount ?? 0;
    }
    return inserted;
  } finally {
    client.release();
  }
}

export type SnapshotRow = {
  condition_id: string; token_id: string; question: string;
  yes_price: number | null; no_price: number | null; midpoint: number | null;
  spread: number | null; volume_24h: number | null; open_interest: number | null;
  liquidity_usd: number | null; category: string | null;
  captured_at_iso?: string | null; // original SQLite capture time (ISO UTC); falls back to now()
};

/** Append-only batch insert of Polymarket market snapshots (a time-series log;
 *  no unique key — callers mirror only NEW rows, so no dedup is needed). */
export async function insertSnapshots(rows: SnapshotRow[]): Promise<number> {
  if (!rows.length) return 0;
  const client = await tsdb().connect();
  try {
    let n = 0;
    const BATCH = 500; // 500 × 12 params = 6000 < pg's 65535 bind limit
    for (let off = 0; off < rows.length; off += BATCH) {
      const slice = rows.slice(off, off + BATCH);
      const vals: unknown[] = [];
      const tuples = slice.map((r, k) => {
        const b = k * 12;
        vals.push(r.condition_id, r.token_id, r.question, r.yes_price, r.no_price, r.midpoint, r.spread, r.volume_24h, r.open_interest, r.liquidity_usd, r.category, r.captured_at_iso ?? null);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},COALESCE($${b + 12}::timestamptz, now()))`;
      });
      const res = await client.query(
        `INSERT INTO market_snapshots (condition_id, token_id, question, yes_price, no_price, midpoint, spread, volume_24h, open_interest, liquidity_usd, category, captured_at)
         VALUES ${tuples.join(",")}
         ON CONFLICT (token_id, captured_at) DO NOTHING`,
        vals,
      );
      n += res.rowCount ?? 0;
    }
    return n;
  } finally {
    client.release();
  }
}

export type TickRow = { symbol: string; product_id: string; price: number; source: string | null; ts_unix: number };

/** Append-only batch insert of sub-minute crypto ticks. */
export async function insertTicks(rows: TickRow[]): Promise<number> {
  if (!rows.length) return 0;
  const client = await tsdb().connect();
  try {
    let n = 0;
    const BATCH = 2000; // 2000 × 5 params = 10000 < pg's 65535 bind limit
    for (let off = 0; off < rows.length; off += BATCH) {
      const slice = rows.slice(off, off + BATCH);
      const vals: unknown[] = [];
      const tuples = slice.map((r, k) => {
        const b = k * 5;
        vals.push(r.product_id, r.symbol, r.price, r.source, r.ts_unix);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
      });
      const res = await client.query(
        `INSERT INTO realtime_ticks (product_id, symbol, price, source, ts_unix) VALUES ${tuples.join(",")}`,
        vals,
      );
      n += res.rowCount ?? 0;
    }
    return n;
  } finally {
    client.release();
  }
}

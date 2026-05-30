/**
 * Momentum derivatives over 1-min candles.
 *
 *   velocity(windowMin)      = pct change over the last N candles
 *   acceleration(windowMin)  = change in velocity (velocity_now − velocity_prev)
 *   zVelocity                = velocity / rolling stdev of velocity series
 *
 * Reads from coinbase_candles. Pure-function math; the DB read is in
 * `loadRecentCandles()` so tests can supply data directly.
 */
import { db } from "@/lib/db/client";

export type Candle = {
  product_id: string;
  start_unix: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

/**
 * Loads candles for an arbitrary (exchange, instrument) pair from
 * `coindesk_candles` only (no Coinbase union). Used for OKX BNB/HYPE feeds
 * and any other non-Coinbase venue we ingest. Returns oldest-first.
 */
export function loadRecentCandlesFromCoindesk(
  market: string,
  instrument: string,
  lookbackMin = 60,
  opts: { cutoffUnix?: number; granularity?: string } = {},
): Candle[] {
  const cutoff = opts.cutoffUnix ?? Math.floor(Date.now() / 1000);
  const granularity = opts.granularity ?? "ONE_MINUTE";
  const minStart = cutoff - lookbackMin * 60;
  return db().prepare(
    `SELECT instrument AS product_id, start_unix, open, high, low, close, volume
       FROM coindesk_candles
       WHERE market = ? AND instrument = ? AND granularity = ?
         AND start_unix >= ? AND start_unix <= ?
       ORDER BY start_unix ASC`,
  ).all(market, instrument, granularity, minStart, cutoff) as Candle[];
}

/**
 * Loads recent candles for a product, UNIONING the live `coinbase_candles`
 * table with the historical-backfill `coindesk_candles` table.
 *
 * Conflict policy: when both tables have a bar at the same `start_unix`,
 * the live Coinbase row wins (it's our trading-venue source of truth).
 * The CoinDesk historical bars only fill the gaps.
 *
 * Pass `cutoffUnix` to clamp to a historical "now" (used in replay mode);
 * defaults to wall-clock now. Pass `opts.unionHistorical = false` to skip
 * the CoinDesk union (useful when you want pure-live data for live-trade
 * decisions vs backtest replays).
 */
export function loadRecentCandles(
  productId: string,
  lookbackMin = 60,
  opts: { cutoffUnix?: number; granularity?: string; unionHistorical?: boolean; coindeskMarket?: string } = {},
): Candle[] {
  const cutoff = opts.cutoffUnix ?? Math.floor(Date.now() / 1000);
  const granularity = opts.granularity ?? "ONE_MINUTE";
  const minStart = cutoff - lookbackMin * 60;
  const coindeskMarket = opts.coindeskMarket ?? "coinbase";
  const union = opts.unionHistorical !== false;

  const cbRows = db().prepare(
    `SELECT product_id, start_unix, open, high, low, close, volume
       FROM coinbase_candles
       WHERE product_id = ? AND granularity = ?
         AND start_unix >= ? AND start_unix <= ?
       ORDER BY start_unix ASC`,
  ).all(productId, granularity, minStart, cutoff) as Candle[];

  if (!union) return cbRows;

  // Skip CoinDesk lookup if the table doesn't exist yet (older DB schema).
  const tableExists = db().prepare(
    `SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'coindesk_candles'`,
  ).get() as { x: number } | undefined;
  if (!tableExists) return cbRows;

  const cdRows = db().prepare(
    `SELECT instrument AS product_id, start_unix, open, high, low, close, volume
       FROM coindesk_candles
       WHERE market = ? AND instrument = ? AND granularity = ?
         AND start_unix >= ? AND start_unix <= ?
       ORDER BY start_unix ASC`,
  ).all(coindeskMarket, productId, granularity, minStart, cutoff) as Candle[];

  if (cdRows.length === 0) return cbRows;

  // Merge: Coinbase wins on overlap, otherwise CoinDesk fills the gap.
  const byStart = new Map<number, Candle>();
  for (const r of cdRows) byStart.set(r.start_unix, r);
  for (const r of cbRows) byStart.set(r.start_unix, r); // overwrites if duplicate
  return Array.from(byStart.values()).sort((a, b) => a.start_unix - b.start_unix);
}

/** Most recent close price; undefined if no candles. */
export function latestClose(candles: Candle[]): number | undefined {
  return candles.length > 0 ? candles[candles.length - 1].close : undefined;
}

/**
 * Velocity = pct change in close over the last `windowMin` candles.
 *   v = (close_now − close_then) / close_then
 * Returns NaN if window is too short or close_then ≤ 0.
 */
export function velocity(candles: Candle[], windowMin: number): number {
  // Defensive: floor windowMin (older genomes have non-integer values, and
  // array indices must be integers — `candles[22.3]` would be undefined).
  const w = Math.floor(windowMin);
  if (candles.length < w + 1 || w < 1) return NaN;
  const nowBar = candles[candles.length - 1];
  const thenBar = candles[candles.length - 1 - w];
  if (!nowBar || !thenBar) return NaN;
  const then = thenBar.close;
  if (!(then > 0)) return NaN;
  return (nowBar.close - then) / then;
}

/**
 * Acceleration = velocity over the most-recent half-window minus velocity
 * over the prior half-window. Positive → momentum is BUILDING; negative →
 * fading. Caller supplies the full window; we split it down the middle.
 */
export function acceleration(candles: Candle[], windowMin: number): number {
  const w = Math.floor(windowMin);
  const half = Math.max(1, Math.floor(w / 2));
  if (candles.length < w + 1 || w < 2) return NaN;
  // Two adjacent half-windows ending at the most-recent candle.
  const tail = candles.slice(-1 - half);     // last (half + 1) candles
  const head = candles.slice(-1 - w, -half); // first half within the window
  const vTail = pctChange(head[head.length - 1]?.close, tail[tail.length - 1]?.close);
  const vHead = pctChange(head[0]?.close, head[head.length - 1]?.close);
  if (!Number.isFinite(vTail) || !Number.isFinite(vHead)) return NaN;
  return vTail - vHead;
}

function pctChange(then: number | undefined, now: number | undefined): number {
  if (then == null || now == null || !(then > 0)) return NaN;
  return (now - then) / then;
}

/**
 * z-score of current velocity vs the rolling distribution of K-window
 * velocities over the supplied candles. Useful to ask "is this move big
 * relative to recent moves?" rather than a fixed absolute threshold.
 */
export function zVelocity(candles: Candle[], windowMin: number): number {
  if (candles.length < windowMin * 2 + 2) return NaN;
  // Build a series of velocities at each step in the back-window.
  const vs: number[] = [];
  for (let i = windowMin; i < candles.length; i++) {
    const then = candles[i - windowMin].close;
    const now = candles[i].close;
    if (then > 0) vs.push((now - then) / then);
  }
  if (vs.length < 3) return NaN;
  const v = vs[vs.length - 1];
  const mean = vs.reduce((s, x) => s + x, 0) / vs.length;
  const variance = vs.reduce((s, x) => s + (x - mean) ** 2, 0) / (vs.length - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return NaN;
  return (v - mean) / sd;
}

/** Composite score combining velocity sign + acceleration sign. Bounded [-2, 2]. */
export function momentumScore(candles: Candle[], windowMin = 5): number {
  const v = velocity(candles, windowMin);
  const a = acceleration(candles, windowMin);
  if (!Number.isFinite(v) || !Number.isFinite(a)) return 0;
  const vSign = Math.sign(v) * Math.min(1, Math.abs(v) / 0.01); // |v|=1% → ±1
  const aSign = Math.sign(a) * Math.min(1, Math.abs(a) / 0.005); // |a|=0.5pp → ±1
  return vSign + aSign;
}

/**
 * venue-candles — one normalized candle shape across data venues (Coinbase, Kraken, …) so
 * backtests and cross-venue checks compare apples to apples. Pure parsers + a sanitizer; the
 * thin keyless fetchers live in each venue module. `VenueCandle` is the warehouse DailyCandle.
 */
export type VenueCandle = { start_unix: number; open: number; high: number; low: number; close: number; volume: number };

const pos = (x: number): boolean => Number.isFinite(x) && x > 0;

/**
 * Drop bad rows (non-finite / non-positive OHLC), sort ascending by time, and dedup by
 * start_unix (keep the FIRST occurrence). The single hygiene gate every venue parser runs
 * through — corrupt ticks never reach a backtest.
 */
export function sanitizeCandles(cands: readonly VenueCandle[]): VenueCandle[] {
  const seen = new Set<number>();
  const out: VenueCandle[] = [];
  for (const c of [...cands].sort((a, b) => a.start_unix - b.start_unix)) {
    if (!Number.isFinite(c.start_unix) || seen.has(c.start_unix)) continue;
    if (!(pos(c.open) && pos(c.high) && pos(c.low) && pos(c.close))) continue;
    if (!(Number.isFinite(c.volume) && c.volume >= 0)) continue;
    if (c.high < c.low) continue; // structurally impossible bar → drop
    seen.add(c.start_unix);
    out.push(c);
  }
  return out;
}

/**
 * Coinbase Exchange public candles. Row format is `[time, low, high, open, close, volume]`
 * (note: LOW before HIGH, OPEN third — Coinbase's ordering, not OHLC). `time` is unix seconds.
 */
export function parseCoinbaseExchangeCandles(rows: ReadonlyArray<ReadonlyArray<number | string>>): VenueCandle[] {
  return sanitizeCandles(rows.map((r) => ({
    start_unix: Number(r[0]), low: +r[1], high: +r[2], open: +r[3], close: +r[4], volume: +(r[5] ?? 0),
  })));
}

/**
 * Coinbase Advanced Trade candles (`publicGetProductCandles`): objects with string fields
 * `{ start, low, high, open, close, volume }`, `start` = unix-seconds string.
 */
export function parseCoinbaseAdvancedCandles(
  rows: ReadonlyArray<{ start: string | number; low: string | number; high: string | number; open: string | number; close: string | number; volume?: string | number }>,
): VenueCandle[] {
  return sanitizeCandles(rows.map((r) => ({
    start_unix: Number(r.start), low: +r.low, high: +r.high, open: +r.open, close: +r.close, volume: +(r.volume ?? 0),
  })));
}

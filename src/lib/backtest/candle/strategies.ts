/**
 * Daily candle strategies — each returns a position series (no lookahead:
 * position[i], held over bar i→i+1, uses only closes ≤ i). Long-flat by default.
 */
import type { DailyCandle } from "./engine";

function smaAt(closes: number[], i: number, n: number): number | null {
  if (i + 1 < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += closes[k];
  return s / n;
}
function stdAt(closes: number[], i: number, n: number, m: number): number {
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += (closes[k] - m) ** 2;
  return Math.sqrt(s / n);
}

/** Trend: long while close > SMA(n), else flat. */
export function smaTrend(candles: DailyCandle[], n: number): number[] {
  const closes = candles.map((c) => c.close);
  return closes.map((c, i) => {
    const m = smaAt(closes, i, n);
    return m != null && c > m ? 1 : 0;
  });
}

/** Donchian breakout: enter long on a new n-day high, exit on a new n-day low. */
export function donchianBreakout(candles: DailyCandle[], n: number): number[] {
  const closes = candles.map((c) => c.close);
  const pos: number[] = new Array(closes.length).fill(0);
  let cur = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i >= n) {
      let hi = -Infinity, lo = Infinity;
      for (let k = i - n; k < i; k++) { hi = Math.max(hi, closes[k]); lo = Math.min(lo, closes[k]); }
      if (closes[i] > hi) cur = 1;
      else if (closes[i] < lo) cur = 0;
    }
    pos[i] = cur;
  }
  return pos;
}

/** Mean-reversion: long when z=(close−SMA)/σ < −zEntry, flat once z ≥ zExit. */
export function zMeanReversion(candles: DailyCandle[], n: number, zEntry: number, zExit: number): number[] {
  const closes = candles.map((c) => c.close);
  const pos: number[] = new Array(closes.length).fill(0);
  let cur = 0;
  for (let i = 0; i < closes.length; i++) {
    const m = smaAt(closes, i, n);
    if (m != null) {
      const sd = stdAt(closes, i, n, m);
      const z = sd > 0 ? (closes[i] - m) / sd : 0;
      if (z < -zEntry) cur = 1;
      else if (z >= zExit) cur = 0;
    }
    pos[i] = cur;
  }
  return pos;
}

/** Baseline: always long (buy-and-hold). */
export function buyAndHold(candles: DailyCandle[]): number[] {
  return new Array(candles.length).fill(1);
}

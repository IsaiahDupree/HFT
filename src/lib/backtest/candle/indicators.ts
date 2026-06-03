/**
 * Candle indicators — all NO-LOOKAHEAD: value[i] depends only on inputs at indices ≤ i,
 * so a strategy reading indicator[i] to hold a position over bar i→i+1 never peeks ahead.
 * Pure + deterministic; the building blocks for the momentum strategies + the gauntlet.
 */
import type { DailyCandle } from "./engine";

/** Exponential moving average. ema[i] uses values[0..i]; seeded with values[0]. α = 2/(n+1).
 *  (Reacts faster than an n-bar SMA — better for intraday crypto momentum.) */
export function ema(values: number[], n: number): number[] {
  const a = 2 / (n + 1);
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : a * values[i] + (1 - a) * prev;
    out.push(prev);
  }
  return out;
}

/** True range per bar: max(high−low, |high−prevClose|, |low−prevClose|); tr[0] = high−low. */
function trueRange(candles: DailyCandle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}

/** Wilder ATR over n. atr[i] = NaN until i ≥ n−1; seeded with the SMA of the first n true
 *  ranges, then Wilder-smoothed. No lookahead (uses true ranges ≤ i only). */
export function atr(candles: DailyCandle[], n: number): number[] {
  const tr = trueRange(candles);
  const out: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < n || n < 1) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += tr[i];
  let prev = sum / n;
  out[n - 1] = prev;
  for (let i = n; i < candles.length; i++) {
    prev = (prev * (n - 1) + tr[i]) / n;
    out[i] = prev;
  }
  return out;
}

/** Wilder RSI over n (0..100). rsi[i] = NaN until i ≥ n; seeded with the average gain/loss
 *  over the first n deltas, then Wilder-smoothed. No lookahead. */
export function rsi(closes: number[], n: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= n || n < 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / n, avgL = loss / n;
  const score = (g: number, l: number) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[n] = score(avgG, avgL);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (n - 1) + (d > 0 ? d : 0)) / n;
    avgL = (avgL * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = score(avgG, avgL);
  }
  return out;
}

/** Realized volatility: sample std of the last n log-returns ending at i. vol[i] = NaN
 *  until i ≥ n. (Annualize off-line as needed.) No lookahead. */
export function realizedVol(closes: number[], n: number): number[] {
  // A non-positive price is a degenerate input → NaN (not 0): the affected vol window
  // becomes NaN so the downstream gates flatten, rather than silently reading it as a
  // legitimately low-vol bar. (Real crypto closes are > 0, so this never fires live.)
  const rets = closes.map((c, i) => {
    if (i === 0) return NaN;
    const p = closes[i - 1];
    return p > 0 && c > 0 ? Math.log(c / p) : NaN;
  });
  const out: number[] = new Array(closes.length).fill(NaN);
  if (n < 2) return out;
  for (let i = n; i < closes.length; i++) {
    let m = 0;
    for (let k = i - n + 1; k <= i; k++) m += rets[k];
    m /= n;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += (rets[k] - m) ** 2;
    out[i] = Math.sqrt(s / (n - 1));
  }
  return out;
}

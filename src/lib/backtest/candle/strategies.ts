/**
 * Daily candle strategies — each returns a position series (no lookahead:
 * position[i], held over bar i→i+1, uses only closes ≤ i). Long-flat by default.
 */
import type { DailyCandle } from "./engine";
import { ema, atr, rsi, realizedVol } from "./indicators";

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

// ── momentum-biased additions (crypto: "winners keep winning") ──────────────

/** EMA momentum: long while EMA(fast) > EMA(slow), else flat. Faster than an SMA cross. */
export function emaMomentum(candles: DailyCandle[], fast: number, slow: number): number[] {
  const closes = candles.map((c) => c.close);
  const ef = ema(closes, fast), es = ema(closes, slow);
  return closes.map((_, i) => (i >= slow && ef[i] > es[i] ? 1 : 0)); // warm up `slow` bars first
}

/** MACD trend: long while the MACD line (EMA_fast − EMA_slow) is above its signal EMA.
 *  A second, independent momentum voter to the EMA cross. */
export function macdTrend(candles: DailyCandle[], fast = 12, slow = 26, sig = 9): number[] {
  const closes = candles.map((c) => c.close);
  const ef = ema(closes, fast), es = ema(closes, slow);
  const macd = closes.map((_, i) => ef[i] - es[i]);
  const signal = ema(macd, sig);
  return closes.map((_, i) => (i >= slow + sig && macd[i] > signal[i] ? 1 : 0));
}

/** RSI momentum (NOT mean-reversion): long when RSI(n) > longAbove, flat once RSI < exitBelow.
 *  Crypto's "overbought stays overbought" — ride strength instead of fading it. */
export function rsiMomentum(candles: DailyCandle[], n: number, longAbove: number, exitBelow: number): number[] {
  const r = rsi(candles.map((c) => c.close), n);
  const pos: number[] = new Array(candles.length).fill(0);
  let cur = 0;
  for (let i = 0; i < candles.length; i++) {
    if (Number.isFinite(r[i])) {
      if (r[i] > longAbove) cur = 1;
      else if (r[i] < exitBelow) cur = 0;
    }
    pos[i] = cur;
  }
  return pos;
}

/** ATR breakout: long only when close clears the prior n-bar high by ≥ atrMult·ATR(n) — the
 *  ATR filter rejects fake tiny breakouts. Exit (flat) when close falls below the n-bar low. */
export function atrBreakout(candles: DailyCandle[], n: number, atrMult: number): number[] {
  const closes = candles.map((c) => c.close);
  const a = atr(candles, n);
  const pos: number[] = new Array(closes.length).fill(0);
  let cur = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i >= n && Number.isFinite(a[i])) {
      let hi = -Infinity, lo = Infinity;
      for (let k = i - n; k < i; k++) { hi = Math.max(hi, closes[k]); lo = Math.min(lo, closes[k]); }
      if (closes[i] > hi + atrMult * a[i]) cur = 1;
      else if (closes[i] < lo) cur = 0;
    }
    pos[i] = cur;
  }
  return pos;
}

/** Supertrend: an ATR trailing-stop trend follower. Long once close breaks the (ratcheting)
 *  upper band, flat once it breaks the lower band. Bands = (high+low)/2 ± mult·ATR(n). */
export function supertrend(candles: DailyCandle[], n: number, mult: number): number[] {
  const a = atr(candles, n);
  const pos: number[] = new Array(candles.length).fill(0);
  let finalUpper = NaN, finalLower = NaN, cur = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i >= n && Number.isFinite(a[i])) {
      const mid = (candles[i].high + candles[i].low) / 2;
      const bu = mid + mult * a[i], bl = mid - mult * a[i];
      const pc = candles[i - 1].close;
      // ratchet: the upper band only tightens (or resets after a prior break); lower mirrors.
      finalUpper = !Number.isFinite(finalUpper) ? bu : (bu < finalUpper || pc > finalUpper) ? bu : finalUpper;
      finalLower = !Number.isFinite(finalLower) ? bl : (bl > finalLower || pc < finalLower) ? bl : finalLower;
      const c = candles[i].close;
      if (c > finalUpper) cur = 1;
      else if (c < finalLower) cur = 0;
    }
    pos[i] = cur;
  }
  return pos;
}

// ── volatility-regime FILTER (gates another strategy, not standalone) ───────

/** Zero out `positions` on bars whose realized vol (over n) is outside [minVol, maxVol].
 *  Absolute-threshold gate: "trade trend/breakout only in the desired vol band." */
export function gateByVolatility(candles: DailyCandle[], positions: number[], n: number, opts: { minVol?: number; maxVol?: number } = {}): number[] {
  const v = realizedVol(candles.map((c) => c.close), n);
  const lo = opts.minVol ?? 0, hi = opts.maxVol ?? Infinity;
  return positions.map((p, i) => (Number.isFinite(v[i]) && v[i] >= lo && v[i] <= hi ? p : 0));
}

/** Self-calibrating vol-regime gate (no magic threshold): keep `positions` only when the
 *  current realized vol is in the desired half vs its TRAILING median (≤ i, so no lookahead).
 *  "high" = trade in the high-vol half (breakouts), "low" = the calm half (carry). */
export function volRegimeFilter(candles: DailyCandle[], positions: number[], n: number, regime: "high" | "low", lookback = 100): number[] {
  const v = realizedVol(candles.map((c) => c.close), n);
  const out: number[] = new Array(positions.length).fill(0);
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(v[i])) continue;
    const w: number[] = [];
    for (let k = Math.max(0, i - lookback + 1); k <= i; k++) if (Number.isFinite(v[k])) w.push(v[k]);
    if (w.length < 10) continue; // not enough history to judge the regime → flat
    w.sort((x, y) => x - y);
    const med = w.length % 2 ? w[w.length >> 1] : (w[(w.length >> 1) - 1] + w[w.length >> 1]) / 2;
    const inRegime = regime === "high" ? v[i] >= med : v[i] <= med;
    out[i] = inRegime ? positions[i] : 0;
  }
  return out;
}

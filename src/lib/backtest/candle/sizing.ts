/**
 * Position-sizing overlay — "Banded Inverse-Vol Targeting" (sizing design panel
 * winner: vol-targeting core + frontier-aligned causal window + coarse-grid
 * hysteresis). Turns a raw {0,1}/[-1,1] signal into a CONTINUOUS position that
 * down-weights fat-tailed high-vol bars (the variance-reduction channel) to
 * tighten the per-period Sharpe — WITHOUT lookahead and WITHOUT bleeding the
 * |Δposition| turnover fee every bar.
 *
 * No-lookahead: size[i] uses only closes with index ≤ i (the realized return that
 * enters the vol estimate is r[i]=close[i]/close[i-1]−1, exactly the causal
 * frontier the strategies themselves use). The future return r[i+1] is never read.
 * The band/quant compares against the previous HELD size, which by induction
 * depends only on closes < i. variantReturns is the sole place a future price
 * (close[i+1]) appears — that is the backtester earning the held position.
 */
import { type DailyCandle } from "./engine";

export type SizingParams = {
  n?: number;               // trailing window (bars) for realized-vol RMS — default 168 (1 week hourly)
  targetVolAnnual?: number; // annual vol target — default 0.30
  periodsPerYear?: number;  // bars/year for the annual→per-bar conversion — default 8760 (hourly); 365 daily
  volFloorPerBar?: number;  // floor on per-bar vol (divide-by-tiny guard) — default 0.0015 (~14% annual hourly)
  volCap?: number;          // max inverse-vol lever-up before posMax — default 1.5
  posMax?: number;          // hard upper clamp on |size| — default 1.0 (pure variance reduction, no new gross)
  sizeStep?: number;        // coarse quantization grid — default 0.25 (levels 0/0.25/0.5/0.75/1.0)
  band?: number;            // rebalance no-trade band in size units — default 0.25 (== sizeStep, hysteresis)
};

/** Apply the inverse-vol sizing overlay to a raw position series. Returns a
 *  series of the same length; size[i] ∈ [−posMax, posMax], held over bar i→i+1. */
export function applySizing(candles: DailyCandle[], rawPositions: number[], params: SizingParams = {}): number[] {
  const n = params.n ?? 168;
  const targetVolAnnual = params.targetVolAnnual ?? 0.3;
  const periodsPerYear = params.periodsPerYear ?? 8760;
  const volFloor = params.volFloorPerBar ?? 0.0015;
  const volCap = params.volCap ?? 1.5;
  const posMax = params.posMax ?? 1.0;
  const sizeStep = params.sizeStep ?? 0.25;
  const band = params.band ?? 0.25;
  const targetVolPerBar = targetVolAnnual / Math.sqrt(periodsPerYear);

  const N = candles.length;
  const out = new Array<number>(N).fill(0);
  // realized bar returns r[k] = close[k]/close[k-1] − 1 (r[0] unused); all index ≤ i used below.
  const r = new Array<number>(N).fill(0);
  for (let k = 1; k < N; k++) r[k] = candles[k].close / candles[k - 1].close - 1;
  // rolling sum of squared returns over a window of n, advanced causally.
  let ssq = 0;
  let sHeld = 0;
  for (let i = 0; i < N; i++) {
    if (i >= 1) ssq += r[i] * r[i];                 // add the just-realized return r[i] (index ≤ i)
    if (i - n >= 1) ssq -= r[i - n] * r[i - n];     // drop the one that fell out of the window
    const raw = rawPositions[i] ?? 0;
    if (i < n) { out[i] = 0; sHeld = 0; continue; } // warmup: window not full → sit out (no peek)
    const rv = Math.sqrt(ssq / n);                  // trailing RMS of returns over [i−n+1 .. i]
    const lev = Math.min(targetVolPerBar / Math.max(rv, volFloor), volCap);
    const sDesired = Math.min(Math.max(lev, 0), posMax) * raw;
    let q = Math.round(sDesired / sizeStep) * sizeStep;          // coarse grid kills sub-notch jitter
    q = Math.max(-posMax, Math.min(posMax, q));
    if (raw === 0) sHeld = 0;                        // signal owns exits — bypass the band
    else if (Math.abs(q - sHeld) >= band) sHeld = q; // moved ≥ one notch → trade
    // else: inside band → hold, |Δsize| = 0, zero fee
    out[i] = sHeld;
  }
  return out;
}

/** Total turnover Σ|posᵢ − posᵢ₋₁| of a position series (prev=0 at the start) —
 *  for the mandatory "sized turnover must not exceed baseline" fee check. */
export function turnover(positions: number[]): number {
  let t = 0, prev = 0;
  for (const p of positions) { t += Math.abs(p - prev); prev = p; }
  return t;
}

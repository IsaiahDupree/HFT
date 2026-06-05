/**
 * maker-fill — every funding/carry edge lives or dies on getting MAKER fills (~1bp) vs crossing
 * as a TAKER (~5-10bp). This (1) blends the two into an effective fee given a fill rate, and (2)
 * MEASURES that fill rate empirically from recorded L2: if you join the touch, how often does a
 * marketable order hit you within a holding window before the price moves on? Calibrate the rate
 * on real books, then re-cost the carry with the realistic effective fee → a true go/no-go.
 */
import type { MarketEvent } from "./l2/engine";

/**
 * Blended cost when a fraction `makerFillRate` of your orders rest and fill passively (maker fee)
 * and the rest must cross the spread (taker fee). The number to feed a backtest instead of an
 * optimistic flat maker fee. Clamps the rate to [0,1].
 */
export function effectiveFeeBps(makerFillRate: number, makerBps: number, takerBps: number): number {
  const r = Math.max(0, Math.min(1, makerFillRate));
  return r * makerBps + (1 - r) * takerBps;
}

export type FillCalibration = {
  fillRate: number;       // P(a touch-joining passive order fills within the window)
  opportunities: number;  // posting moments sampled (bid + ask sides)
  fills: number;
  avgTimeToFillSec: number;
  windowSec: number;
};

/**
 * Empirical maker fill rate from recorded L2 `events` (time-sorted MarketEvents). At each sampled
 * book state we "post" at both touches; a BID order fills if a SELL-aggressor trade prints at ≤ the
 * posted bid within `windowSec`, an ASK order fills if a BUY-aggressor trade prints at ≥ the posted
 * ask. `sampleEverySec` thins posting moments so consecutive near-identical book states don't
 * over-correlate the estimate. Pure + deterministic.
 */
export function calibrateMakerFillRate(events: readonly MarketEvent[], opts: { windowSec?: number; sampleEverySec?: number } = {}): FillCalibration {
  const windowSec = opts.windowSec ?? 2, sampleEverySec = opts.sampleEverySec ?? 0.5;
  let opp = 0, fills = 0, ttf = 0, lastSampleTs = -Infinity;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind !== "book") continue;
    if (e.ts - lastSampleTs < sampleEverySec) continue; // thin posting moments
    lastSampleTs = e.ts;
    const bid0 = e.bidPx, ask0 = e.askPx, t0 = e.ts, tEnd = t0 + windowSec;
    // BID side: do we get hit by a seller at/through our bid before the window ends?
    opp++;
    for (let j = i + 1; j < events.length && events[j].ts <= tEnd; j++) {
      const f = events[j];
      if (f.kind === "trade" && f.aggressor === "SELL" && f.price <= bid0) { fills++; ttf += f.ts - t0; break; }
    }
    // ASK side: do we get hit by a buyer at/through our ask?
    opp++;
    for (let j = i + 1; j < events.length && events[j].ts <= tEnd; j++) {
      const f = events[j];
      if (f.kind === "trade" && f.aggressor === "BUY" && f.price >= ask0) { fills++; ttf += f.ts - t0; break; }
    }
  }
  return { fillRate: opp ? fills / opp : 0, opportunities: opp, fills, avgTimeToFillSec: fills ? ttf / fills : 0, windowSec };
}

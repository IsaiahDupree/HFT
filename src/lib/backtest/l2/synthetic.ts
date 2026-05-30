/**
 * Deterministic synthetic market-event generator for the L2 backtester.
 * Random-walk logit midprice → book updates + (occasional) marketable trades.
 * Seeded PRNG so backtests + validation tests are reproducible. Real L2 data
 * (Polymarket WS / order_events) plugs into the same MarketEvent interface.
 */
import type { MarketEvent } from "./engine";

/** mulberry32 — small, fast, seedable PRNG (NOT crypto). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export type SyntheticOptions = {
  n?: number;          // number of book steps
  seed?: number;
  startMid?: number;   // initial probability
  sigma?: number;      // per-step belief (logit) volatility
  spread?: number;     // market spread in price units
  baseSize?: number;   // typical resting/traded size
  tradeProb?: number;  // P(a marketable trade arrives this step)
  dt?: number;         // seconds per step
};

export function generateSyntheticEvents(opts: SyntheticOptions = {}): MarketEvent[] {
  const n = opts.n ?? 2000;
  const dt = opts.dt ?? 1.0;
  const sigma = opts.sigma ?? 0.012;
  const spread = opts.spread ?? 0.03;
  const baseSize = opts.baseSize ?? 100;
  const tradeProb = opts.tradeProb ?? 0.4;
  const rand = mulberry32(opts.seed ?? 42);
  const p0 = opts.startMid ?? 0.5;
  let x = Math.log(p0 / (1 - p0));

  const events: MarketEvent[] = [];
  for (let i = 0; i < n; i++) {
    const ts = i * dt;
    x += sigma * gauss(rand);
    const mid = 1 / (1 + Math.exp(-x));
    const half = spread / 2;
    const bidPx = Math.max(0.001, mid - half);
    const askPx = Math.min(0.999, mid + half);
    events.push({ ts, kind: "book", bidPx, bidSz: baseSize * (0.5 + rand()), askPx, askSz: baseSize * (0.5 + rand()) });
    if (rand() < tradeProb) {
      const buy = rand() < 0.5; // buy aggressor lifts the ask, sell hits the bid
      events.push({ ts: ts + dt * 0.5, kind: "trade", price: buy ? askPx : bidPx, size: baseSize * (0.2 + rand()), aggressor: buy ? "BUY" : "SELL" });
    }
  }
  return events;
}

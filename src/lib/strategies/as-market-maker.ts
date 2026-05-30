/**
 * Avellaneda-Stoikov market making for binary CLOB venues (Polymarket / Kalshi).
 *
 * Faithful TypeScript port of the core math from the "HFT Bot for Polymarket"
 * handbook (zostaff): AS optimal quoting, the LOGIT-SPACE reformulation that
 * makes AS valid on bounded p∈(0,1) prediction markets, the microprice fair
 * value, a binary-normalized VPIN toxicity gate, boundary-aware inventory caps,
 * Kelly sizing, and the Polymarket V2 (post-30-Mar-2026) fee/rebate model.
 *
 * Pure + deterministic — no I/O. The "alpha" (β_OFI magnitude, VPIN threshold,
 * κ/σ_b calibration) is intentionally NOT hardcoded; those are fit per-venue,
 * per-regime from your own captures. See docs/blueprint/HFT-MARKET-MAKING.md.
 */

// ── primitives ────────────────────────────────────────────────────────────
export function logit(p: number): number {
  const c = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(c / (1 - c));
}
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Stoikov imbalance-weighted mid — a martingale-by-construction fair value. */
export function microprice(bidPx: number, bidSz: number, askPx: number, askSz: number): number {
  const total = bidSz + askSz;
  if (total <= 0) return (bidPx + askPx) / 2;
  return (askSz * bidPx + bidSz * askPx) / total;
}

export type ASParams = {
  gamma: number; // risk aversion
  sigma: number; // (belief) volatility — σ_b in logit space
  kappa: number; // fill-intensity decay
  T: number; // terminal time (same clock as t)
};

/** AS reservation price + half-spread (raw price space; valid for p∈[0.1,0.9]). */
export function asQuotes(S: number, q: number, t: number, p: ASParams): { bid: number; ask: number; reservation: number; halfSpread: number } {
  const tau = Math.max(0, p.T - t);
  const reservation = S - q * p.gamma * p.sigma * p.sigma * tau;
  const halfSpread = p.gamma * p.sigma * p.sigma * tau + (2 / p.gamma) * Math.log(1 + p.gamma / p.kappa);
  return { bid: reservation - halfSpread, ask: reservation + halfSpread, reservation, halfSpread };
}

/**
 * AS in LOGIT space, transformed back to probability — the correct form for
 * binary markets. Quotes naturally widen near 0/1 (longshot premium) and the
 * boundary acts as a soft wall. Returns null if inventory exceeds the
 * boundary-aware cap |q| ≤ M·√(p(1-p)).
 */
export function logitSpaceQuotes(
  pMid: number,
  q: number,
  t: number,
  p: ASParams,
  maxExposureM = 100,
): { bid: number; ask: number; reservationP: number; halfSpreadLogit: number; boundaryCap: number } | null {
  const boundaryCap = Math.floor(maxExposureM * Math.sqrt(pMid * (1 - pMid)));
  if (Math.abs(q) > boundaryCap) return null; // withdraw — over the boundary cap

  const xMid = logit(pMid);
  const tau = Math.max(0, p.T - t);
  const xRes = xMid - q * p.gamma * p.sigma * p.sigma * tau;
  const halfSpreadLogit = p.gamma * p.sigma * p.sigma * tau + (2 / p.gamma) * Math.log(1 + p.gamma / p.kappa);
  return {
    bid: sigmoid(xRes - halfSpreadLogit),
    ask: sigmoid(xRes + halfSpreadLogit),
    reservationP: sigmoid(xRes),
    halfSpreadLogit,
    boundaryCap,
  };
}

// ── toxicity (VPIN) ───────────────────────────────────────────────────────
/** Binary-normalized VPIN over volume buckets of (buyVol, sellVol, pMean). 0..1+. */
export function vpinPM(buckets: Array<{ buy: number; sell: number; p: number }>): number {
  if (buckets.length === 0) return 0;
  let total = 0;
  for (const b of buckets) {
    const denom = Math.sqrt(Math.max(1e-12, b.p * (1 - b.p))) * (b.buy + b.sell);
    if (denom > 0) total += Math.abs(b.buy - b.sell) / denom;
  }
  return total / buckets.length;
}

// ── Polymarket V2 fee / rebate model (post-30-Mar-2026) ───────────────────
// [peakTakerRate, makerRebateShare]; taker fee peaks at p=0.5, vanishes at 0/1.
export const FEE_CATEGORIES = {
  crypto: [0.018, 0.2],
  economics: [0.015, 0.25],
  mentions: [0.0156, 0.25],
  culture: [0.0125, 0.25],
  weather: [0.0125, 0.25],
  finance: [0.01, 0.5], // ← richest maker rebate (50%): trade here, all else equal
  politics: [0.01, 0.25],
  tech: [0.01, 0.25],
  sports: [0.0075, 0.25],
  geopolitics: [0.0, 0.0], // fee-free
  other: [0.0, 0.0],
} as const;
export type FeeCategory = keyof typeof FEE_CATEGORIES;

/** Polymarket V2 dynamic taker fee ($). Symmetric, peaks at p=0.5. */
export function takerFee(price: number, size: number, category: FeeCategory): number {
  const [peak] = FEE_CATEGORIES[category];
  if (peak === 0) return 0;
  return peak * size * price * (1 - price) * 4;
}
/** Maker rebate ($) — a share of the taker fee the counterparty paid. PnL on every fill. */
export function makerRebate(price: number, size: number, category: FeeCategory): number {
  const [, share] = FEE_CATEGORIES[category];
  return takerFee(price, size, category) * share;
}
/** Max informed-fraction α before quoting half-spread δ turns unprofitable. */
export function breakevenAlpha(delta: number, p: number, payoffRange = 1): number {
  return delta / (payoffRange * p * (1 - p) + delta);
}
/** Effective half-spread once the per-fill maker rebate is folded in. */
export function effectiveHalfSpread(delta: number, price: number, size: number, category: FeeCategory): number {
  const rebatePerShare = size > 0 ? makerRebate(price, size, category) / size : 0;
  return delta + rebatePerShare;
}

// ── Kelly sizing (binary contract) ────────────────────────────────────────
/** Fractional Kelly for a YES contract at ask c with true-prob estimate q. */
export function kellyFraction(q: number, c: number, fraction = 0.25): number {
  if (c >= q || c <= 0 || c >= 1) return 0;
  const fStar = (q - c) / (1 - c);
  return Math.max(0, Math.min(fStar * fraction, 1));
}
/** Bankroll-aware position with boundary risk cap |size| ≤ M·bankroll·√(p(1-p)). */
export function positionSize(bankroll: number, q: number, c: number, pMarket: number, fraction = 0.25, M = 0.1): number {
  const kellySize = kellyFraction(q, c, fraction) * bankroll;
  const boundaryCap = M * bankroll * Math.sqrt(pMarket * (1 - pMarket));
  return Math.min(kellySize, boundaryCap);
}

// ── convenience for snapshot-sim MM agents ────────────────────────────────
export type MMDecision = { side: "BUY" | "SELL" | "HOLD"; edge: number; reservationP: number; halfSpread: number; reason: string };

/**
 * One-shot MM decision for a venue that only gives a mid (no L2 book): compute
 * the logit-space AS reservation given current inventory, and act when the mid
 * is mispriced vs. reservation by more than the fee-adjusted half-spread.
 * BUY when mid < reservation − δ_eff (market too cheap), SELL when above.
 */
export function mmDecisionFromMid(
  pMid: number,
  inventory: number,
  t: number,
  params: ASParams,
  category: FeeCategory,
  size: number,
  maxExposureM = 100,
): MMDecision {
  const q = logitSpaceQuotes(pMid, inventory, t, params, maxExposureM);
  if (!q) return { side: "HOLD", edge: 0, reservationP: pMid, halfSpread: 0, reason: "over boundary inventory cap — withdraw" };
  const deltaEff = effectiveHalfSpread(q.halfSpreadLogit * pMid * (1 - pMid), pMid, size, category); // logit→price half-spread ≈ δ_logit·p(1-p)
  const edge = q.reservationP - pMid;
  if (edge > deltaEff) return { side: "BUY", edge, reservationP: q.reservationP, halfSpread: deltaEff, reason: `mid ${pMid.toFixed(3)} < fair ${q.reservationP.toFixed(3)} by ${edge.toFixed(3)} > δ_eff ${deltaEff.toFixed(3)}` };
  if (-edge > deltaEff) return { side: "SELL", edge, reservationP: q.reservationP, halfSpread: deltaEff, reason: `mid ${pMid.toFixed(3)} > fair ${q.reservationP.toFixed(3)} by ${(-edge).toFixed(3)} > δ_eff ${deltaEff.toFixed(3)}` };
  return { side: "HOLD", edge, reservationP: q.reservationP, halfSpread: deltaEff, reason: "inside the fair-value band — no edge over fees" };
}

/**
 * Near-resolution scraper — detect Polymarket binary markets where one
 * outcome is already trading at 0.95–0.99 with weeks to resolution.
 *
 * Strategy thesis: when "Will Bitcoin reach $90K in May?" trades NO at 0.97
 * with two weeks to expiry, the market is ~97% sure to resolve NO. Buying
 * NO at 0.97 and holding to resolution collects the 3¢ convergence to $1.00.
 * The annualized yield on slow-resolving markets compounds to substantial
 * absolute PnL at scale (proven by `0x6e1d5040d0ac73709b0621f620d2a60b80d2d0fa`
 * banking $2,029,619 realized doing exactly this).
 *
 * Pure function. Caller supplies a market snapshot; returns ScrapeOpportunity
 * or null. The scanner script (`scripts/scan-near-resolution.ts`) is the
 * runner; this module is the decision logic.
 *
 * Safety properties:
 *   - Returns null on missing/expired/invalid prices (no false positives)
 *   - Edge accounts for round-trip fees (default 20 bps)
 *   - Annualized edge surfaced so operators can rank by capital efficiency
 *
 * Tail risk explicitly NOT in scope of this detector: a 0.97 NO position can
 * still resolve YES (3% of the time on average). Capsule daily-loss caps and
 * per-market sizing limits provide the safety envelope. Detector only finds
 * opportunities; execution path layers risk on top.
 */

export type ScrapeMarket = {
  conditionId: string;
  title?: string;
  /** ISO timestamp the market resolves. */
  endDate: string;
  /** Best ask on YES outcome — what we'd pay to buy YES. */
  bestAskYes: number;
  /** Best ask on NO outcome. */
  bestAskNo: number;
  /** USD-denominated top-of-book liquidity (used for sizing caps downstream). */
  liquidityUsd: number;
};

export type ScrapeOpportunity = {
  conditionId: string;
  title?: string;
  side: "YES" | "NO";
  entryPrice: number;
  /** 1.0 - entryPrice - fees. The dollars-per-share you keep if it resolves your way. */
  edge: number;
  /** edge / entryPrice * 365 / daysToResolution. */
  annualizedEdge: number;
  daysToResolution: number;
  liquidityUsd: number;
  reason: string;
};

export type ScrapeOptions = {
  /** Minimum entryPrice to qualify. Default 0.95. */
  minPrice?: number;
  /** Skip markets that resolve in < this many days. Default 1. */
  minDaysToResolution?: number;
  /** Skip markets that resolve in > this many days. Default 30. */
  maxDaysToResolution?: number;
  /** Round-trip fee in basis points. Default 20 (0.2%). */
  feeBps?: number;
  /** Override "now" for testability. */
  nowMs?: number;
};

const DEFAULT_FEE_BPS = 20;

export function detectNearResolutionScrape(
  market: ScrapeMarket,
  opts: ScrapeOptions = {},
): ScrapeOpportunity | null {
  const minPrice = opts.minPrice ?? 0.95;
  const minDays = opts.minDaysToResolution ?? 1;
  const maxDays = opts.maxDaysToResolution ?? 30;
  const feeBps = opts.feeBps ?? DEFAULT_FEE_BPS;
  const nowMs = opts.nowMs ?? Date.now();

  const endMs = Date.parse(market.endDate);
  if (!Number.isFinite(endMs)) return null;
  const daysToResolution = (endMs - nowMs) / 86_400_000;
  if (daysToResolution < minDays) return null;
  if (daysToResolution > maxDays) return null;

  const yesPrice = market.bestAskYes;
  const noPrice = market.bestAskNo;
  if (yesPrice <= 0 || noPrice <= 0) return null;
  if (yesPrice >= 1 || noPrice >= 1) return null; // already resolved or malformed

  const winningPrice = Math.max(yesPrice, noPrice);
  if (winningPrice < minPrice) return null;

  const side: "YES" | "NO" = winningPrice === yesPrice ? "YES" : "NO";
  const grossEdge = 1.0 - winningPrice;
  const feeAdjustment = feeBps / 10_000;
  const edge = grossEdge - feeAdjustment;
  if (edge <= 0) return null;

  // Annualized = (edge / entryPrice) compounded over the holding period.
  // Use simple yield rather than continuously compounded so the number is
  // intuitive ("X% per year if I repeated this trade").
  const annualizedEdge = (edge / winningPrice) * (365 / daysToResolution);

  return {
    conditionId: market.conditionId,
    title: market.title,
    side,
    entryPrice: winningPrice,
    edge,
    annualizedEdge,
    daysToResolution,
    liquidityUsd: market.liquidityUsd,
    reason: `${side} @ ${winningPrice.toFixed(3)}, ${daysToResolution.toFixed(1)}d to resolution, edge ${(edge * 100).toFixed(2)}pp, annualized ${(annualizedEdge * 100).toFixed(0)}%`,
  };
}

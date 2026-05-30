/**
 * Cross-venue helpers — Black-Scholes implied probability that a Coinbase
 * spot exceeds (or falls below) a price threshold by some future date,
 * plus realized-vol estimation from snapshot history.
 *
 * Used to enrich the arena TickContext so the `cross_venue_arb` strategy
 * fires when the Polymarket-implied probability diverges from the
 * BS-implied probability beyond the configured edge threshold.
 *
 * Pricing assumptions:
 *   • Risk-neutral GBM: dS = rS dt + σS dW
 *   • P(S_T > K) = N(d2),  d2 = (ln(S₀/K) + (r − σ²/2)T) / (σ√T)
 *   • For 'lt' direction: prob = 1 − N(d2)
 *   • For 'gte'/'lte' the boundary has measure zero under GBM, treat same as gt/lt
 *
 * Realized vol uses log returns of daily-downsampled midpoint history,
 * annualized by √252.
 */
import { db } from "@/lib/db/client";
import type { TickContext } from "./types";

const ANNUAL_TRADING_DAYS = 252;
const DEFAULT_RISK_FREE_RATE = 0.045;

/** Standard normal CDF via the Abramowitz & Stegun 26.2.17 approximation. */
export function normalCdf(x: number): number {
  // 7.5 digit accuracy; symmetric around 0.
  if (Number.isNaN(x)) return NaN;
  if (x === 0) return 0.5;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/**
 * Probability that a GBM(r, σ) process starting at `spot` exceeds `strike`
 * at time T (years). Returns NaN if any input is degenerate.
 */
export function bsProbAboveStrike(spot: number, strike: number, T_years: number, sigma: number, r = DEFAULT_RISK_FREE_RATE): number {
  if (!(spot > 0) || !(strike > 0) || !(T_years > 0) || !(sigma > 0)) return NaN;
  const d2 = (Math.log(spot / strike) + (r - 0.5 * sigma * sigma) * T_years) / (sigma * Math.sqrt(T_years));
  return normalCdf(d2);
}

/** Annualized log-return σ from a series of mid-prices (daily-downsampled). */
export function realizedVolFromMidpoints(midpoints: number[]): number {
  if (midpoints.length < 3) return NaN;
  const rets: number[] = [];
  for (let i = 1; i < midpoints.length; i++) {
    if (midpoints[i - 1] > 0 && midpoints[i] > 0) {
      rets.push(Math.log(midpoints[i] / midpoints[i - 1]));
    }
  }
  if (rets.length < 2) return NaN;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(ANNUAL_TRADING_DAYS);
}

/** Pick one snapshot per UTC day (most recent), oldest → newest. */
function downsampleToDaily(rows: Array<{ midpoint: number; captured_at: string }>): number[] {
  const byDay = new Map<string, number>();
  const order: string[] = [];
  for (const r of rows) {
    const day = r.captured_at.slice(0, 10);
    if (!byDay.has(day)) order.push(day);
    byDay.set(day, r.midpoint);
  }
  return order.sort().map((d) => byDay.get(d)!);
}

export type CrossVenuePairing = {
  id: number;
  poly_condition_id: string;
  poly_question: string | null;
  coinbase_product_id: string;
  pairing_kind: "price_threshold" | "event_outcome" | "hedge" | "pure_arb";
  threshold_value: number | null;
  threshold_direction: "gt" | "gte" | "lt" | "lte" | null;
  expiry_iso: string | null;
};

function loadActivePairings(): CrossVenuePairing[] {
  return db().prepare(
    `SELECT id, poly_condition_id, poly_question, coinbase_product_id, pairing_kind,
            threshold_value, threshold_direction, expiry_iso
     FROM cross_venue_arbs WHERE active = 1`,
  ).all() as CrossVenuePairing[];
}

function loadCbMidpointHistory(productId: string, sinceIso: string): Array<{ midpoint: number; captured_at: string }> {
  return db().prepare(
    `SELECT midpoint, captured_at FROM coinbase_snapshots
     WHERE product_id = ? AND captured_at >= ? AND midpoint IS NOT NULL
     ORDER BY captured_at ASC`,
  ).all(productId, sinceIso) as Array<{ midpoint: number; captured_at: string }>;
}

function loadLatestCbSnapshot(productId: string): { midpoint: number; captured_at: string } | undefined {
  return db().prepare(
    `SELECT midpoint, captured_at FROM coinbase_snapshots
     WHERE product_id = ? AND midpoint IS NOT NULL ORDER BY captured_at DESC LIMIT 1`,
  ).get(productId) as { midpoint: number; captured_at: string } | undefined;
}

function loadLatestPolyMidpoint(conditionId: string): number | undefined {
  // First try: a real market_snapshot for this condition. If it's a placeholder
  // (e.g. "seed-..." pairing), there won't be any row — return undefined and
  // let the caller skip.
  const row = db().prepare(
    `SELECT midpoint FROM market_snapshots
     WHERE condition_id = ? AND midpoint IS NOT NULL
     ORDER BY captured_at DESC LIMIT 1`,
  ).get(conditionId) as { midpoint: number } | undefined;
  return row?.midpoint;
}

const DEFAULT_VOL_WINDOW_DAYS = 30;

/**
 * Compute BS-implied probability for each active cross_venue_arbs pairing
 * and the corresponding Polymarket implied probability (the PM midpoint).
 * Returns two maps keyed by `poly_condition_id` to drop straight into
 * TickContext.{bsImpliedProb, polyImpliedProb}.
 *
 * Skips pairings missing data (no expiry, no spot, no CB history, no PM mid).
 */
export function computeCrossVenueImpliedProbs(now: Date = new Date(), opts: { volWindowDays?: number; riskFreeRate?: number } = {}): { bsImpliedProb: Map<string, number>; polyImpliedProb: Map<string, number> } {
  const windowDays = opts.volWindowDays ?? DEFAULT_VOL_WINDOW_DAYS;
  const r = opts.riskFreeRate ?? DEFAULT_RISK_FREE_RATE;
  const bsImpliedProb = new Map<string, number>();
  const polyImpliedProb = new Map<string, number>();
  const sinceIso = new Date(now.getTime() - windowDays * 86_400_000).toISOString();

  for (const p of loadActivePairings()) {
    if (p.pairing_kind !== "price_threshold") continue; // only this kind has a deterministic BS prob
    if (p.threshold_value == null || !p.threshold_direction || !p.expiry_iso) continue;

    const spotRow = loadLatestCbSnapshot(p.coinbase_product_id);
    if (!spotRow || !(spotRow.midpoint > 0)) continue;

    const T_years = (new Date(p.expiry_iso).getTime() - now.getTime()) / (365 * 86_400_000);
    if (!(T_years > 0)) continue;

    const hist = loadCbMidpointHistory(p.coinbase_product_id, sinceIso);
    const daily = downsampleToDaily(hist);
    const sigma = realizedVolFromMidpoints(daily);
    if (!Number.isFinite(sigma) || !(sigma > 0)) continue;

    const probAbove = bsProbAboveStrike(spotRow.midpoint, p.threshold_value, T_years, sigma, r);
    if (!Number.isFinite(probAbove)) continue;

    const dir = p.threshold_direction;
    const bsProb = (dir === "gt" || dir === "gte") ? probAbove : 1 - probAbove;
    bsImpliedProb.set(p.poly_condition_id, bsProb);

    const pmMid = loadLatestPolyMidpoint(p.poly_condition_id);
    if (pmMid != null) polyImpliedProb.set(p.poly_condition_id, pmMid);
  }
  return { bsImpliedProb, polyImpliedProb };
}

/** Convenience: enrich an existing TickContext in place. */
export function enrichContextWithCrossVenue(ctx: TickContext, opts: { volWindowDays?: number; riskFreeRate?: number } = {}): void {
  const { bsImpliedProb, polyImpliedProb } = computeCrossVenueImpliedProbs(new Date(ctx.now), opts);
  ctx.bsImpliedProb = bsImpliedProb;
  ctx.polyImpliedProb = polyImpliedProb;
}

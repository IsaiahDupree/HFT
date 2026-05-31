/**
 * Oracle/spot agreement (PRD-04 #2) — TS port of the polymarket-2dollar-bot
 * polybot.oracle agreement math, run HERE because HFT-work has the working infra
 * (authed Polygon RPC + non-geo-blocked exchange sources) the 2dollar-bot lacks.
 *
 *   exchange_agreement_score ∈ [0,1] across Coinbase + OKX + CoinDesk + Chainlink.
 *   "Trade ONLY IF score > 0.75."  When sources disagree — especially when they
 *   STRADDLE the price_to_beat — the true price is ambiguous and the resolution
 *   source (Chainlink) can settle against an otherwise-correct directional read.
 *
 * Pure functions, unit-tested with vitest. (OKX substitutes for Binance, which is
 * geo-blocked from some egress; both are just "a second independent exchange".)
 */

export const AGREEMENT_THRESHOLD = 0.75;
/** Relative spread (max−min)/mean at which agreement hits 0. 0.5% default. */
export const DEFAULT_MAX_DISAGREEMENT = 0.005;
/** Polygon crypto/USD Chainlink feeds publish on a ~27s heartbeat. */
export const DEFAULT_HEARTBEAT_S = 27;

type Maybe = number | null | undefined;

function clean(prices: Maybe[]): number[] {
  return prices.filter((p): p is number => typeof p === "number" && isFinite(p) && p > 0);
}

/** 1.0 when sources agree tightly, 0.0 once their relative spread reaches
 *  maxDisagreement. <2 valid sources → 0 (can't corroborate → fail closed). */
export function exchangeAgreementScore(prices: Maybe[], maxDisagreement = DEFAULT_MAX_DISAGREEMENT): number {
  const vals = clean(prices);
  if (vals.length < 2) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (mean <= 0) return 0;
  const relSpread = (Math.max(...vals) - Math.min(...vals)) / mean;
  return Math.max(0, Math.min(1, 1 - relSpread / maxDisagreement));
}

/** Do all sources sit on the SAME side of priceToBeat? Straddling the target is
 *  the dangerous disagreement (#6). No target / no sources → true (side N/A). */
export function sourcesAgreeSide(prices: Maybe[], priceToBeat?: number | null): boolean {
  const vals = clean(prices);
  if (!vals.length || priceToBeat == null) return true;
  const above = vals.map((v) => v > priceToBeat);
  return above.every((b) => b) || above.every((b) => !b);
}

export type OracleAgreement = {
  score: number;
  agree: boolean; // score ≥ threshold AND sources_agree_side
  sideAgree: boolean;
  relSpread: number;
  nSources: number;
  sources: Record<string, number>;
};

export function oracleAgreement(
  sources: Record<string, Maybe>,
  opts: { priceToBeat?: number | null; threshold?: number; maxDisagreement?: number } = {},
): OracleAgreement {
  const cleaned: Record<string, number> = {};
  for (const [k, v] of Object.entries(sources)) {
    if (typeof v === "number" && isFinite(v) && v > 0) cleaned[k] = v;
  }
  const vals = Object.values(cleaned);
  const score = exchangeAgreementScore(vals, opts.maxDisagreement);
  const sideAgree = sourcesAgreeSide(vals, opts.priceToBeat);
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const relSpread = vals.length && mean ? (Math.max(...vals) - Math.min(...vals)) / mean : 1;
  const threshold = opts.threshold ?? AGREEMENT_THRESHOLD;
  return {
    score: Number(score.toFixed(4)),
    agree: score >= threshold && sideAgree,
    sideAgree,
    relSpread: Number(relSpread.toFixed(6)),
    nSources: vals.length,
    sources: cleaned,
  };
}

/** 'fresh' (< heartbeat) · 'aging' (heartbeat..staleMult×) · 'stale' (beyond). */
export function stalenessZone(age: number, heartbeat = DEFAULT_HEARTBEAT_S, staleMult = 1.5): "fresh" | "aging" | "stale" {
  if (age < heartbeat) return "fresh";
  if (age < heartbeat * staleMult) return "aging";
  return "stale";
}

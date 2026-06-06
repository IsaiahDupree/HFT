/**
 * recommendation — the AFFIRMATIVE trade recommendation the policy audit found structurally MISSING. The code
 * was "rigorous but paralyzed": edges got detected, falsified, and paper-tracked, then died at "armed" because
 * nothing was allowed to say "take this trade." This is the pro-trading half of the policy — a structured
 * recommendation in the mandated decision format, with UNCERTAINTY-ADJUSTED (fractional-Kelly) sizing. It is
 * pure surfacing: it changes NO execution gate (anti-delusion guardrails stay load-bearing) — it just lets the
 * intelligence layer reach an explicit DEPLOY / WATCH / STAND_ASIDE verdict instead of a terminal "armed".
 */

export type FinalAction = "DEPLOY" | "WATCH" | "STAND_ASIDE";

export type TradeRecommendation = {
  market: string;                 // instrument / marketKey
  impliedProb: number | null;     // market-implied probability (prediction markets) — null for carry/basis
  estimatedProb: number | null;   // our estimate — null when not a probability bet
  edgePct: number;                // the edge: net APR (carry) or win−implied points (consensus), in %
  confidence: number;             // 0..1 — how sure we are the edge is real (persistence, forward-confirm, depth)
  liquidityUsd: number | null;    // available depth for the hedge/fill
  suggestedSizeUsd: number;       // uncertainty-adjusted (fractional-Kelly) size
  reasoning: string;
  tailRisk: string;               // what could make this wrong
  copySignal: string | null;      // the copy-trade source, if any
  finalAction: FinalAction;
};

/** Kelly fraction for a binary prediction-market bet at `impliedProb` we estimate wins at `estProb` (YES side). */
export function kellyFraction(estProb: number, impliedProb: number): number {
  if (!(impliedProb > 0 && impliedProb < 1) || !(estProb >= 0 && estProb <= 1)) return 0;
  const b = (1 - impliedProb) / impliedProb;           // net odds (win pays b per 1 staked)
  const f = (b * estProb - (1 - estProb)) / b;          // Kelly criterion
  return Math.max(0, f);
}

export type SizeOpts = { bankrollUsd: number; kellyMultiplier?: number; maxFractionPerName?: number; minTicketUsd?: number; maxTicketUsd?: number };
/**
 * Uncertainty-adjusted size: a FRACTION of bankroll, fractional-Kelly (never full Kelly — ruin avoidance),
 * scaled by confidence, hard-capped per name. Returns 0 below the min ticket (don't deploy dust).
 */
export function suggestSize(rawKellyFraction: number, confidence: number, opts: SizeOpts): number {
  const mult = opts.kellyMultiplier ?? 0.25;            // quarter-Kelly default
  const capFrac = opts.maxFractionPerName ?? 0.05;      // never more than 5% of bankroll on one name
  const minT = opts.minTicketUsd ?? 20, maxT = opts.maxTicketUsd ?? Infinity;
  const frac = Math.min(Math.max(rawKellyFraction, 0) * mult * Math.max(0, Math.min(1, confidence)), capFrac);
  const size = Math.min(Math.max(frac * opts.bankrollUsd, 0), maxT);
  return size >= minT ? Math.round(size) : 0;
}

/** Pretty-print a recommendation in the policy's mandated decision format. */
export function formatRecommendation(r: TradeRecommendation): string {
  const pct = (x: number | null) => (x == null ? "—" : `${(x <= 1 && x >= -1 ? x * 100 : x).toFixed(1)}%`);
  return [
    `- Market: ${r.market}`,
    `- Implied probability: ${pct(r.impliedProb)}`,
    `- Estimated probability: ${pct(r.estimatedProb)}`,
    `- Edge: ${r.edgePct >= 0 ? "+" : ""}${r.edgePct.toFixed(1)}%`,
    `- Confidence: ${(r.confidence * 100).toFixed(0)}%`,
    `- Liquidity: ${r.liquidityUsd == null ? "—" : `$${(r.liquidityUsd / 1000).toFixed(0)}k`}`,
    `- Suggested size: $${r.suggestedSizeUsd}`,
    `- Reasoning: ${r.reasoning}`,
    `- What could make this wrong: ${r.tailRisk}`,
    `- Copy-trade signal: ${r.copySignal ?? "none"}`,
    `- Final action: ${r.finalAction}`,
  ].join("\n");
}

import { applyRiskSizing } from "./risk-sizing";

export type CarryRecInput = { instrument: string; netApr: number; grossApr: number; executable: boolean; persistence?: number; depthUsd?: number | null; bankrollUsd: number; tailRisk?: string; copySignal?: string | null };
/**
 * Build a carry/basis recommendation. DEPLOY only when executable AND net edge clears; confidence from
 * persistence; size = fractional-Kelly proxy (edge/“variance” via a capped APR→fraction map), confidence-scaled.
 */
export function carryRecommendation(c: CarryRecInput): TradeRecommendation {
  const confidence = Math.max(0, Math.min(1, (c.persistence ?? 0.7))) * (c.executable ? 1 : 0.4);
  // APR→Kelly-ish fraction: treat net APR as the per-period edge; cap the implied fraction so 30%+ APR ≈ full cap.
  const kellyish = Math.max(0, c.netApr) / 30;          // 30% net APR maps to the per-name cap
  const baseSize = c.executable ? suggestSize(kellyish, confidence, { bankrollUsd: c.bankrollUsd }) : 0;
  // risk-budget scaling: cap the size at a fraction of the hedge's available DEPTH (can't fill/unwind otherwise)
  const size = applyRiskSizing(baseSize, { sizeUsd: baseSize, liquidityUsd: c.depthUsd ?? undefined });
  const finalAction: FinalAction = c.executable && c.netApr > 0 && size > 0 ? "DEPLOY" : Math.abs(c.grossApr) >= 13 ? "WATCH" : "STAND_ASIDE";
  return {
    market: c.instrument, impliedProb: null, estimatedProb: null, edgePct: c.netApr,
    confidence, liquidityUsd: c.depthUsd ?? null, suggestedSizeUsd: size,
    reasoning: `delta-neutral carry, net ${c.netApr.toFixed(1)}% APR (gross ${c.grossApr.toFixed(1)}%), persistence ${((c.persistence ?? 0) * 100).toFixed(0)}%${c.executable ? ", hedge fills" : ", NOT executable"}`,
    tailRisk: c.tailRisk ?? "funding/basis flip, hedge can't be unwound at size, leg blows out in a squeeze",
    copySignal: c.copySignal ?? null, finalAction,
  };
}

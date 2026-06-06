/**
 * Decision-pipeline gate wrappers (Phase 2).
 *
 * Each gate is a pure function: `(DecisionContext, gate-specific config) →
 * GateResult`. They wrap existing checks where possible (rather than
 * re-implementing them) so the pipeline is additive — the same code paths
 * still enforce their behavior independently when the pipeline isn't in
 * the call chain.
 *
 * Five wrappers live here (the regime gate is in regime.ts because it has
 * non-trivial classifier math):
 *
 *   - dataQualityGate       Snapshot staleness / sanity. v1 = stub (PASS).
 *                            v2 will check tick freshness + spread sanity.
 *   - marketEligibilityGate Liquidity + spread + allowed-asset checks.
 *   - edgeGate              Reads proposal.metadata.edge / .feeBps + scores.
 *   - riskGate              Stub for v1 — defers to existing capsule/
 *                            risk-engine layer for actual enforcement.
 *                            v2 (Phase 9) hooks up the Global Risk Governor.
 *   - executionGate         Stub for v1 — depth-of-book + duplicate-order
 *                            check is future work.
 *
 * Pure: no DB, no I/O. The pipeline orchestrator is the only consumer.
 */
import { Gate, type DecisionContext, type GateResult } from "./types";
import { estimateSlippage } from "./slippage";
import { riskAdjustedMultiplier } from "./risk-sizing";

// ─── data quality ──────────────────────────────────────────────────────────

export function dataQualityGate(_ctx: DecisionContext): GateResult {
  // v1 stub — assumes inputs are fresh. v2 will:
  //   - validate snapshot.ticks max-age vs threshold
  //   - check price-feed agreement across sources (when we have ≥2 sources)
  //   - flag wick outliers
  return Gate.pass("data_quality", 1.0, "v1 stub — staleness checks deferred to v2");
}

// ─── market eligibility ────────────────────────────────────────────────────

export type MarketEligibilityConfig = {
  /** Min top-of-book liquidity in USD. Default 1000. */
  minLiquidityUsd?: number;
  /** Max bid-ask spread (as fraction of mid). Default 0.10 (10pp wide). */
  maxSpreadFrac?: number;
  /** If supplied, the proposal.symbol must be in this list. */
  allowedSymbols?: readonly string[];
};

export function marketEligibilityGate(
  ctx: DecisionContext,
  cfg: MarketEligibilityConfig = {},
): GateResult {
  const minLiquidity = cfg.minLiquidityUsd ?? 1000;
  const maxSpread = cfg.maxSpreadFrac ?? 0.10;

  // Allowed-symbol veto (hard reject).
  if (cfg.allowedSymbols && cfg.allowedSymbols.length > 0) {
    if (!cfg.allowedSymbols.includes(ctx.proposal.symbol)) {
      return Gate.reject(
        "market_eligibility",
        `symbol '${ctx.proposal.symbol}' not in allowed list`,
        { allowedSymbols: [...cfg.allowedSymbols] },
      );
    }
  }

  const liquidity = ctx.snapshot?.liquidityUsd;
  if (liquidity !== undefined && liquidity < minLiquidity) {
    return Gate.reject(
      "market_eligibility",
      `top-of-book liquidity $${liquidity.toFixed(0)} < minimum $${minLiquidity}`,
      { liquidity, minLiquidity },
    );
  }

  const bid = ctx.snapshot?.bestBid;
  const ask = ctx.snapshot?.bestAsk;
  if (bid !== undefined && ask !== undefined && bid > 0 && ask > 0) {
    const mid = (bid + ask) / 2;
    const spreadFrac = mid > 0 ? (ask - bid) / mid : 0;
    if (spreadFrac > maxSpread) {
      return Gate.reduce(
        "market_eligibility",
        Math.max(0.2, 1 - spreadFrac / maxSpread),
        `spread ${(spreadFrac * 100).toFixed(1)}% > max ${(maxSpread * 100).toFixed(1)}%`,
        { spreadFrac, maxSpread },
      );
    }
  }

  return Gate.pass("market_eligibility", 1.0, "venue + liquidity + spread checks passed");
}

// ─── edge ──────────────────────────────────────────────────────────────────

export type EdgeConfig = {
  /** Min |edge| (after fees) to score 1.0. Default 0.05 (5pp). */
  edgeThreshold?: number;
  /** Round-trip fee in basis points. Default 20. */
  feeBps?: number;
};

export function edgeGate(ctx: DecisionContext, cfg: EdgeConfig = {}): GateResult {
  const threshold = cfg.edgeThreshold ?? 0.05;
  const feeBps = cfg.feeBps ?? 20;

  // Convention: strategy stamps the proposal with metadata.edge (signed) or
  // metadata.expectedValue. Pipeline reads whichever is present; absence
  // means strategy didn't quantify edge → pass with 0.7 (neutral).
  const meta = ctx.proposal.metadata ?? {};
  const rawEdge = typeof meta.edge === "number" ? meta.edge : (typeof meta.expectedValue === "number" ? meta.expectedValue : null);
  if (rawEdge === null || !Number.isFinite(rawEdge)) {
    return Gate.pass("edge", 0.7, "no edge quantified by strategy (neutral)");
  }
  const absEdge = Math.abs(rawEdge);
  const feeAdj = feeBps / 10_000;

  // Slippage adjustment (Phase 15) — when an L2 order book is supplied
  // in ctx.snapshot.orderBook, estimate realistic fill VWAP and subtract
  // the impact (in price-pp) from edge. The edge gate's threshold is
  // applied to the slippage-adjusted edge, NOT top-of-book.
  let slippageAdj = 0;
  let slippageDetails: Record<string, unknown> | undefined;
  if (ctx.snapshot?.orderBook) {
    const est = estimateSlippage(ctx.proposal.side, ctx.proposal.sizeUsd, ctx.snapshot.orderBook);
    if (est.filled_size_usd > 0 && Number.isFinite(est.impact_bps)) {
      // impact_bps → price-points (divide by 10_000); subtract from edge.
      slippageAdj = est.impact_bps / 10_000;
      slippageDetails = {
        slippage_bps: est.impact_bps,
        vwap: est.vwap,
        top_of_book: est.top_of_book,
        partial_fill: est.partial_fill,
      };
    } else if (est.partial_fill && est.filled_size_usd === 0) {
      // Book has nothing on our side — reject outright.
      return Gate.reject("edge", "no liquidity on requested side", { sideRequested: ctx.proposal.side });
    }
  }

  const netEdge = absEdge - feeAdj - slippageAdj;
  const details: Record<string, unknown> = { absEdge, feeAdj, netEdge, threshold, ...(slippageDetails ?? {}) };

  if (netEdge <= 0) {
    return Gate.reject(
      "edge",
      `edge ${(absEdge * 100).toFixed(2)}pp ≤ fee ${(feeAdj * 100).toFixed(2)}pp + slippage ${(slippageAdj * 100).toFixed(2)}pp — no net edge`,
      details,
    );
  }
  if (netEdge < threshold) {
    // Score linearly maps [0, threshold] → [0, 1].
    const score = Math.max(0, Math.min(1, netEdge / threshold));
    return Gate.reduce(
      "edge",
      score,
      `net edge ${(netEdge * 100).toFixed(2)}pp < threshold ${(threshold * 100).toFixed(2)}pp (after ${(feeAdj * 100).toFixed(2)}pp fee + ${(slippageAdj * 100).toFixed(2)}pp slip)`,
      details,
    );
  }
  // netEdge ≥ threshold — full score, capped at 1 with a soft ceiling above
  // 2× threshold (so 10pp on a 5pp threshold doesn't dominate the score).
  const score = Math.min(1, 0.8 + 0.2 * Math.min(1, (netEdge - threshold) / threshold));
  return Gate.pass(
    "edge",
    score,
    `net edge ${(netEdge * 100).toFixed(2)}pp ≥ threshold ${(threshold * 100).toFixed(2)}pp (after ${(feeAdj * 100).toFixed(2)}pp fee + ${(slippageAdj * 100).toFixed(2)}pp slip)`,
    details,
  );
}

// ─── risk ──────────────────────────────────────────────────────────────────

/**
 * Risk gate — v1 stub. The actual per-capsule + global risk enforcement still
 * lives in `capsules/gate.ts` and `risk/engine.ts` and runs INDEPENDENTLY of
 * this pipeline. We surface a passing GateResult so the pipeline gives the
 * risk dimension non-zero weight; v2 (Phase 9) will wrap the real engines.
 */
export function riskGate(ctx: DecisionContext): GateResult {
  // Real uncertainty-/risk-budget-adjusted SIZING (was a v1 pass-through stub). Continuous size_multiplier, not
  // reject/pass: cap the order at a fraction of available book DEPTH so it can actually fill/unwind. The
  // DRAWDOWN + CORRELATION factors of riskAdjustedMultiplier activate automatically once live capsule daily-PnL
  // and correlated-exposure are threaded into DecisionContext (TODO) — until then this does liquidity sizing.
  const { multiplier, reasons } = riskAdjustedMultiplier({ sizeUsd: ctx.proposal.sizeUsd, liquidityUsd: ctx.snapshot?.liquidityUsd });
  return Gate.pass("risk", multiplier, `risk sizing — ${reasons.join("; ")}`);
}

// ─── execution ─────────────────────────────────────────────────────────────

/**
 * Execution gate — v1 stub. Future: depth-of-book check, duplicate-order
 * detection, exchange health probe. v1 just confirms required proposal
 * fields are present.
 */
export function executionGate(ctx: DecisionContext): GateResult {
  const p = ctx.proposal;
  if (!Number.isFinite(p.sizeUsd) || p.sizeUsd <= 0) {
    return Gate.reject("execution", `invalid sizeUsd ${p.sizeUsd}`);
  }
  if (!Number.isFinite(p.price) || p.price <= 0 || p.price >= 1) {
    // For binary markets, prices live in (0, 1). v2 can relax this for
    // non-binary venues by reading venue-specific bounds.
    if (p.venue === "polymarket" || p.venue === "kalshi") {
      return Gate.reject("execution", `price ${p.price} outside (0, 1) for binary venue`);
    }
  }
  return Gate.pass("execution", 1.0, "proposal fields valid");
}

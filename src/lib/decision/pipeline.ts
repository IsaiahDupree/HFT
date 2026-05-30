/**
 * Decision pipeline orchestrator.
 *
 * Walks the per-trade gates in canonical order, collects each gate's
 * `GateResult`, computes the weighted approval score, buckets it into a
 * `Decision`, and returns the final `DecisionResult` to the caller.
 *
 * Order (matches PRD §2 state machine):
 *
 *   data_quality       → trustworthy input?
 *   market_eligibility → tradeable conditions?
 *   regime             → does market regime match strategy preference?
 *   edge               → expected value clears fees + threshold?
 *   risk               → capsule + global limits respected?
 *   execution          → order is well-formed and submittable?
 *
 * Pipeline is additive — it never amplifies size, only reduces or rejects.
 * Hard wins:
 *   - Any gate KILL_SWITCH → decision='KILL_SWITCH' regardless of score
 *   - Any gate REJECT      → decision='REJECTED' regardless of score
 *
 * Pure with respect to its inputs: side effects (decision_journal write,
 * order submission) happen in the caller (`live-capsule.ts` in shadow mode
 * starting in Phase 2.8; active execution in Phase 3).
 *
 * Strategy preference for regime is passed in via `strategyRegimes` because
 * different deployments source it differently — gen-2 strategies have it in
 * spec_json, gen-1 doesn't have it yet (Phase 5 backfills). Default ["any"]
 * means "no regime preference."
 */
import {
  dataQualityGate,
  edgeGate,
  executionGate,
  marketEligibilityGate,
  riskGate,
  type EdgeConfig,
  type MarketEligibilityConfig,
} from "./gates";
import { governorGate } from "./gates/governor";
import { signalAgreementGate } from "./gates/signal-agreement";
import { classifyRegime, regimeFitScore, type Regime } from "./regime";
import { finalizeDecision } from "./score";
import { Gate, type DecisionContext, type DecisionResult, type GateResult } from "./types";

export type PipelineOptions = {
  /** Strategy's preferred regimes ("any" = no preference). Default ["any"]. */
  strategyRegimes?: readonly string[];
  /** Market-eligibility tuning. */
  marketEligibility?: MarketEligibilityConfig;
  /** Edge gate tuning. */
  edge?: EdgeConfig;
  /** Force a fixed decision timestamp (for tests). */
  nowIso?: string;
  /**
   * Skip the governor gate (Phase 9). Useful for unit tests that don't
   * want to spin up a DB connection. Default false in prod — every real
   * pipeline call goes through the governor.
   */
  skipGovernor?: boolean;
};

export function runDecisionPipeline(
  ctx: DecisionContext,
  opts: PipelineOptions = {},
): DecisionResult {
  const gateResults: GateResult[] = [];

  // 1. Data quality (stub v1; PRD §5.5 expands in v2)
  gateResults.push(dataQualityGate(ctx));

  // 2. Market eligibility
  gateResults.push(marketEligibilityGate(ctx, opts.marketEligibility));

  // 3. Regime — classifier + match against strategy preference
  gateResults.push(buildRegimeResult(ctx, opts.strategyRegimes ?? ["any"]));

  // 4. Signal-agreement — counts UNIQUE independent signal clusters
  //    (Phase 14). Strategies attach signals[] to proposal.metadata.
  gateResults.push(signalAgreementGate(ctx));

  // 5. Edge
  gateResults.push(edgeGate(ctx, opts.edge));

  // 5. Risk (v1 stub for per-trade — capsules/gate.ts + risk/engine.ts still
  // enforce independently; governor handles portfolio-level checks below)
  gateResults.push(riskGate(ctx));

  // 6. Governor — Global Risk Governor (Phase 9): same-trade collision,
  // correlated-exposure cap, strategy-family cap, reserve floor.
  if (!opts.skipGovernor) {
    try {
      gateResults.push(governorGate(ctx));
    } catch (err) {
      // Defensive: any DB / load failure → log a permissive pass so the
      // pipeline doesn't blow up on transient infra issues. The per-capsule
      // gates still enforce their own limits.
      gateResults.push({
        gate: "governor",
        status: "partial",
        score: 0.7,
        action: "WAIT",
        reason: `governor unavailable (${(err as Error).message?.slice(0, 100)})`,
      });
    }
  }

  // 7. Execution
  gateResults.push(executionGate(ctx));

  // Signal-agreement is a future v2 work item (PRD §6 — cross-strategy
  // ensemble). For now we don't insert it; the DEFAULT_GATE_WEIGHTS map
  // re-normalizes by present weights so the score isn't dragged down.

  return finalizeDecision(gateResults, undefined, opts.nowIso ?? new Date().toISOString());
}

/** Build the regime gate output by classifying + comparing to strategy preference. */
function buildRegimeResult(
  ctx: DecisionContext,
  strategyRegimes: readonly string[],
): GateResult {
  const cls = classifyRegime(ctx.snapshot?.ticks);
  const fit = regimeFitScore(cls.regime as Regime, strategyRegimes);
  const details = {
    regime: cls.regime,
    confidence: cls.confidence,
    efficiency: cls.efficiency,
    sigma_total: cls.sigma_total,
    strategy_regimes: [...strategyRegimes],
    matched: fit.matched,
  };

  // news_shock + strategy doesn't allow it → hard reject
  if (cls.regime === "news_shock" && !strategyRegimes.map((s) => s.toLowerCase()).includes("news_shock")) {
    return Gate.reject(
      "regime",
      `news_shock detected (sigma=${cls.sigma_total.toFixed(4)}) and strategy doesn't list it`,
      details,
    );
  }

  if (fit.matched) {
    return Gate.pass(
      "regime",
      fit.score,
      `${cls.regime}: ${cls.reason} (strategy match)`,
      details,
    );
  }

  // Mismatch — reduce, don't reject (the score modulation already penalizes)
  return Gate.reduce(
    "regime",
    fit.score,
    `${cls.regime} doesn't match strategy regimes ${JSON.stringify(strategyRegimes)} — ${cls.reason}`,
    details,
  );
}

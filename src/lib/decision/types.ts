/**
 * Types for the gated decision system.
 *
 * Every per-trade decision moves through a state machine:
 *
 *   SCAN → CANDIDATE → SIGNAL_AGREE → REGIME → EDGE → RISK
 *        → EXECUTION → APPROVED → MANAGED → EXIT → REVIEWED
 *
 * Each transition is guarded by a Gate that emits a `GateResult`. The
 * orchestrator collects results, computes a weighted approval score, and
 * returns a `DecisionResult` to the caller (usually `live-capsule.ts`).
 *
 * Design principles:
 *   - Gates are pure where possible — they accept a `DecisionContext` and a
 *     gate-specific input bundle, and return a `GateResult`. Side effects
 *     (journal writes, DB updates) happen in the orchestrator.
 *   - GateResult is a closed envelope — every gate returns the same shape.
 *     Adding a new gate is one file + one entry in the pipeline registry.
 *   - The pipeline is additive: it can only REDUCE size or REJECT. It never
 *     amplifies a trade beyond what the existing per-capsule + global risk
 *     gates already allow.
 *
 * See:
 *   - docs/prd/gated-decision-system-2026-05-27.md (PRD)
 *   - docs/prds/IMPLEMENTATION-PLAN-gated-decision-system.md (plan)
 */

/**
 * The seven actions any gate can emit. CONTINUE is the only "pass" — every
 * other outcome shapes the trade decision in some way.
 */
export type GateAction =
  | "CONTINUE"          // gate passes, proceed
  | "WAIT"              // gate undecided; orchestrator may retry later
  | "RECHECK"           // gate signals upstream data needs refresh
  | "REDUCE_SIZE"       // gate passes but with a size_multiplier < 1
  | "HEDGE_OR_OFFSET"   // gate requires a paired hedge before approval
  | "REJECT"            // gate vetoes this specific trade
  | "KILL_SWITCH";      // gate trips a system-wide halt (sticky; manual reset)

/**
 * A single gate's output. Status is binary; action is nuanced. Score is
 * what flows into the weighted approval-score calculation.
 */
export type GateStatus = "pass" | "fail" | "partial";

export type GateResult = {
  /** Stable identifier for this gate. Used by the journal + UI. */
  gate: string;
  status: GateStatus;
  /** 0..1. Higher = more confident this gate approves. */
  score: number;
  action: GateAction;
  /** Human-readable explanation. Surfaced in /decisions UI. */
  reason: string;
  /** Optional structured payload — gate-specific. */
  details?: Record<string, unknown>;
};

/** Helpers for constructing common GateResult shapes. */
export const Gate = {
  pass(gate: string, score: number, reason: string, details?: Record<string, unknown>): GateResult {
    return { gate, status: "pass", score: clamp01(score), action: "CONTINUE", reason, details };
  },
  reject(gate: string, reason: string, details?: Record<string, unknown>): GateResult {
    return { gate, status: "fail", score: 0, action: "REJECT", reason, details };
  },
  reduce(gate: string, score: number, reason: string, details?: Record<string, unknown>): GateResult {
    return { gate, status: "partial", score: clamp01(score), action: "REDUCE_SIZE", reason, details };
  },
  wait(gate: string, reason: string, details?: Record<string, unknown>): GateResult {
    return { gate, status: "partial", score: 0, action: "WAIT", reason, details };
  },
  killSwitch(gate: string, reason: string, details?: Record<string, unknown>): GateResult {
    return { gate, status: "fail", score: 0, action: "KILL_SWITCH", reason, details };
  },
} as const;

/**
 * Context every gate receives. Built once per proposed trade; immutable
 * across gates so each gate sees the same snapshot. Strategy-specific data
 * lives in `proposal.metadata`.
 */
export type DecisionContext = {
  /** Source agent for the trade (paper_agents.id). */
  agentId: number;
  /** Capsule ID this trade is bound to. */
  capsuleId: string;
  /** Strategy version owning the decision (NULL if pre-versioning). */
  strategyVersionId?: number;
  /** Genome kind / strategy family identifier (e.g. "poly_short_binary_directional"). */
  strategyKind: string;
  /** The order proposal — venue-agnostic. */
  proposal: {
    venue: string;
    /** Market identifier within the venue. */
    symbol: string;
    side: "BUY" | "SELL";
    /** USD notional being committed. Caller pre-clamps to capsule limits. */
    sizeUsd: number;
    /** Limit price (or expected fill for marketable orders). */
    price: number;
    /** Polymarket conditionId / Coinbase product / etc. */
    conditionId?: string;
    /** Free-form per-strategy payload — visible to gates. */
    metadata?: Record<string, unknown>;
  };
  /** Market snapshot used by edge / regime / data-quality gates. */
  snapshot?: {
    midPrice?: number;
    bestBid?: number;
    bestAsk?: number;
    liquidityUsd?: number;
    /** Recent underlying price ticks for regime detection. */
    ticks?: { ts: number; price: number }[];
    /** Trailing 24h realized vol percentile, if available. */
    volPercentile?: number;
    /**
     * Optional L2 order book — when supplied, the edge gate (Phase 15)
     * subtracts realistic fill-price slippage from the model edge before
     * comparing to threshold.
     */
    orderBook?: {
      bids: { price: number; size: number }[];
      asks: { price: number; size: number }[];
    };
  };
  /** ISO timestamp at decision time. */
  ts: string;
};

/**
 * Final decision after the pipeline runs. `decision` is the bucketed
 * outcome the caller acts on; `size_multiplier` is the modulation that
 * `live-capsule.ts` applies on top of its existing clamps.
 *
 * Bucketing per PRD §2:
 *   score > 0.80  → APPROVED_FULL     (size_multiplier = 1.0)
 *   0.65–0.80     → APPROVED_REDUCED  (size_multiplier ∈ [0.5, 0.9])
 *   0.50–0.65     → WATCHLIST         (paper only, size_multiplier = 0)
 *   < 0.50        → REJECTED          (no submit, size_multiplier = 0)
 *
 * Any gate returning KILL_SWITCH overrides bucketing → decision = KILL_SWITCH.
 */
export type Decision =
  | "APPROVED_FULL"
  | "APPROVED_REDUCED"
  | "WATCHLIST"
  | "REJECTED"
  | "KILL_SWITCH";

export type DecisionResult = {
  decision: Decision;
  /** Weighted aggregate of gate scores. 0..1. */
  approval_score: number;
  /** Multiplier the caller applies on the proposed sizeUsd. 0..1. */
  size_multiplier: number;
  /** Every gate's individual result, in pipeline order. */
  gate_results: GateResult[];
  /** ISO timestamp the decision was finalized. */
  decision_ts: string;
};

/** Gate-weight contract for the weighted score calculation. */
export type GateWeights = Record<string, number>;

/**
 * Default weights from PRD §2. Must sum to 1.0. Gates not in this map
 * contribute to the score with weight 0 — i.e. they're informational
 * unless promoted into the weight map.
 */
export const DEFAULT_GATE_WEIGHTS: GateWeights = {
  data_quality: 0.15,
  market_eligibility: 0.10,
  regime: 0.15,
  signal_agreement: 0.15,
  edge: 0.15,
  risk: 0.10,
  governor: 0.15,
  execution: 0.05,
};

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

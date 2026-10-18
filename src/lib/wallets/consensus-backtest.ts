/**
 * Consensus-signal backtester — the platform's central thesis test.
 *
 * `src/lib/wallets/consensus.ts` produces signals where N tracked wallets
 * agree on a market's direction within a time window. The thesis: *those*
 * signals are actionable (minutes-to-hours edge), even when copying a single
 * whale isn't.
 *
 * This module measures whether that's actually true. For each consensus
 * signal whose market has since resolved, settle the implied bet:
 *
 *   - direction is bullish on YES → BUY YES at avg signal price + slippage
 *   - direction is bearish on YES → BUY NO at (1 − avg signal price) + slippage
 *
 * Then PnL: WIN ⇒ (1 − p_entry)/p_entry per $1, LOSS ⇒ −1.
 *
 * Pure function — no DB, no HTTP. The caller supplies the consensus signals
 * + a `resolvedByCondition` map (same shape as the resolved-outcome scorer).
 */

import type { ConsensusSignal } from "./consensus";
import type { ResolvedMarket } from "./copy-backtest";

export type ConsensusBacktestOpts = {
  /** USD size to copy per signal. Default: 100. */
  sizeUsd?: number;
  /** Slippage tiers in bps to evaluate. Default: [0, 30, 100, 300]. */
  slippageBpsTiers?: number[];
  /** Per-leg fee bps. Default: 0. */
  feeBps?: number;
  /** Minimum distinct resolved signals before grading copyability above "insufficient". Default: 5. */
  minDistinctSignals?: number;
  /**
   * How to read `signal.direction` against the market's outcomes:
   *   - "yes_keyword": treat /yes|up|over|long|buy/i as bullish on the first
   *     listed outcome; anything else as bearish.
   *   - "outcome_index": signal.direction is the literal outcome index
   *     ("0" or "1") — useful when consensus producer already resolved it.
   * Default: "yes_keyword".
   */
  directionMode?: "yes_keyword" | "outcome_index";
};

export type ConsensusBucket = {
  slippage_bps: number;
  n_signals: number;
  n_wins: number;
  win_rate: number;
  pnl_usd: number;
  pnl_pct: number;
  avg_winner_multiple: number;
};

export type ConsensusBacktestResult = {
  size_usd: number;
  fee_bps: number;
  signals_seen: number;
  signals_used: number;
  signals_skipped_unresolved: number;
  signals_skipped_indecipherable: number;
  buckets: ConsensusBucket[];
  best_slippage_bps: number | null;
  best_pnl_usd: number;
  verdict: {
    rating: "insufficient_data" | "loss" | "marginal" | "profitable";
    reason: string;
    n_distinct_signals: number;
  };
  notes: string[];
};

const BULLISH_RE = /^(yes|up|over|long|buy|bullish|true|1)$/i;
const BEARISH_RE = /^(no|down|under|short|sell|bearish|false|0)$/i;

/**
 * For "yes_keyword" mode: returns 0 if the direction reads bullish on the
 * first outcome, 1 if bearish, or null if we can't tell. Polymarket's binary
 * markets list ["Yes","No"] or ["Up","Down"] consistently; this heuristic
 * works for the vast majority of consensus producers' direction labels.
 */
function classifyDirection(direction: string): 0 | 1 | null {
  if (BULLISH_RE.test(direction.trim())) return 0;
  if (BEARISH_RE.test(direction.trim())) return 1;
  return null;
}

export function backtestConsensusSignals(
  signals: ConsensusSignal[],
  resolvedByCondition: Map<string, ResolvedMarket>,
  opts: ConsensusBacktestOpts = {},
): ConsensusBacktestResult {
  const sizeUsd = opts.sizeUsd ?? 100;
  const slippageTiers = opts.slippageBpsTiers ?? [0, 30, 100, 300];
  const feeBps = opts.feeBps ?? 0;
  const minDistinct = opts.minDistinctSignals ?? 5;
  const directionMode = opts.directionMode ?? "yes_keyword";
  const feeFrac = feeBps / 10000;

  const buckets = new Map<number, { n: number; w: number; pnl: number; winMultSum: number }>();
  for (const s of slippageTiers) buckets.set(s, { n: 0, w: 0, pnl: 0, winMultSum: 0 });

  let used = 0;
  let unresolved = 0;
  let indecipherable = 0;
  const distinctMarkets = new Set<string>();
  const notes: string[] = [];

  for (const sig of signals) {
    const market = resolvedByCondition.get(sig.marketKey);
    if (!market) { unresolved += 1; continue; }
    const dirIdx = directionMode === "outcome_index"
      ? (sig.direction === "0" ? 0 : sig.direction === "1" ? 1 : null)
      : classifyDirection(sig.direction);
    if (dirIdx == null) { indecipherable += 1; continue; }

    // entryRefPrice: bullish on outcome 0 → use signal.avgPrice as-is.
    // Bearish on outcome 0 (= bullish on outcome 1, "buy NO") → entry = 1 − p.
    const entryRefPrice = dirIdx === 0 ? sig.avgPrice : 1 - sig.avgPrice;
    if (!Number.isFinite(entryRefPrice) || entryRefPrice <= 0 || entryRefPrice >= 1) {
      indecipherable += 1;
      continue;
    }
    const won = market.winningIndex === dirIdx;
    distinctMarkets.add(sig.marketKey);
    used += 1;

    for (const slipBps of slippageTiers) {
      const slipFrac = slipBps / 10000;
      const entry = entryRefPrice * (1 + slipFrac);
      if (entry >= 1) continue;
      const pnlPerDollar = won ? (1 - entry) / entry : -1;
      const net = pnlPerDollar - 2 * feeFrac;
      const pnlUsd = net * sizeUsd;
      const b = buckets.get(slipBps)!;
      b.n += 1;
      if (won) {
        b.w += 1;
        b.winMultSum += (1 - entry) / entry;
      }
      b.pnl += pnlUsd;
    }
  }

  if (signals.length === 0) notes.push("No consensus signals supplied.");
  if (used === 0 && signals.length > 0) {
    notes.push(`No signals scorable. ${unresolved} unresolved markets, ${indecipherable} indecipherable direction.`);
  }

  const outBuckets: ConsensusBucket[] = [];
  let best: { slip: number; pnl: number } | null = null;
  for (const slip of slippageTiers) {
    const b = buckets.get(slip)!;
    const cap = b.n * sizeUsd;
    outBuckets.push({
      slippage_bps: slip,
      n_signals: b.n,
      n_wins: b.w,
      win_rate: b.n > 0 ? b.w / b.n : 0,
      pnl_usd: b.pnl,
      pnl_pct: cap > 0 ? b.pnl / cap : 0,
      avg_winner_multiple: b.w > 0 ? b.winMultSum / b.w : 0,
    });
    if (b.n >= minDistinct && (best == null || b.pnl > best.pnl)) {
      best = { slip, pnl: b.pnl };
    }
  }

  const realistic = outBuckets.find((b) => b.slippage_bps === 100) ?? outBuckets.find((b) => b.slippage_bps === 0);
  const verdict = (() => {
    if (distinctMarkets.size < minDistinct) {
      return {
        rating: "insufficient_data" as const,
        reason: `only ${distinctMarkets.size} distinct resolved signals — need ≥${minDistinct} for thesis check`,
        n_distinct_signals: distinctMarkets.size,
      };
    }
    const pct = realistic?.pnl_pct ?? 0;
    if (pct < -0.05) return { rating: "loss" as const, reason: `loses ${(Math.abs(pct) * 100).toFixed(1)}% per copy at 100bps`, n_distinct_signals: distinctMarkets.size };
    if (pct < 0.05) return { rating: "marginal" as const, reason: `${(pct * 100).toFixed(1)}% per copy at 100bps — within noise`, n_distinct_signals: distinctMarkets.size };
    return { rating: "profitable" as const, reason: `${(pct * 100).toFixed(1)}% per copy at 100bps across ${distinctMarkets.size} signals`, n_distinct_signals: distinctMarkets.size };
  })();

  return {
    size_usd: sizeUsd,
    fee_bps: feeBps,
    signals_seen: signals.length,
    signals_used: used,
    signals_skipped_unresolved: unresolved,
    signals_skipped_indecipherable: indecipherable,
    buckets: outBuckets,
    best_slippage_bps: best?.slip ?? null,
    best_pnl_usd: best?.pnl ?? 0,
    verdict,
    notes,
  };
}

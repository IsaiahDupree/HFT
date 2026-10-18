/**
 * Retroactive consensus detector + scorer.
 *
 * Unlike the forward-looking consensus pipeline (`detectConsensus()` over
 * recent `userTrades`), this scans tracked wallets' **closed positions**:
 * markets that have already resolved.
 *
 *   Closed position = a stake the wallet held in a market that is now settled.
 *   curPrice = 1 → the wallet's outcome won; curPrice = 0 → it lost.
 *
 * For each resolved market where ≥`minWallets` tracked wallets held positions
 * on the **same outcomeIndex** with combined trust ≥ `minCombinedTrust`,
 * that's a "retroactive consensus" — we can ask: "if we had copied this
 * signal at entry time, would it have paid off?"
 *
 * Sidesteps the active-market bias in the forward pipeline: every signal
 * here is by definition on a resolved market.
 *
 * Pure function — caller fetches the closed-positions arrays + trust tiers,
 * we do the grouping + scoring.
 */

export type ClosedPositionInput = {
  proxyWallet: string;
  trustTier: number;
  /** Polymarket conditionId — the resolved market identity. */
  conditionId: string;
  /** Which outcome the wallet bet on (0 or 1 in binary markets). */
  outcomeIndex: number;
  /** Human-readable outcome label ("Up"/"Down"/"Yes"/"No"). */
  outcome?: string;
  /** Volume-weighted entry price ∈ [0,1]. */
  avgPrice: number;
  /** Resolved-outcome indicator: 1 if this side won, 0 if it lost. */
  curPrice: number;
  /** Total USDC the wallet committed to this position. */
  totalBought: number;
  /** The wallet's own realized PnL on the position (for sanity-checking). */
  realizedPnl?: number;
  /** Market title (for UI). */
  title?: string;
};

export type RetroactiveSignal = {
  conditionId: string;
  marketTitle?: string;
  outcomeIndex: number;
  outcome?: string;
  /** Did the agreed-upon outcome win? Derived from majority curPrice (always unanimous within a group since they're on the same outcome). */
  won: boolean;
  wallets: Array<{
    proxyWallet: string;
    trustTier: number;
    avgPrice: number;
    totalBought: number;
    realizedPnl?: number;
  }>;
  /** Sum of trust across agreeing wallets. */
  combinedTrust: number;
  /** Sum of USDC committed across agreeing wallets. */
  combinedUsd: number;
  walletCount: number;
  /** Volume-weighted avg entry price across the cohort — what the "consensus paid" on average. */
  consensusAvgPrice: number;
};

export type RetroactiveOpts = {
  /** Minimum distinct wallets that must have taken the same side. Default: 2. */
  minWallets?: number;
  /** Minimum sum of trustTier across the cohort. Default: 2. */
  minCombinedTrust?: number;
  /** Minimum combined USD committed by the cohort. Default: 0. */
  minCombinedUsd?: number;
};

/**
 * Group closed positions by (conditionId, outcomeIndex). Emit a signal
 * for each group meeting the thresholds. Same-wallet duplicates inside a
 * group are kept and folded into the totals — Polymarket sometimes emits
 * one closed-position row per slug; the cohort count uses distinct wallets.
 */
export function detectRetroactiveConsensus(
  positions: ClosedPositionInput[],
  opts: RetroactiveOpts = {},
): RetroactiveSignal[] {
  const minWallets = opts.minWallets ?? 2;
  const minCombinedTrust = opts.minCombinedTrust ?? 2;
  const minCombinedUsd = opts.minCombinedUsd ?? 0;

  const byMarket = new Map<string, ClosedPositionInput[]>();
  for (const p of positions) {
    if (!p.conditionId || p.outcomeIndex == null) continue;
    if (!Number.isFinite(p.avgPrice) || p.avgPrice <= 0 || p.avgPrice >= 1) continue;
    if (!Number.isFinite(p.curPrice)) continue;
    const key = `${p.conditionId}|${p.outcomeIndex}`;
    if (!byMarket.has(key)) byMarket.set(key, []);
    byMarket.get(key)!.push(p);
  }

  const out: RetroactiveSignal[] = [];
  for (const [key, group] of byMarket) {
    const walletSet = new Map<string, { trustTier: number; usd: number; avgPrice: number; vwapNum: number; vwapDen: number; realizedPnl: number; outcome?: string; title?: string }>();
    for (const p of group) {
      const w = walletSet.get(p.proxyWallet);
      const usd = Number(p.totalBought) || 0;
      const px = Number(p.avgPrice) || 0;
      if (!w) {
        walletSet.set(p.proxyWallet, {
          trustTier: p.trustTier,
          usd,
          avgPrice: px,
          vwapNum: px * usd,
          vwapDen: usd,
          realizedPnl: Number(p.realizedPnl ?? 0),
          outcome: p.outcome,
          title: p.title,
        });
      } else {
        w.usd += usd;
        w.vwapNum += px * usd;
        w.vwapDen += usd;
        w.realizedPnl += Number(p.realizedPnl ?? 0);
        w.trustTier = Math.max(w.trustTier, p.trustTier);
      }
    }
    if (walletSet.size < minWallets) continue;

    const wallets = [...walletSet.entries()].map(([proxyWallet, agg]) => ({
      proxyWallet,
      trustTier: agg.trustTier,
      avgPrice: agg.vwapDen > 0 ? agg.vwapNum / agg.vwapDen : agg.avgPrice,
      totalBought: agg.usd,
      realizedPnl: agg.realizedPnl || undefined,
    }));
    const combinedTrust = wallets.reduce((s, w) => s + w.trustTier, 0);
    const combinedUsd = wallets.reduce((s, w) => s + w.totalBought, 0);
    if (combinedTrust < minCombinedTrust) continue;
    if (combinedUsd < minCombinedUsd) continue;

    const [conditionId, outcomeStr] = key.split("|");
    const outcomeIndex = Number(outcomeStr);
    // Outcome-won status is the same for everyone in the cohort (they're on the same side).
    const won = group.some((p) => Number(p.curPrice) >= 0.99);
    // Volume-weighted consensus entry price across the cohort.
    let num = 0, den = 0;
    for (const w of wallets) { num += w.avgPrice * w.totalBought; den += w.totalBought; }
    const consensusAvgPrice = den > 0 ? num / den : 0;

    out.push({
      conditionId,
      marketTitle: group.find((p) => p.title)?.title,
      outcomeIndex,
      outcome: group.find((p) => p.outcome)?.outcome,
      won,
      wallets: wallets.sort((a, b) => b.trustTier - a.trustTier),
      combinedTrust,
      combinedUsd,
      walletCount: wallets.length,
      consensusAvgPrice,
    });
  }
  // Sort by combinedTrust × combinedUsd descending — biggest agreements first.
  return out.sort((a, b) => (b.combinedTrust * b.combinedUsd) - (a.combinedTrust * a.combinedUsd));
}

// ----------------------------------------------------------------------------
// Scoring
// ----------------------------------------------------------------------------

export type RetroactiveScoreOpts = {
  /** USD to "copy" per signal. Default: 100. */
  sizeUsd?: number;
  /** Per-leg slippage tiers in bps. Default: [0, 30, 100, 300]. */
  slippageBpsTiers?: number[];
  /** Min distinct resolved signals before grading. Default: 5. */
  minDistinctSignals?: number;
};

export type RetroactiveBucket = {
  slippage_bps: number;
  n_signals: number;
  n_wins: number;
  win_rate: number;
  pnl_usd: number;
  pnl_pct: number;
  avg_winner_multiple: number;
};

export type RetroactiveScoreResult = {
  size_usd: number;
  n_signals: number;
  buckets: RetroactiveBucket[];
  best_slippage_bps: number | null;
  best_pnl_usd: number;
  verdict: {
    rating: "insufficient_data" | "loss" | "marginal" | "profitable";
    reason: string;
    n_distinct_signals: number;
  };
};

/**
 * Score copy-bets for each retroactive signal using the same binary-outcome
 * model as `backtestResolvedOutcomes`: copy at consensusAvgPrice × (1 + slip);
 * payout (1 − entry) / entry if won, −1 if lost.
 */
export function scoreRetroactiveSignals(
  signals: RetroactiveSignal[],
  opts: RetroactiveScoreOpts = {},
): RetroactiveScoreResult {
  const sizeUsd = opts.sizeUsd ?? 100;
  const tiers = opts.slippageBpsTiers ?? [0, 30, 100, 300];
  const minDistinct = opts.minDistinctSignals ?? 5;

  const buckets = new Map<number, { n: number; w: number; pnl: number; winMultSum: number }>();
  for (const s of tiers) buckets.set(s, { n: 0, w: 0, pnl: 0, winMultSum: 0 });

  for (const sig of signals) {
    if (!Number.isFinite(sig.consensusAvgPrice) || sig.consensusAvgPrice <= 0 || sig.consensusAvgPrice >= 1) continue;
    for (const slip of tiers) {
      const entry = sig.consensusAvgPrice * (1 + slip / 10000);
      if (entry >= 1) continue;
      const pnlPerDollar = sig.won ? (1 - entry) / entry : -1;
      const pnlUsd = pnlPerDollar * sizeUsd;
      const b = buckets.get(slip)!;
      b.n += 1;
      if (sig.won) { b.w += 1; b.winMultSum += (1 - entry) / entry; }
      b.pnl += pnlUsd;
    }
  }

  const outBuckets: RetroactiveBucket[] = [];
  let best: { slip: number; pnl: number } | null = null;
  for (const slip of tiers) {
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

  const realistic = outBuckets.find((b) => b.slippage_bps === 100) ?? outBuckets[0];
  const verdict = (() => {
    if (signals.length < minDistinct) {
      return {
        rating: "insufficient_data" as const,
        reason: `only ${signals.length} resolved consensus signals — need ≥${minDistinct}`,
        n_distinct_signals: signals.length,
      };
    }
    const pct = realistic?.pnl_pct ?? 0;
    if (pct < -0.05) return { rating: "loss" as const, reason: `loses ${(Math.abs(pct) * 100).toFixed(1)}% per copy at 100bps`, n_distinct_signals: signals.length };
    if (pct < 0.05) return { rating: "marginal" as const, reason: `${(pct * 100).toFixed(1)}% per copy at 100bps — within noise`, n_distinct_signals: signals.length };
    return {
      rating: "profitable" as const,
      reason: `${(pct * 100).toFixed(1)}% per copy at 100bps across ${signals.length} resolved signals (note: wallet cohort biased toward leaderboard-discovered top-PnL traders)`,
      n_distinct_signals: signals.length,
    };
  })();

  return {
    size_usd: sizeUsd,
    n_signals: signals.length,
    buckets: outBuckets,
    best_slippage_bps: best?.slip ?? null,
    best_pnl_usd: best?.pnl ?? 0,
    verdict,
  };
}

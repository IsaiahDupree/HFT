/**
 * Copy-trade backtester — answers the question the ChatGPT prompt poses:
 *
 *   "If we copied this wallet's trades at +10s / +1m / +5m / +15m lag, holding
 *    for H minutes, would it have been profitable after slippage and fees?"
 *
 * Pure function: takes the wallet's trade history + a per-token price-history
 * series (both from the Polymarket Data API / CLOB), and returns a matrix of
 * {lag × hold} buckets with PnL, win rate, sample size, and average entry
 * drift vs. the wallet's own fill.
 *
 * Why this matters: a wallet may be a great signal generator and still NOT be
 * copyable, because by the time you see and react to their trade the edge has
 * moved on. The backtester tells us which signals survive lag.
 *
 * Inputs are all plain JSON (no DB, no HTTP) so the analytics tests can drive
 * the whole thing with synthetic data.
 */
import type { RawTrade } from "./fingerprint";

/**
 * Resolved-market ground-truth payouts. A wallet trade we want to score must
 * map to one of these (otherwise the market hasn't resolved yet and we can't
 * settle the copy). Sourced from the Gamma `/markets?closed=true` endpoint
 * by the CLI runner.
 */
export type ResolvedMarket = {
  conditionId: string;
  /** Winning index of `outcomes` — 0 for the first outcome, 1 for the second, etc. */
  winningIndex: number;
  /** Per-outcome payout. Binary markets: ["1","0"] or ["0","1"]. */
  outcomePayouts: number[];
  /** YES/NO token ids, in the same order as `outcomes` / `outcomePayouts`. */
  clobTokenIds: string[];
  /** When resolution was finalized (unix seconds). Used to filter "redeemed before this date" caveats. */
  closedTime?: number;
};

/** Time-bucketed midpoint history for a single Polymarket token (YES side). */
export type PriceHistorySeries = {
  tokenId: string;
  points: Array<{ t: number; p: number }>; // t = unix seconds, p ∈ [0,1]
};

export type CopyBacktestOpts = {
  /** Seconds of execution lag to test. Default: [10, 60, 300, 900]. */
  lagsSec?: number[];
  /** Minutes to hold each copied position before mark-to-market. Default: [60, 240, 1440]. */
  holdMinutes?: number[];
  /** Per-leg slippage in basis points (1 bp = 0.0001). Default: 30 = 0.30%. */
  slippageBps?: number;
  /** Per-leg fee in basis points. Polymarket's taker fee is 0 today; placeholder. Default: 0. */
  feeBps?: number;
  /** USD size to copy per signal. Default: 100. */
  sizeUsd?: number;
  /** Skip trades older than this many days. Default: 90. */
  maxAgeDays?: number;
  /**
   * Skip trades NEWER than this many minutes. Default: max(holdMinutes) + 5.
   * Necessary because a trade timestamped 10 minutes ago can't be backtested
   * with a 4-hour hold — the exit time is in the future and the price series
   * stops at "now," so the trade would be silently dropped.
   */
  minAgeMinutes?: number;
  /**
   * Optional map conditionId → unix-seconds of when the wallet REDEEMED the
   * resulting position. When supplied, an additional "natural-hold" bucket
   * (hold_min = -1) is produced that exits at the actual redemption time.
   * Models reality more closely than any fixed window: the wallet held until
   * the market resolved, not for some preset N minutes.
   */
  redemptionByCondition?: Map<string, number>;
};

export type CopyBacktestBucket = {
  lag_sec: number;
  hold_min: number;
  n_trades: number;
  n_wins: number;
  win_rate: number;
  pnl_usd: number;
  pnl_pct: number;            // pnl_usd / (n_trades * size_usd) — return on copied capital
  avg_drift_bps: number;      // how much the entry price moved vs. wallet's fill
  avg_hold_realized_pct: number;
};

export type CopyBacktestResult = {
  wallet_address: string;
  size_usd: number;
  slippage_bps: number;
  fee_bps: number;
  trades_seen: number;
  trades_used: number;        // trades_seen minus those filtered (no price data, too old, no token, etc.)
  buckets: CopyBacktestBucket[];
  best_lag_sec: number | null;
  best_hold_min: number | null;
  best_pnl_usd: number;
  notes: string[];
};

const DEFAULT_LAGS_SEC = [10, 60, 300, 900];
const DEFAULT_HOLDS_MIN = [60, 240, 1440];

/**
 * Linear-interpolate the midpoint at `unixT` from a sorted price series.
 *
 * Strict on both extrapolation ends:
 *   - `unixT` before the series start → returns null (we don't know the price)
 *   - `unixT` after the series end    → returns null (the future hasn't happened yet)
 *
 * This matters for the copy-backtest: a wallet trade timestamped after our
 * price-history snapshot ends would otherwise clamp entry+exit to the same
 * boundary point → false-zero PnL. Returning null causes the trade to be
 * skipped rather than scored as a no-op.
 */
export function interpolatePriceAt(series: PriceHistorySeries, unixT: number): number | null {
  const pts = series.points;
  if (pts.length === 0) return null;
  if (unixT < pts[0].t) return null;
  if (unixT > pts[pts.length - 1].t) return null;
  // Binary search for the bracketing pair.
  let lo = 0, hi = pts.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (pts[mid].t <= unixT) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  if (b.t === a.t) return a.p;
  const frac = (unixT - a.t) / (b.t - a.t);
  return a.p + frac * (b.p - a.p);
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ============================================================================
// Resolved-outcome scorer
// ============================================================================

export type ResolvedBacktestOpts = {
  /** USD size to copy per signal. Default: 100. */
  sizeUsd?: number;
  /** Slippage tiers in bps to evaluate, parameterizing the lag-cost we'd pay. Default: [0, 30, 100, 300]. */
  slippageBpsTiers?: number[];
  /** Per-leg fee in bps. Default: 0. */
  feeBps?: number;
  /**
   * Bearish (SELL) trades are interpreted as a bet against the asset's outcome.
   * In binary markets we model this as buying the OPPOSITE outcome's token at
   * price (1 - p). Set to false to skip SELL trades instead. Default: true.
   */
  treatSellAsInverseBet?: boolean;
  /**
   * Collapse N slugged orders on the same (conditionId, asset, side) within
   * this many seconds into one logical bet. Default: 3600 (1 hour). Pass 0
   * to disable. Without de-dup a wallet that split one $50k bet into 299
   * orders looks like 299 independent winning signals — vastly inflating
   * apparent copy edge.
   */
  dedupWindowSec?: number;
  /**
   * Minimum number of distinct resolved markets the wallet must have traded
   * before we'll grade copyability above "insufficient". Default: 10.
   * One single resolved-market event proves nothing about repeatability.
   */
  minDistinctMarkets?: number;
};

/**
 * One-line verdict on whether copying this wallet looks profitable, gated by
 * sample size. The thresholds are intentionally conservative — copyable money
 * requires both edge AND repeatability, not a single lucky event.
 */
export type CopyabilityVerdict = {
  rating: "insufficient_data" | "loss" | "marginal" | "profitable";
  reason: string;
  n_distinct_markets: number;
  baseline_pnl_pct: number; // pnl_pct at 0bps slippage
};

export type ResolvedBucket = {
  slippage_bps: number;
  n_trades: number;
  n_wins: number;
  win_rate: number;
  /** Sum of per-copy PnL in USD across all scorable trades. */
  pnl_usd: number;
  /** Return on capital = pnl_usd / (n_trades * size_usd). */
  pnl_pct: number;
  /** Avg payout multiple on winners: (1-p)/p for bullish, p/(1-p) for bearish. */
  avg_winner_multiple: number;
};

export type ResolvedBacktestResult = {
  wallet_address: string;
  size_usd: number;
  fee_bps: number;
  trades_seen: number;
  /** Trades after de-dup collapsing. */
  trades_after_dedup: number;
  /** Distinct resolved markets used in scoring. */
  distinct_markets_used: number;
  trades_used: number;
  trades_skipped_unresolved: number;
  trades_skipped_no_token_match: number;
  buckets: ResolvedBucket[];
  best_slippage_bps: number | null;
  best_pnl_usd: number;
  verdict: CopyabilityVerdict;
  notes: string[];
};

/**
 * Collapse N orders on the same (conditionId, asset, side) within
 * `windowSec` into one synthetic trade with volume-weighted-mean price and
 * summed USDC size. Returns the collapsed list, sorted by timestamp.
 *
 * The trades the wallet routes through Polymarket are often slugged across
 * many small orders to minimize price impact — for copy-trade scoring that's
 * one logical bet, not N.
 */
export function collapseSluggedTrades(trades: RawTrade[], windowSec: number): RawTrade[] {
  if (windowSec <= 0) return trades;
  // Sort by timestamp ascending so the first trade in a slug starts the bucket.
  const sorted = [...trades].sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0));
  type BucketState = {
    head: RawTrade; // first trade in the bucket — used to inherit conditionId/asset/side
    totalUsd: number;
    weightedPriceSum: number; // sum of price * usdcSize
    startTs: number;
    lastTs: number;
  };
  const buckets = new Map<string, BucketState>();
  const out: RawTrade[] = [];
  const flush = (key: string) => {
    const b = buckets.get(key);
    if (!b) return;
    buckets.delete(key);
    const collapsed: RawTrade = {
      ...b.head,
      timestamp: b.startTs,
      price: b.totalUsd > 0 ? b.weightedPriceSum / b.totalUsd : Number(b.head.price ?? 0),
      usdcSize: b.totalUsd,
      size: b.totalUsd, // best approximation when we don't track shares
    };
    out.push(collapsed);
  };

  for (const t of sorted) {
    const ts = Number(t.timestamp ?? 0);
    const usd = Number(t.usdcSize ?? 0) || Number(t.size ?? 0) * Number(t.price ?? 0);
    const key = `${t.conditionId ?? ""}|${t.asset ?? ""}|${String(t.side ?? "").toUpperCase()}`;
    if (!t.conditionId || !t.asset || !t.side || !ts) {
      // Pass-through anything we can't bucket — the scorer will filter it.
      out.push(t);
      continue;
    }
    const prev = buckets.get(key);
    if (prev && ts - prev.startTs <= windowSec) {
      prev.totalUsd += usd;
      prev.weightedPriceSum += Number(t.price ?? 0) * usd;
      prev.lastTs = ts;
    } else {
      // Bucket boundary crossed — flush previous and start fresh.
      if (prev) flush(key);
      buckets.set(key, {
        head: t,
        totalUsd: usd,
        weightedPriceSum: Number(t.price ?? 0) * usd,
        startTs: ts,
        lastTs: ts,
      });
    }
  }
  for (const k of [...buckets.keys()]) flush(k);
  return out.sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0));
}

function gradeCopyability(opts: {
  pnl_pct_baseline: number;
  pnl_pct_realistic: number; // typically the 100bps tier
  n_distinct_markets: number;
  minDistinct: number;
}): CopyabilityVerdict {
  const v: Omit<CopyabilityVerdict, "rating" | "reason"> = {
    n_distinct_markets: opts.n_distinct_markets,
    baseline_pnl_pct: opts.pnl_pct_baseline,
  };
  if (opts.n_distinct_markets < opts.minDistinct) {
    return {
      ...v,
      rating: "insufficient_data",
      reason: `only ${opts.n_distinct_markets} distinct resolved market(s) — need ≥${opts.minDistinct} for repeatability check`,
    };
  }
  if (opts.pnl_pct_realistic < -0.05) {
    return {
      ...v,
      rating: "loss",
      reason: `loses ${(Math.abs(opts.pnl_pct_realistic) * 100).toFixed(1)}% per copy at realistic slippage`,
    };
  }
  if (opts.pnl_pct_realistic < 0.05) {
    return {
      ...v,
      rating: "marginal",
      reason: `${(opts.pnl_pct_realistic * 100).toFixed(1)}% per copy at 100bps slippage — within noise`,
    };
  }
  return {
    ...v,
    rating: "profitable",
    reason: `${(opts.pnl_pct_realistic * 100).toFixed(1)}% per copy at 100bps slippage across ${opts.n_distinct_markets} markets`,
  };
}

/**
 * Score copy-trades against the binary outcomes of resolved markets. Unlike
 * the midpoint backtester, this does NOT need any intraday price history —
 * for a resolved market the only thing that matters is "did the wallet's bet
 * win or lose?" combined with the entry price (which determines the payout
 * multiple).
 *
 * Per-trade PnL on $1 of copied capital:
 *   - Bullish (BUY at p), outcome wins:  PnL = (1 − p_after_slippage) / p_after_slippage
 *   - Bullish (BUY at p), outcome loses: PnL = −1
 *   - Bearish (SELL at p), interpreted as buying the inverse outcome at (1−p):
 *       if YES wins → bearish copy loses (PnL = −1)
 *       if YES loses → bearish copy wins (PnL = p / (1 − p))
 *
 * Slippage is applied to the wallet's fill price as a tax in bps. We evaluate
 * multiple slippage tiers so the user can see "at what cost of execution does
 * the wallet stop being copyable."
 */
export function backtestResolvedOutcomes(
  walletAddress: string,
  trades: RawTrade[],
  resolvedByCondition: Map<string, ResolvedMarket>,
  opts: ResolvedBacktestOpts = {},
): ResolvedBacktestResult {
  const sizeUsd = opts.sizeUsd ?? 100;
  const slippageTiers = opts.slippageBpsTiers ?? [0, 30, 100, 300];
  const feeBps = opts.feeBps ?? 0;
  const treatSell = opts.treatSellAsInverseBet ?? true;
  const dedupWindowSec = opts.dedupWindowSec ?? 3600;
  const minDistinct = opts.minDistinctMarkets ?? 10;
  const feeFrac = feeBps / 10000;

  // De-dup slugged orders before scoring so 299 orders on the same outcome
  // count as one bet, not 299. Disabled when dedupWindowSec=0.
  const dedupedTrades = dedupWindowSec > 0 ? collapseSluggedTrades(trades, dedupWindowSec) : trades;

  const notes: string[] = [];
  const buckets = new Map<number, { n_trades: number; n_wins: number; pnl_usd: number; winner_mult_sum: number }>();
  for (const s of slippageTiers) buckets.set(s, { n_trades: 0, n_wins: 0, pnl_usd: 0, winner_mult_sum: 0 });

  let skippedUnresolved = 0;
  let skippedNoTokenMatch = 0;
  let used = 0;
  const usedMarkets = new Set<string>();

  for (const t of dedupedTrades) {
    const conditionId = String(t.conditionId ?? "");
    const tokenId = String(t.asset ?? "");
    const sideRaw = String(t.side ?? "").toUpperCase();
    const fill = toNum(t.price);
    if (!conditionId || !tokenId || !fill || fill <= 0 || fill >= 1) continue;
    if (sideRaw !== "BUY" && sideRaw !== "SELL") continue;

    const market = resolvedByCondition.get(conditionId);
    if (!market) { skippedUnresolved += 1; continue; }
    const tokenIdx = market.clobTokenIds.indexOf(tokenId);
    if (tokenIdx < 0) { skippedNoTokenMatch += 1; continue; }

    if (sideRaw === "SELL" && !treatSell) continue;

    // Did the wallet's bet win?
    //   BUY on token X means betting X happens. Win iff winningIndex === tokenIdx.
    //   SELL on token X means betting X does NOT happen. Win iff winningIndex !== tokenIdx.
    //     (we model this as buying the inverse outcome at (1 - p))
    const isBullish = sideRaw === "BUY";
    const won = isBullish ? market.winningIndex === tokenIdx : market.winningIndex !== tokenIdx;
    const entryRefPrice = isBullish ? fill : (1 - fill);

    for (const slipBps of slippageTiers) {
      const slipFrac = slipBps / 10000;
      // Pay more on entry: p × (1 + slip)
      const entry = entryRefPrice * (1 + slipFrac);
      if (entry >= 1) continue; // 100% slippage isn't a valid copy
      // PnL per $1: win → (1 − entry) / entry ; lose → −1. Apply 2-leg fee toll.
      const pnlPerDollar = won ? (1 - entry) / entry : -1;
      const netPerDollar = pnlPerDollar - 2 * feeFrac;
      const pnlUsd = netPerDollar * sizeUsd;
      const bucket = buckets.get(slipBps)!;
      bucket.n_trades += 1;
      if (won) {
        bucket.n_wins += 1;
        bucket.winner_mult_sum += (1 - entry) / entry;
      }
      bucket.pnl_usd += pnlUsd;
    }
    used += 1;
    usedMarkets.add(conditionId);
  }

  if (trades.length === 0) notes.push("Wallet has zero trades in the supplied window.");
  if (used === 0 && trades.length > 0) {
    notes.push(`No trades produced a resolved-outcome scoring. Resolved markets: ${resolvedByCondition.size}. Skipped: ${skippedUnresolved} unresolved, ${skippedNoTokenMatch} token-id mismatch.`);
  }
  if (dedupWindowSec > 0 && dedupedTrades.length < trades.length) {
    notes.push(`Slug de-dup: ${trades.length} raw trades → ${dedupedTrades.length} logical bets (window=${dedupWindowSec}s).`);
  }

  const outBuckets: ResolvedBucket[] = [];
  let best: { slip: number; pnl: number } | null = null;
  for (const s of slippageTiers) {
    const b = buckets.get(s)!;
    const totalCap = b.n_trades * sizeUsd;
    outBuckets.push({
      slippage_bps: s,
      n_trades: b.n_trades,
      n_wins: b.n_wins,
      win_rate: b.n_trades > 0 ? b.n_wins / b.n_trades : 0,
      pnl_usd: b.pnl_usd,
      pnl_pct: totalCap > 0 ? b.pnl_usd / totalCap : 0,
      avg_winner_multiple: b.n_wins > 0 ? b.winner_mult_sum / b.n_wins : 0,
    });
    if (b.n_trades >= 3 && (best == null || b.pnl_usd > best.pnl)) {
      best = { slip: s, pnl: b.pnl_usd };
    }
  }

  // Pick representative tier (100bps) for the verdict; fall back to 0bps.
  const realistic = outBuckets.find((b) => b.slippage_bps === 100) ?? outBuckets.find((b) => b.slippage_bps === 0);
  const baseline = outBuckets.find((b) => b.slippage_bps === 0) ?? outBuckets[0];
  const verdict = gradeCopyability({
    pnl_pct_baseline: baseline?.pnl_pct ?? 0,
    pnl_pct_realistic: realistic?.pnl_pct ?? 0,
    n_distinct_markets: usedMarkets.size,
    minDistinct,
  });

  return {
    wallet_address: walletAddress,
    size_usd: sizeUsd,
    fee_bps: feeBps,
    trades_seen: trades.length,
    trades_after_dedup: dedupedTrades.length,
    distinct_markets_used: usedMarkets.size,
    trades_used: used,
    trades_skipped_unresolved: skippedUnresolved,
    trades_skipped_no_token_match: skippedNoTokenMatch,
    buckets: outBuckets,
    best_slippage_bps: best?.slip ?? null,
    best_pnl_usd: best?.pnl ?? 0,
    verdict,
    notes,
  };
}

/**
 * Parse a Gamma market row into a ResolvedMarket (or null if the market
 * is not yet resolved). Polymarket encodes outcomes / outcomePrices /
 * clobTokenIds as JSON-strings inside the JSON response — we unwrap them.
 */
export function parseGammaResolvedMarket(row: any): ResolvedMarket | null {
  if (!row || row.closed !== true) return null;
  const conditionId = String(row.conditionId ?? "");
  if (!conditionId) return null;
  let outcomePrices: number[];
  let clobTokenIds: string[];
  try {
    outcomePrices = (typeof row.outcomePrices === "string" ? JSON.parse(row.outcomePrices) : row.outcomePrices).map((s: string | number) => Number(s));
    clobTokenIds = (typeof row.clobTokenIds === "string" ? JSON.parse(row.clobTokenIds) : row.clobTokenIds).map((s: string) => String(s));
  } catch {
    return null;
  }
  if (!outcomePrices.length || outcomePrices.length !== clobTokenIds.length) return null;
  // Find the winning index. For binary markets one is 1 and the other is 0.
  // For markets where neither side is 1 (e.g. invalid resolution) we skip.
  let winningIndex = -1;
  for (let i = 0; i < outcomePrices.length; i++) {
    if (outcomePrices[i] >= 0.99) { winningIndex = i; break; }
  }
  if (winningIndex < 0) return null;
  const closedTime = (() => {
    const v = row.closedTime ?? row.endDate;
    if (typeof v !== "string") return undefined;
    // Gamma returns ISO-ish strings with quirks: "2026-03-12 00:53:39+00"
    // → Date.parse rejects the bare "+00" offset. Normalize space→T and pad
    // the timezone to a full "+00:00".
    const norm = v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    const ms = Date.parse(norm);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  })();
  return { conditionId, winningIndex, outcomePayouts: outcomePrices, clobTokenIds, closedTime };
}

/**
 * Run the backtest. `priceSeriesByToken` is keyed by the same id the wallet's
 * trades use (Polymarket calls this `asset` on `userTrades`; it's the YES-side
 * token id of the conditional outcome the wallet traded).
 */
export function backtestCopyTrades(
  walletAddress: string,
  trades: RawTrade[],
  priceSeriesByToken: Map<string, PriceHistorySeries>,
  opts: CopyBacktestOpts = {},
): CopyBacktestResult {
  const lagsSec = opts.lagsSec ?? DEFAULT_LAGS_SEC;
  const holdMinutes = opts.holdMinutes ?? DEFAULT_HOLDS_MIN;
  const slippageBps = opts.slippageBps ?? 30;
  const feeBps = opts.feeBps ?? 0;
  const sizeUsd = opts.sizeUsd ?? 100;
  const maxAgeSec = (opts.maxAgeDays ?? 90) * 86400;
  const minAgeSec = (opts.minAgeMinutes ?? Math.max(...holdMinutes) + 5) * 60;
  const now = Math.floor(Date.now() / 1000);
  const cutoffOld = now - maxAgeSec;
  const cutoffYoung = now - minAgeSec;
  const redemptions = opts.redemptionByCondition;
  /** Sentinel hold_min value used for the natural-hold bucket (= "until wallet redeemed"). */
  const NATURAL_HOLD = -1;

  const slippageFrac = slippageBps / 10000;
  const feeFrac = feeBps / 10000;

  const notes: string[] = [];
  let used = 0;

  // Aggregate per (lag, hold) bucket. The natural-hold (`NATURAL_HOLD`) bucket
  // is only allocated when redemption data is supplied.
  const acc = new Map<string, {
    n_trades: number; n_wins: number;
    pnl_usd: number; drift_bps_sum: number; hold_pct_sum: number;
  }>();
  const effectiveHolds = redemptions ? [...holdMinutes, NATURAL_HOLD] : holdMinutes;
  for (const lag of lagsSec) for (const hold of effectiveHolds) {
    acc.set(`${lag}|${hold}`, { n_trades: 0, n_wins: 0, pnl_usd: 0, drift_bps_sum: 0, hold_pct_sum: 0 });
  }

  for (const t of trades) {
    const tokenId = String(t.asset ?? "");
    const ts = toNum(t.timestamp);
    const sideRaw = String(t.side ?? "").toUpperCase();
    const walletFill = toNum(t.price);
    if (!tokenId || !ts || !walletFill || walletFill <= 0 || walletFill >= 1) continue;
    if (sideRaw !== "BUY" && sideRaw !== "SELL") continue;
    if (ts < cutoffOld) continue;       // too old — outside our backtest window
    if (ts > cutoffYoung) continue;     // too new — exit time would be in the future
    const series = priceSeriesByToken.get(tokenId);
    if (!series || series.points.length < 2) continue;

    // Direction we'd take if we were copying: same side as the wallet.
    // For a BUY of YES, profit if YES midpoint rises by exit time.
    const side = sideRaw as "BUY" | "SELL";
    const sign = side === "BUY" ? +1 : -1;

    for (const lag of lagsSec) {
      const entryT = ts + lag;
      const midAtEntry = interpolatePriceAt(series, entryT);
      if (midAtEntry == null || midAtEntry <= 0 || midAtEntry >= 1) continue;

      // Apply slippage: BUY pays mid * (1+slip), SELL hits mid * (1-slip).
      const fillEntry = side === "BUY" ? midAtEntry * (1 + slippageFrac) : midAtEntry * (1 - slippageFrac);
      const driftBps = ((midAtEntry - walletFill) / walletFill) * 10000;

      const scoreExit = (hold: number, exitT: number) => {
        const midAtExit = interpolatePriceAt(series, exitT);
        if (midAtExit == null || midAtExit <= 0 || midAtExit >= 1) return;
        const fillExit = side === "BUY" ? midAtExit * (1 - slippageFrac) : midAtExit * (1 + slippageFrac);
        const grossReturnPct = sign * (fillExit - fillEntry) / fillEntry;
        const netReturnPct = grossReturnPct - 2 * feeFrac;
        const pnlUsd = netReturnPct * sizeUsd;
        const bucket = acc.get(`${lag}|${hold}`)!;
        bucket.n_trades += 1;
        if (pnlUsd > 0) bucket.n_wins += 1;
        bucket.pnl_usd += pnlUsd;
        bucket.drift_bps_sum += driftBps;
        bucket.hold_pct_sum += (midAtExit - midAtEntry) / midAtEntry;
        used += 1;
      };

      for (const hold of holdMinutes) {
        scoreExit(hold, entryT + hold * 60);
      }

      // Natural-hold bucket: exit when the wallet itself redeemed this market.
      // This captures the actual hold the wallet realized rather than an
      // imposed N-minute window. Only scored when redemption data is present
      // for this conditionId AND the redemption time is after entry + lag.
      if (redemptions) {
        const conditionId = String(t.conditionId ?? "");
        const redeemT = conditionId ? redemptions.get(conditionId) : undefined;
        if (redeemT && redeemT > entryT) {
          scoreExit(NATURAL_HOLD, redeemT);
        }
      }
    }
  }

  if (used === 0 && trades.length > 0) {
    notes.push(
      `No trades produced a backtestable copy — likely missing price history for traded tokens, or trades too recent (need at least ${Math.round(minAgeSec / 60)} min between trade and now) / too old (> ${Math.round(maxAgeSec / 86400)} days).`,
    );
  }
  if (trades.length === 0) notes.push("Wallet had zero trades in the supplied window.");

  const buckets: CopyBacktestBucket[] = [];
  let best: { lag_sec: number; hold_min: number; pnl: number } | null = null;
  for (const lag of lagsSec) for (const hold of effectiveHolds) {
    const b = acc.get(`${lag}|${hold}`)!;
    const totalCapital = b.n_trades * sizeUsd;
    const bucket: CopyBacktestBucket = {
      lag_sec: lag,
      hold_min: hold,
      n_trades: b.n_trades,
      n_wins: b.n_wins,
      win_rate: b.n_trades > 0 ? b.n_wins / b.n_trades : 0,
      pnl_usd: b.pnl_usd,
      pnl_pct: totalCapital > 0 ? b.pnl_usd / totalCapital : 0,
      avg_drift_bps: b.n_trades > 0 ? b.drift_bps_sum / b.n_trades : 0,
      avg_hold_realized_pct: b.n_trades > 0 ? b.hold_pct_sum / b.n_trades : 0,
    };
    buckets.push(bucket);
    if (b.n_trades >= 3 && (best == null || b.pnl_usd > best.pnl)) {
      best = { lag_sec: lag, hold_min: hold, pnl: b.pnl_usd };
    }
  }

  return {
    wallet_address: walletAddress,
    size_usd: sizeUsd,
    slippage_bps: slippageBps,
    fee_bps: feeBps,
    trades_seen: trades.length,
    trades_used: used,
    buckets,
    best_lag_sec: best?.lag_sec ?? null,
    best_hold_min: best?.hold_min ?? null,
    best_pnl_usd: best?.pnl ?? 0,
    notes,
  };
}

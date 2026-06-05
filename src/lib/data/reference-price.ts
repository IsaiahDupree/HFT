/**
 * reference-price — operationalize the lead-lag finding (Binance leads Coinbase). Treat the
 * LEADER (Binance) as the price-discovery reference; when the FOLLOWER (Coinbase) diverges from
 * it, two things can be true:
 *   • small divergence  → a transient mispricing the follower is expected to CLOSE toward the
 *                         leader (the leader already moved; the follower hasn't caught up yet).
 *   • large divergence  → the follower feed is STALE / broken (too far to be a real spread) — a
 *                         DATA-QUALITY flag: don't trade off it, and don't trust its last print.
 * Pure + deterministic. (Caveat: the predicted convergence is descriptive — you still can't act
 * faster than your own latency, but it tells you which feed to trust and when one is stale.)
 */

export type RefState = "aligned" | "follower_rich" | "follower_cheap" | "stale";

export type RefSignal = {
  basisBps: number;                       // (follower − leader)/leader × 1e4 (signed)
  state: RefState;
  expectedFollowerMove: "up" | "down" | "none"; // leader leads → follower converges toward it
  actionable: boolean;                    // a real, tradeable-ish divergence (not aligned, not stale)
};

/** Signed basis of the follower vs the leader, in bps. 0 if the leader price is non-positive. */
export function basisBps(leaderPx: number, followerPx: number): number {
  return leaderPx > 0 && Number.isFinite(followerPx) ? (followerPx - leaderPx) / leaderPx * 1e4 : 0;
}

/**
 * Classify the follower vs the leader. CRITICAL: the actionable signal is the DEVIATION of the
 * basis from its normal level (`baselineBps`, default 0), NOT the raw basis — a persistent
 * structural offset (e.g. the ~13bps USDT/USD basis between BTCUSDT and BTC-USD) is NOT a
 * convergence trade. `alignBps` (default 5) = the no-signal band around the baseline; `staleBps`
 * (default 100 = 1%, on the ABSOLUTE basis) = beyond this it's a stale/bad feed, not a mispricing.
 * Leader leads → a follower RICH vs its baseline is expected to move DOWN (back to baseline), CHEAP UP.
 */
export function referenceSignal(leaderPx: number, followerPx: number, opts: { alignBps?: number; staleBps?: number; baselineBps?: number } = {}): RefSignal {
  const alignBps = opts.alignBps ?? 5, staleBps = opts.staleBps ?? 100, baseline = opts.baselineBps ?? 0;
  if (!(leaderPx > 0) || !Number.isFinite(followerPx)) return { basisBps: 0, state: "stale", expectedFollowerMove: "none", actionable: false };
  const b = basisBps(leaderPx, followerPx);
  if (Math.abs(b) >= staleBps) return { basisBps: b, state: "stale", expectedFollowerMove: "none", actionable: false };
  const dev = b - baseline; // deviation from the NORMAL basis is the tradeable signal
  if (Math.abs(dev) <= alignBps) return { basisBps: b, state: "aligned", expectedFollowerMove: "none", actionable: false };
  return dev > 0
    ? { basisBps: b, state: "follower_rich", expectedFollowerMove: "down", actionable: true }
    : { basisBps: b, state: "follower_cheap", expectedFollowerMove: "up", actionable: true };
}

/** EWMA step: a rolling baseline for the structural basis. Seeds with x on the first (non-finite prev) call. */
export function ewma(prev: number, x: number, alpha: number): number {
  return Number.isFinite(prev) ? prev + alpha * (x - prev) : x;
}

/**
 * A trustworthy consolidated price: when leader and follower agree (within `maxDivBps`), the mean
 * is more robust than either; when they diverge past it, TRUST THE LEADER (the price-discovery
 * venue) rather than the lagging/possibly-stale follower. Returns the price + which source won.
 */
export function consensusReference(leaderPx: number, followerPx: number, opts: { maxDivBps?: number } = {}): { price: number; source: "mean" | "leader" } {
  const maxDiv = opts.maxDivBps ?? 25;
  if (!(leaderPx > 0)) return { price: followerPx, source: "leader" };
  if (Math.abs(basisBps(leaderPx, followerPx)) > maxDiv) return { price: leaderPx, source: "leader" };
  return { price: (leaderPx + followerPx) / 2, source: "mean" };
}

/** Is the follower's last print too old to trust? (paired with referenceSignal for a live monitor). */
export function isStaleByAge(lastUpdateMs: number, nowMs: number, maxAgeMs = 3000): boolean {
  return !Number.isFinite(lastUpdateMs) || nowMs - lastUpdateMs > maxAgeMs;
}

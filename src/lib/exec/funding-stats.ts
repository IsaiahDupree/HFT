/**
 * funding-stats — turn a series of raw funding prints into the numbers a carry decision needs, with
 * ONE hard-won lesson baked in: gate the economics on the DURABLE (median) rate, never the mean.
 *
 * A memecoin's funding spends most hours at the venue's baseline FLOOR and occasionally spikes when
 * leverage demand surges. The mean is dominated by those rare spikes — on a real series we saw 74% of
 * hours at the +11% floor while the top 5% of hours drove ~half the total, pulling the mean to +26%.
 * You cannot size a position on a tail you can't count on: the typical hour (the median) is what you
 * durably collect. So `durableApr = medianApr`, and that is what feeds the carry safety gates. `meanApr`
 * is kept only as spike-upside (display), and `persistence` still guards the SIGN (a sign that flips is
 * a trap regardless of magnitude). Sign comes from the mean (the net direction funding has paid).
 */

export type FundingStats = {
  n: number;
  persistence: number;   // 0.5..1 — fraction on the dominant sign (sign-stability)
  meanApr: number;       // mean × periodsPerYear × 100, SIGNED — spike-inflated; display/upside only
  medianApr: number;     // median × periodsPerYear × 100, SIGNED — the typical hour
  durableApr: number;    // the rate to gate economics on (= medianApr, carrying the persistent sign)
  recentApr: number;     // recent-window mean APR — regime check (has the rate decayed/risen lately?)
};

/**
 * @param rates raw per-period funding rates (e.g. hourly on Hyperliquid, 8-hourly on Binance), oldest→newest
 * @param periodsPerYear 24×365 for hourly, 3×365 for Binance 8-hourly
 * @param recentWindow how many of the most recent prints define the "recent regime" mean
 */
export function fundingStats(rates: readonly number[], periodsPerYear: number, recentWindow = 21): FundingStats {
  const r = rates.filter((x) => Number.isFinite(x));
  const n = r.length;
  if (n === 0) return { n: 0, persistence: 0.5, meanApr: 0, medianApr: 0, durableApr: 0, recentApr: 0 };
  const pos = r.filter((x) => x > 0).length;
  const persistence = Math.max(pos, n - pos) / n;
  const k = periodsPerYear * 100;
  const mean = r.reduce((a, x) => a + x, 0) / n;
  const sorted = [...r].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const recent = r.slice(-recentWindow);
  const recentMean = recent.reduce((a, x) => a + x, 0) / recent.length;
  // durable magnitude = |median| (what the typical hour pays), carrying the PERSISTENT sign (sign of mean).
  // this prevents a near-zero-crossing median from flipping the trade direction away from where funding pays.
  const durableMag = Math.abs(median);
  const durableApr = (mean >= 0 ? durableMag : -durableMag) * k;
  return { n, persistence, meanApr: mean * k, medianApr: median * k, durableApr, recentApr: recentMean * k };
}

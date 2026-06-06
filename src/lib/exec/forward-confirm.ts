/**
 * forward-confirm — turn an accumulating forward paper-track into a binary DEPLOY gate. The policy: "stay
 * dry-run/paper until a forward track confirms the edge; then go live tiny." This makes that enforceable. Given
 * a track of (expected, realized) per-period returns from any forward paper-track (carry-paper, copy-paper,
 * consensus-paper), it confirms only when there's ENOUGH data AND realized returns are positive-Sharpe AND hit
 * better than a coin-flip AND realized actually TRACKS expected (the model is calibrated, not just lucky). Pure.
 */

export type ForwardRecord = { expected: number; realized: number };

export type ForwardConfirm = {
  n: number; meanRealized: number; sharpe: number; hitRate: number; corr: number;
  confirmed: boolean; reason: string;
};

export type ForwardConfirmOpts = { minN?: number; minSharpe?: number; minHitRate?: number; minCorr?: number };

const pearson = (a: readonly number[], b: readonly number[]): number => {
  const n = Math.min(a.length, b.length); if (n < 2) return 0;
  let sa = 0, sb = 0; for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n; let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
};

/**
 * Confirm (or not) a forward paper-track. Defaults from the audit: ≥20 periods, realized Sharpe ≥1.0, hit
 * rate ≥55%, expected↔realized correlation ≥0.3. Pre-register these and don't move them post-hoc.
 */
export function forwardConfirmed(records: readonly ForwardRecord[], opts: ForwardConfirmOpts = {}): ForwardConfirm {
  const minN = opts.minN ?? 20, minSharpe = opts.minSharpe ?? 1.0, minHit = opts.minHitRate ?? 0.55, minCorr = opts.minCorr ?? 0.3;
  const real = records.map((r) => r.realized), n = real.length;
  if (n === 0) return { n: 0, meanRealized: 0, sharpe: 0, hitRate: 0, corr: 0, confirmed: false, reason: "no forward data yet" };
  const mean = real.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(real.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(n) : 0;
  const nz = real.filter((x) => x !== 0);
  const hitRate = nz.length ? nz.filter((x) => x > 0).length / nz.length : 0;
  const corr = pearson(records.map((r) => r.expected), real);
  const fail: string[] = [];
  if (n < minN) fail.push(`n ${n}<${minN}`);
  if (sharpe < minSharpe) fail.push(`sharpe ${sharpe.toFixed(1)}<${minSharpe}`);
  if (hitRate < minHit) fail.push(`hit ${(hitRate * 100).toFixed(0)}%<${minHit * 100}%`);
  if (corr < minCorr) fail.push(`expected↔realized corr ${corr.toFixed(2)}<${minCorr}`);
  const confirmed = fail.length === 0;
  return { n, meanRealized: mean, sharpe, hitRate, corr, confirmed,
    reason: confirmed ? `FORWARD-CONFIRMED over ${n} periods (sharpe ${sharpe.toFixed(1)}, hit ${(hitRate * 100).toFixed(0)}%, corr ${corr.toFixed(2)})` : `not yet: ${fail.join(", ")}` };
}

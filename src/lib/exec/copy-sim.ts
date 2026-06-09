/**
 * copy-sim — "if I'd started with $X and mirrored these wallets, what would my account have done?" A bankroll
 * simulator for net-book copying: it compounds a real starting balance through each period's mark-to-market,
 * charges the rebalance cost of chasing the target's book, scales exposure by a copy fraction (never 100% —
 * leverage/risk control), and tracks the drawdown an actual account would have felt, with an optional stop-out.
 *
 * ONE honest warning baked into how you read the output: a BACKTEST over wallets we picked BECAUSE they already
 * won is survivorship-biased and circular — the curve will look good by construction. It is descriptive ("had
 * you known to copy them…"), not predictive. The only predictive curve is the FORWARD one, fed by periods that
 * were graded after the fact (hl:netbook-paper). Same engine, opposite epistemic weight.
 *
 * Pure + deterministic. Reuses the netbook primitives so the sim and the live grader agree on the math.
 */
import { bookMtmReturn, rebalanceCost } from "./netbook-copy.ts";

export type SimPeriod = { weights: Record<string, number>; rets: Record<string, number>; nextWeights: Record<string, number> };
export type SimOpts = { startUsd: number; copyFraction: number; costBps: number; maxDrawdownStop?: number };

export type SimResult = {
  startUsd: number; finalUsd: number; totalReturn: number; nPeriods: number;
  equityCurve: number[]; periodReturns: number[];
  sharpe: number; maxDrawdown: number; hitRate: number; stoppedOut: boolean;
  grossReturn: number; costDrag: number;
};

/** Compound a bankroll through a stream of per-period NET returns, tracking drawdown and an optional stop-out. */
export function equityFromReturns(netReturns: readonly number[], startUsd: number, maxDrawdownStop?: number): Pick<SimResult, "finalUsd" | "equityCurve" | "periodReturns" | "sharpe" | "maxDrawdown" | "hitRate" | "stoppedOut"> {
  let equity = startUsd, peak = startUsd, maxDD = 0, stopped = false;
  const curve: number[] = [startUsd], applied: number[] = [];
  for (const r of netReturns) {
    const ret = stopped ? 0 : r;
    equity *= 1 + ret;
    applied.push(ret);
    curve.push(equity);
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    if (maxDrawdownStop != null && dd >= maxDrawdownStop) stopped = true;
  }
  const n = applied.length;
  const mean = n ? applied.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1 ? applied.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  return {
    finalUsd: equity, equityCurve: curve, periodReturns: applied,
    sharpe: sd > 0 ? mean / sd : 0, maxDrawdown: maxDD,
    hitRate: n ? applied.filter((x) => x > 0).length / n : 0, stoppedOut: stopped,
  };
}

/** Simulate net-book copying a target across periods, with cost + copy-fraction sizing. */
export function simulateCopy(periods: readonly SimPeriod[], opts: SimOpts): SimResult {
  let grossSum = 0, costSum = 0;
  const netReturns = periods.map((p) => {
    const mtm = bookMtmReturn(p.weights, p.rets);
    const cost = rebalanceCost(p.weights, p.nextWeights, opts.costBps);
    grossSum += mtm * opts.copyFraction;
    costSum += cost * opts.copyFraction;
    return (mtm - cost) * opts.copyFraction;
  });
  const e = equityFromReturns(netReturns, opts.startUsd, opts.maxDrawdownStop);
  return {
    startUsd: opts.startUsd, finalUsd: e.finalUsd, totalReturn: opts.startUsd > 0 ? e.finalUsd / opts.startUsd - 1 : 0,
    nPeriods: periods.length, equityCurve: e.equityCurve, periodReturns: e.periodReturns,
    sharpe: e.sharpe, maxDrawdown: e.maxDrawdown, hitRate: e.hitRate, stoppedOut: e.stoppedOut,
    grossReturn: grossSum, costDrag: costSum,
  };
}

/** A tiny unicode sparkline of an equity curve for the terminal. */
export function sparkline(curve: readonly number[], width = 40): string {
  if (curve.length < 2) return "";
  const step = Math.max(1, Math.floor(curve.length / width));
  const sampled = curve.filter((_, i) => i % step === 0);
  const lo = Math.min(...sampled), hi = Math.max(...sampled), span = hi - lo || 1;
  const bars = "▁▂▃▄▅▆▇█";
  return sampled.map((v) => bars[Math.min(bars.length - 1, Math.floor(((v - lo) / span) * (bars.length - 1)))]).join("");
}

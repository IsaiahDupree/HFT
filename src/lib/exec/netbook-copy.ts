/**
 * netbook-copy — the HONEST way to "copy" a high-turnover position-trader. You cannot mirror 500 fills/day,
 * but you CAN mirror their NET book: the signed exposure per coin, normalized to scale-free weights, refreshed
 * each period. This module marks that mirrored book to market and — crucially — CHARGES the cost of rebalancing
 * when the target shifts its book. A net-book copy only pays if the held exposure earns more than the turnover
 * costs of chasing it; this measures exactly that, forward, so we never fool ourselves with a cost-free curve.
 *
 * Pure + deterministic. The script fetches each candidate's clearinghouseState (net book) + allMids (prices)
 * each run, grades the prior book against the new prices, then snapshots the fresh book for next time.
 */

export type NetPosition = { coin: string; notionalUsd: number };  // signed: + long, − short

/**
 * Normalize a wallet's net positions into scale-free signed weights that sum to 1 in absolute value — so a
 * $50k account and a $5M account mirroring the same book get the same weights (you size to YOUR capital).
 */
export function netBookWeights(positions: readonly NetPosition[]): Record<string, number> {
  const gross = positions.reduce((a, p) => a + Math.abs(p.notionalUsd), 0);
  if (gross <= 0) return {};
  const w: Record<string, number> = {};
  for (const p of positions) if (p.notionalUsd !== 0) w[p.coin] = (w[p.coin] ?? 0) + p.notionalUsd / gross;
  return w;
}

/** Per-coin simple return between two mid snapshots; coins missing a usable price contribute 0. */
export function priceReturns(prev: Record<string, number>, cur: Record<string, number>): Record<string, number> {
  const r: Record<string, number> = {};
  for (const c of Object.keys(prev)) { const p0 = prev[c], p1 = cur[c]; if (p0 > 0 && p1 > 0) r[c] = (p1 - p0) / p0; }
  return r;
}

/** Mark-to-market return of HOLDING `weights` over a period given each coin's price return: Σ wᵢ·rᵢ. */
export function bookMtmReturn(weights: Record<string, number>, rets: Record<string, number>): number {
  let s = 0;
  for (const c of Object.keys(weights)) s += weights[c] * (rets[c] ?? 0);
  return s;
}

/**
 * Cost of moving from the book you held to the target's new book: turnover × cost. Turnover = ½·Σ|wₙ−wₚ|
 * (½ because every unit sold is a unit bought). costBps is the round-trip-per-unit cost (taker fee + slippage).
 */
export function rebalanceCost(prev: Record<string, number>, next: Record<string, number>, costBps: number): number {
  const coins = new Set([...Object.keys(prev), ...Object.keys(next)]);
  let turnover = 0;
  for (const c of coins) turnover += Math.abs((next[c] ?? 0) - (prev[c] ?? 0));
  return (turnover / 2) * (costBps / 10_000);
}

export type NetbookPeriod = { mtm: number; cost: number; net: number };
/** Grade one period: hold prevWeights across the price move, then pay to rebalance into nextWeights. */
export function gradeNetbookPeriod(prevWeights: Record<string, number>, rets: Record<string, number>, nextWeights: Record<string, number>, costBps: number): NetbookPeriod {
  const mtm = bookMtmReturn(prevWeights, rets);
  const cost = rebalanceCost(prevWeights, nextWeights, costBps);
  return { mtm, cost, net: mtm - cost };
}

export type NetbookRecord = { n: number; meanNet: number; meanMtm: number; meanCost: number; hitRate: number; cumNet: number; sharpe: number; netOfCostPays: boolean };
/**
 * Track record over graded periods. `sharpe` is per-period (annualize outside if you want). `netOfCostPays`
 * is the honest verdict: enough periods, positive cumulative return AFTER costs, and a Sharpe that clears 1.
 */
export function netbookTrackRecord(periods: readonly NetbookPeriod[], minPeriods = 10): NetbookRecord {
  const n = periods.length;
  if (!n) return { n: 0, meanNet: 0, meanMtm: 0, meanCost: 0, hitRate: 0, cumNet: 0, sharpe: 0, netOfCostPays: false };
  const nets = periods.map((p) => p.net);
  const mean = nets.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? nets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? mean / sd : 0;
  const cumNet = nets.reduce((a, b) => (1 + a) * (1 + b) - 1, 0);
  return {
    n, meanNet: mean, meanMtm: periods.reduce((a, p) => a + p.mtm, 0) / n, meanCost: periods.reduce((a, p) => a + p.cost, 0) / n,
    hitRate: nets.filter((x) => x > 0).length / n, cumNet, sharpe,
    netOfCostPays: n >= minPeriods && cumNet > 0 && sharpe >= 1,
  };
}

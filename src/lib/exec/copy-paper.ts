/**
 * copy-paper — the HONEST (survivorship-free) test of the smart-money consensus. The copy-backtest is biased
 * because the cohort is picked on TODAY's profit; a forward paper-track is not: we record the verified consensus
 * NOW (using only now's data), and on the NEXT run grade how that prior signal actually played out against
 * realized price. Accumulated over weeks it answers "is the verified HL consensus predictive?" with zero
 * lookahead. Pure: this scores a prior snapshot vs current prices; the script does the I/O + persistence.
 */

export type ConsensusEntry = { coin: string; netNotional: number; price: number };  // price = mark at snapshot time
export type Snapshot = { ts: number; iso: string; entries: ConsensusEntry[] };

export type CoinEval = { coin: string; dir: 1 | -1; priorPrice: number; nowPrice: number; priceRet: number; copyRet: number; correct: boolean; weight: number };
export type ForwardEval = { perCoin: CoinEval[]; portfolioRet: number; hitRate: number; nEval: number; horizonHours: number };

/**
 * Grade a prior consensus snapshot against current prices. copyRet = sign(netNotional)·priceRet (you followed
 * the consensus direction). portfolioRet is |notional|-weighted; hitRate = fraction of coins that moved the
 * consensus way. Entries with no current price, zero net, or a non-positive prior price are skipped.
 */
export function evaluateForward(prior: Snapshot, nowPrice: (coin: string) => number | undefined, nowTs: number): ForwardEval {
  const perCoin: CoinEval[] = [];
  for (const e of prior.entries) {
    const np = nowPrice(e.coin);
    if (e.netNotional === 0 || !np || !(e.price > 0)) continue;
    const dir: 1 | -1 = e.netNotional > 0 ? 1 : -1;
    const priceRet = np / e.price - 1;
    const copyRet = dir * priceRet;
    perCoin.push({ coin: e.coin, dir, priorPrice: e.price, nowPrice: np, priceRet, copyRet, correct: copyRet > 0, weight: Math.abs(e.netNotional) });
  }
  const wsum = perCoin.reduce((a, c) => a + c.weight, 0);
  const portfolioRet = wsum > 0 ? perCoin.reduce((a, c) => a + c.weight * c.copyRet, 0) / wsum : 0;
  const hitRate = perCoin.length ? perCoin.filter((c) => c.correct).length / perCoin.length : 0;
  return { perCoin, portfolioRet, hitRate, nEval: perCoin.length, horizonHours: Math.max((nowTs - prior.ts) / 3_600_000, 0) };
}

/** Aggregate many graded snapshots into a running track record — the OOS answer accumulating over time. */
export function trackRecord(evals: ReadonlyArray<{ portfolioRet: number; hitRate: number; nEval: number }>): { n: number; meanRet: number; hitRate: number; cumRet: number } {
  const withData = evals.filter((e) => e.nEval > 0);
  const n = withData.length;
  if (!n) return { n: 0, meanRet: 0, hitRate: 0, cumRet: 0 };
  const meanRet = withData.reduce((a, e) => a + e.portfolioRet, 0) / n;
  const hitRate = withData.reduce((a, e) => a + e.hitRate, 0) / n;
  const cumRet = withData.reduce((a, e) => a * (1 + e.portfolioRet), 1) - 1;
  return { n, meanRet, hitRate, cumRet };
}

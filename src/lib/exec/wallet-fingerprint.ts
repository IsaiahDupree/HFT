/**
 * wallet-fingerprint — a compact BEHAVIORAL fingerprint of a Hyperliquid wallet from its fills, plus the
 * scoring for a real test: can a model (or a heuristic) tell a GENUINELY-PROFITABLE wallet from a FAKE one
 * (the 88%-win-rate / profit-factor-0.54 "pennies in front of a steamroller" trap) using ONLY the behavioral
 * pattern — NOT the realized PnL/profit-factor, which are the hidden label? The fingerprint deliberately
 * EXCLUDES realizedPnl and profitFactor so the label can't leak. Pure + deterministic; the bench script does
 * the I/O + the live AI-loop calls + the permutation test driver.
 */

export type Fill = { coin: string; dir: string; sz: number; px: number; closedPnl: number; time: number };

export type Fingerprint = {
  nFills: number;
  tradesPerDay: number;
  winRate: number;        // fraction of CLOSED trades that were green — behavioral, and the TRAP (high ≠ profitable)
  longBias: number;       // fraction of OPENs that were long
  openRatio: number;      // opens / total fills (turnover style)
  nCoins: number;
  topCoinShare: number;   // share of fills in the most-traded coin (concentration)
  avgNotional: number;    // mean |sz·px| per fill
};

/** Build the behavioral fingerprint. Deliberately omits realizedPnl + profitFactor (those are the label). */
export function buildFingerprint(fills: readonly Fill[]): Fingerprint {
  const n = fills.length;
  if (n === 0) return { nFills: 0, tradesPerDay: 0, winRate: 0, longBias: 0.5, openRatio: 0, nCoins: 0, topCoinShare: 0, avgNotional: 0 };
  const times = fills.map((f) => f.time);
  const spanDays = Math.max((Math.max(...times) - Math.min(...times)) / 86_400_000, 1e-6);
  const coin = new Map<string, number>();
  let opens = 0, longOpens = 0, closes = 0, wins = 0, notional = 0;
  for (const f of fills) {
    coin.set(f.coin, (coin.get(f.coin) ?? 0) + 1);
    notional += Math.abs(f.sz * f.px);
    if (/Open/i.test(f.dir)) { opens++; if (/Long/i.test(f.dir)) longOpens++; }
    if (/Close/i.test(f.dir)) { closes++; if (f.closedPnl > 0) wins++; }
  }
  const top = Math.max(...coin.values());
  return {
    nFills: n, tradesPerDay: n / spanDays, winRate: closes ? wins / closes : 0, longBias: opens ? longOpens / opens : 0.5,
    openRatio: opens / n, nCoins: coin.size, topCoinShare: top / n, avgNotional: notional / n,
  };
}

/**
 * Deterministic baseline guess of "genuinely profitable", encoding the verification lesson: an EXTREME win rate
 * is a red flag (the steamroller trap), pure HFT churn is un-assessable. Guess winner when the win rate is in a
 * SUSTAINABLE band and the wallet isn't a hyperactive churner. A real hypothesis the AI loops must beat.
 */
export function deterministicWinnerGuess(fp: Fingerprint): boolean {
  return fp.winRate >= 0.42 && fp.winRate <= 0.80 && fp.tradesPerDay < 120 && fp.nFills >= 10;
}

export const accuracy = (pred: readonly boolean[], truth: readonly boolean[]): number => {
  const n = Math.min(pred.length, truth.length); if (!n) return 0;
  let c = 0; for (let i = 0; i < n; i++) if (pred[i] === truth[i]) c++; return c / n;
};

/**
 * Permutation test: is the prediction↔truth association better than chance? Shuffle the TRUTH labels K times
 * (seeded) and recompute accuracy under the null; p = fraction of shuffles whose accuracy ≥ the observed.
 * p < 0.05 ⇒ the predictor carries real signal about wallet profitability.
 */
export function permutationPValue(pred: readonly boolean[], truth: readonly boolean[], K = 1000, seed = 7): number {
  const real = accuracy(pred, truth);
  let s = seed >>> 0; const rnd = () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0xffffffff; };
  let ge = 0;
  for (let k = 0; k < K; k++) {
    const t = [...truth];
    for (let i = t.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [t[i], t[j]] = [t[j], t[i]]; }
    if (accuracy(pred, t) >= real) ge++;
  }
  return ge / K;
}

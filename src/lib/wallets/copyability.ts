/**
 * Copyability scorer — would copying this wallet's trades have worked?
 *
 * ChatGPT's insight (paraphrased): "by the time you see a whale's trade,
 * the edge is often gone." The only way to know is to score whether their
 * HISTORICAL trades made money after costs. This module does that from
 * the wallet's own closedPositions data + observed trade lag, no external
 * timeseries needed.
 *
 * Pure function. Inputs are the Data API's `closed-positions` array and
 * the recent `userTrades` array. Output is a CopyabilityReport with a
 * 0–100 score that combines win rate, consistency, sample size, and profit.
 *
 * A high score doesn't mean "copy this wallet directly" — it means the
 * wallet's historical pattern was profitable after costs. Cross-wallet
 * consensus + capsule gates still apply.
 *
 * Limitations stamped in `caveats`:
 *   - snapshot-only PnL (closed positions only; floating PnL excluded)
 *   - no slippage simulation (assumes your copy hit the same price)
 *   - no execution delay modeling (TODO: timeseries-backed delay grid)
 */

export type CopyabilityClosedPosition = {
  /** Open-positions endpoint name. */
  cashPnl?: number | string;
  /** Closed-positions endpoint name — Polymarket uses different field names per endpoint. */
  realizedPnl?: number | string;
  size?: number | string;
  conditionId?: string;
  initialValue?: number | string;
  currentValue?: number | string;
};

export type CopyabilityTrade = {
  conditionId?: string;
  timestamp?: number | string;
  side?: string;
  usdcSize?: number | string;
};

export type CopyabilityInput = {
  wallet: string;
  closedPositions: CopyabilityClosedPosition[];
  trades?: CopyabilityTrade[];
};

export type CopyabilityReport = {
  wallet: string;
  observedClosed: number;
  observedTrades: number;
  winRate: number | null;
  avgPnlUsd: number | null;
  medianPnlUsd: number | null;
  pnlStdevUsd: number | null;
  totalPnlUsd: number;
  largestWinUsd: number;
  largestLossUsd: number;
  /** Median per-market hold span, when trades provided. */
  medianHoldMinutes: number | null;
  /** 0–100. Higher = more copyable. Combines win rate × sample × consistency × profit-gate. */
  copyabilityScore: number;
  caveats: string[];
};

function num(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function scoreCopyability(input: CopyabilityInput): CopyabilityReport {
  const closed = input.closedPositions ?? [];
  const trades = input.trades ?? [];
  const caveats: string[] = [];

  // Polymarket's /closed-positions returns `realizedPnl`; /positions (open)
  // returns `cashPnl`. Support both so the scorer works on either source.
  const pnls = closed.map((p) => num(p.realizedPnl ?? p.cashPnl));
  const observedClosed = pnls.length;
  const observedTrades = trades.length;

  if (observedClosed < 5) {
    caveats.push(`insufficient closed positions (n=${observedClosed}) — score is 0 until ≥5 closes observed`);
  }

  const wins = pnls.filter((p) => p > 0).length;
  const winRate = observedClosed > 0 ? wins / observedClosed : null;
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const avgPnl = observedClosed > 0 ? totalPnl / observedClosed : null;
  const medianPnl = observedClosed > 0 ? median(pnls) : null;
  const pnlStdev = observedClosed > 1 ? stdev(pnls) : null;
  const largestWin = pnls.length ? Math.max(...pnls) : 0;
  const largestLoss = pnls.length ? Math.min(...pnls) : 0;

  // Hold time from trades (per-conditionId earliest → latest spread)
  let medianHoldMinutes: number | null = null;
  if (trades.length >= 2) {
    const byCondition = new Map<string, number[]>();
    for (const t of trades) {
      if (!t.conditionId) continue;
      const ts = num(t.timestamp);
      const ms = ts > 1e12 ? ts : ts * 1000;
      if (!ms) continue;
      if (!byCondition.has(t.conditionId)) byCondition.set(t.conditionId, []);
      byCondition.get(t.conditionId)!.push(ms);
    }
    const spreadsMin: number[] = [];
    for (const tss of byCondition.values()) {
      if (tss.length < 2) continue;
      const sorted = [...tss].sort((a, b) => a - b);
      spreadsMin.push((sorted[sorted.length - 1] - sorted[0]) / 60_000);
    }
    if (spreadsMin.length > 0) medianHoldMinutes = median(spreadsMin);
  } else {
    caveats.push("no trade history provided — hold time unknown");
  }

  // Score: winRate × sampleFactor × consistencyFactor × profitGate (0 if avg≤0).
  let score = 0;
  if (observedClosed >= 5 && winRate != null && avgPnl != null) {
    const baseScore = winRate * 100;
    const sampleFactor = Math.min(1, observedClosed / 30);
    const cv =
      pnlStdev != null && Math.abs(avgPnl) > 0 ? Math.abs(pnlStdev / avgPnl) : 1;
    const consistencyFactor = 1 / (1 + cv);
    const profitGate = avgPnl > 0 ? 1 : 0;
    score = baseScore * sampleFactor * consistencyFactor * profitGate;
  }

  if (winRate != null && winRate < 0.5 && observedClosed >= 5) {
    caveats.push(`win rate ${(winRate * 100).toFixed(0)}% — historically a losing pattern`);
  }
  if (avgPnl != null && avgPnl < 0) {
    caveats.push(`avg PnL $${avgPnl.toFixed(2)} per close — negative expectation`);
  }
  caveats.push("snapshot-only PnL; no slippage or execution delay simulated");

  return {
    wallet: input.wallet,
    observedClosed,
    observedTrades,
    winRate,
    avgPnlUsd: avgPnl,
    medianPnlUsd: medianPnl,
    pnlStdevUsd: pnlStdev,
    totalPnlUsd: totalPnl,
    largestWinUsd: largestWin,
    largestLossUsd: largestLoss,
    medianHoldMinutes,
    copyabilityScore: Math.round(Math.min(100, Math.max(0, score))),
    caveats,
  };
}

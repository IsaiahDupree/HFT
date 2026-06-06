/**
 * consensus-paper — the ONLY non-circular test of the Polymarket consensus edge. The retro path is
 * survivorship-circular (the cohort is PnL-selected and `won` is read from their OWN closed positions). This
 * records each live consensus signal on a STILL-OPEN market with its entry price BEFORE resolution, then grades
 * it later against the market's INDEPENDENT Gamma resolution (winningIndex) — the outcome is no longer derived
 * from the cohort, so the loop is broken. Accumulated over weeks it answers "does following consensus pay
 * FORWARD?" honestly. Pure: grade one resolved signal + aggregate the running track; the script does detect/IO.
 */

export type RecordedSignal = {
  conditionId: string;
  dirIdx: 0 | 1;          // the outcome index the consensus bet
  entryPrice: number;     // price PAID for that outcome at detection (∈ (0,1)) — the implied probability
  walletCount: number;
  detectedTs: number;
};

export type GradedSignal = RecordedSignal & { winningIndex: number; won: boolean; copyReturn: number; resolvedTs: number };

/** Grade one signal against its INDEPENDENT resolution. copyReturn per $1: WIN ⇒ (1−entry)/entry, LOSS ⇒ −1. */
export function gradeForwardSignal(s: RecordedSignal, winningIndex: number, resolvedTs: number, slipBps = 100): GradedSignal {
  const entry = Math.min(s.entryPrice * (1 + slipBps / 1e4), 0.999);
  const won = winningIndex === s.dirIdx;
  const copyReturn = entry > 0 && entry < 1 ? (won ? (1 - entry) / entry : -1) : -1;
  return { ...s, winningIndex, won, copyReturn, resolvedTs };
}

export type ForwardTrack = {
  n: number; wins: number; winRate: number;
  meanCopyReturn: number; cumReturn: number;
  impliedWinRate: number; edgeVsImplied: number;
  verdict: "accumulating" | "forward_confirmed" | "marginal" | "rejected";
  reason: string;
};

export type ForwardOpts = { minN?: number; confirmWin?: number; confirmEdge?: number; rejectWin?: number };

/**
 * The accumulating out-of-sample verdict. confirm only with enough resolved signals AND a held win rate AND a
 * real edge vs the entry price. This is the bar that turns survivorship_suspect into a real, deployable edge.
 */
export function forwardTrackRecord(graded: readonly GradedSignal[], opts: ForwardOpts = {}): ForwardTrack {
  const minN = opts.minN ?? 30, confirmWin = opts.confirmWin ?? 0.8, confirmEdge = opts.confirmEdge ?? 0.15, rejectWin = opts.rejectWin ?? 0.65;
  const n = graded.length;
  if (n === 0) return { n: 0, wins: 0, winRate: 0, meanCopyReturn: 0, cumReturn: 0, impliedWinRate: 0, edgeVsImplied: 0, verdict: "accumulating", reason: "no resolved forward signals yet" };
  const wins = graded.filter((g) => g.won).length;
  const winRate = wins / n;
  const meanCopyReturn = graded.reduce((a, g) => a + g.copyReturn, 0) / n;
  const cumReturn = graded.reduce((a, g) => a * (1 + g.copyReturn), 1) - 1;
  const impliedWinRate = graded.reduce((a, g) => a + g.entryPrice, 0) / n;
  const edgeVsImplied = winRate - impliedWinRate;
  const { verdict, reason } = (() => {
    if (n < minN) return { verdict: "accumulating" as const, reason: `${n}/${minN} resolved — win ${(winRate * 100).toFixed(0)}%, edge ${edgeVsImplied >= 0 ? "+" : ""}${(edgeVsImplied * 100).toFixed(0)}pts (need ${minN} for a verdict)` };
    if (winRate >= confirmWin && edgeVsImplied >= confirmEdge) return { verdict: "forward_confirmed" as const, reason: `FORWARD EDGE: win ${(winRate * 100).toFixed(0)}% ≥ ${confirmWin * 100}% AND edge +${(edgeVsImplied * 100).toFixed(0)}pts ≥ +${confirmEdge * 100}pts over ${n} independent resolutions — deployable` };
    if (winRate < rejectWin || edgeVsImplied <= 0) return { verdict: "rejected" as const, reason: `no forward edge: win ${(winRate * 100).toFixed(0)}%, edge ${edgeVsImplied >= 0 ? "+" : ""}${(edgeVsImplied * 100).toFixed(0)}pts — the retro result was survivorship` };
    return { verdict: "marginal" as const, reason: `win ${(winRate * 100).toFixed(0)}%, edge +${(edgeVsImplied * 100).toFixed(0)}pts over ${n} — real but below the deploy bar` };
  })();
  return { n, wins, winRate, meanCopyReturn, cumReturn, impliedWinRate, edgeVsImplied, verdict, reason };
}

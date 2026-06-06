/**
 * consensus-falsification — the missing control on the Polymarket consensus thesis. The consensus backtester
 * settles signals against ground-truth resolved outcomes, which is honest measurement — but a positive PnL can
 * still be DIRECTIONAL BETA (the cohort piling into favorites that resolve YES anyway), not a real edge. This
 * adds the falsification the stack lacked, BALANCED on purpose (the operator flagged a negativity bias):
 *   • SKEPTIC: a direction-FLIP and a K-shuffle RANDOM-direction permutation → p = P(random ≥ real). If shuffling
 *     the direction does as well, the consensus DIRECTION carries no information.
 *   • ADVOCATE: an IMPLIED-PROBABILITY baseline → does the consensus win MORE than its entry price already implied?
 *     edgeVsImplied = realWinRate − meanImpliedProb. Beating fair odds is a genuine edge even if it bets favorites.
 * A real edge must clear BOTH: beat random direction (p<0.05) AND beat the price (edgeVsImplied>0). Pure.
 */
import type { ConsensusSignal } from "./consensus";
import type { ResolvedMarket } from "./copy-backtest";
import { backtestConsensusSignals, classifyDirection, type ConsensusBacktestOpts } from "./consensus-backtest";

const withDir = (sig: ConsensusSignal, idx: 0 | 1): ConsensusSignal => ({ ...sig, direction: idx === 0 ? "yes" : "no" });
const pnlPctAt = (signals: ConsensusSignal[], resolved: Map<string, ResolvedMarket>, opts: ConsensusBacktestOpts, slip = 100): number => {
  const r = backtestConsensusSignals(signals, resolved, opts);
  return (r.buckets.find((b) => b.slippage_bps === slip) ?? r.buckets[0])?.pnl_pct ?? 0;
};

export type ConsensusFalsification = {
  n: number;
  realPnlPct: number;
  realWinRate: number;
  flippedPnlPct: number;          // all directions flipped — should be much worse if direction is informative
  randomMeanPnlPct: number;       // mean PnL over K random-direction shuffles (the null)
  randomP: number;                // P(random-direction PnL ≥ real) — skeptic control; <0.05 = direction informative
  impliedWinRate: number;         // mean entry-implied probability (fair odds the price already gave you)
  edgeVsImplied: number;          // realWinRate − impliedWinRate — advocate control; >0 = beats the price
  rating: "insufficient_data" | "no_edge_beta" | "favorites_only" | "direction_only" | "real_edge";
  reason: string;
};

/**
 * Falsify (or confirm) a consensus signal set against resolved outcomes.
 * @param K random-direction shuffles for the permutation p-value
 */
export function falsifyConsensus(
  signals: ConsensusSignal[],
  resolved: Map<string, ResolvedMarket>,
  opts: ConsensusBacktestOpts = {},
  K = 1000,
  seed = 7,
): ConsensusFalsification {
  const real = backtestConsensusSignals(signals, resolved, opts);
  const realBucket = real.buckets.find((b) => b.slippage_bps === 100) ?? real.buckets[0];
  const realPnlPct = realBucket?.pnl_pct ?? 0, realWinRate = realBucket?.win_rate ?? 0;
  const n = real.signals_used;
  const minDistinct = opts.minDistinctSignals ?? 5;

  // implied-probability baseline (advocate): the price the consensus paid already encodes a probability.
  let impliedSum = 0, impliedN = 0;
  for (const s of signals) {
    const m = resolved.get(s.marketKey); if (!m) continue;
    const idx = classifyDirection(s.direction); if (idx == null) continue;
    const entryRef = idx === 0 ? s.avgPrice : 1 - s.avgPrice;
    if (entryRef > 0 && entryRef < 1) { impliedSum += entryRef; impliedN += 1; }
  }
  const impliedWinRate = impliedN > 0 ? impliedSum / impliedN : 0;
  const edgeVsImplied = realWinRate - impliedWinRate;

  // direction-flip (skeptic): bet the opposite of the consensus everywhere.
  const flipped = signals.map((s) => { const idx = classifyDirection(s.direction); return idx == null ? s : withDir(s, idx === 0 ? 1 : 0); });
  const flippedPnlPct = pnlPctAt(flipped, resolved, opts);

  // random-direction permutation (skeptic): null distribution of PnL when direction is coin-flipped.
  let st = seed >>> 0; const rnd = () => { st = (1664525 * st + 1013904223) >>> 0; return st / 0xffffffff; };
  let ge = 0, sum = 0;
  for (let k = 0; k < K; k++) {
    const rs = signals.map((s) => withDir(s, rnd() < 0.5 ? 0 : 1));
    const p = pnlPctAt(rs, resolved, opts);
    sum += p; if (p >= realPnlPct) ge++;
  }
  const randomP = ge / K, randomMeanPnlPct = sum / K;

  const { rating, reason } = (() => {
    if (n < minDistinct) return { rating: "insufficient_data" as const, reason: `only ${n} scorable signals — need ≥${minDistinct}` };
    const beatsRandom = randomP < 0.05, beatsPrice = edgeVsImplied > 0.03;
    if (realPnlPct <= 0) return { rating: "no_edge_beta" as const, reason: `real PnL ${(realPnlPct * 100).toFixed(1)}% ≤ 0` };
    if (beatsRandom && beatsPrice) return { rating: "real_edge" as const, reason: `beats random direction (p=${randomP.toFixed(3)}) AND fair odds (edge +${(edgeVsImplied * 100).toFixed(1)}pts) — genuine consensus edge` };
    if (beatsRandom && !beatsPrice) return { rating: "favorites_only" as const, reason: `direction beats random (p=${randomP.toFixed(3)}) but win rate ${(realWinRate * 100).toFixed(0)}% ≈ implied ${(impliedWinRate * 100).toFixed(0)}% — just betting favorites, no edge vs price` };
    if (!beatsRandom && beatsPrice) return { rating: "direction_only" as const, reason: `beats fair odds (+${(edgeVsImplied * 100).toFixed(1)}pts) but NOT random direction (p=${randomP.toFixed(3)}) — fragile` };
    return { rating: "no_edge_beta" as const, reason: `random direction does as well (p=${randomP.toFixed(3)}) and no edge vs price — directional beta` };
  })();

  return { n, realPnlPct, realWinRate, flippedPnlPct, randomMeanPnlPct, randomP, impliedWinRate, edgeVsImplied, rating, reason };
}

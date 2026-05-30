/**
 * Loss-overlap score — the highest-value scalar in capsule portfolio
 * governance (per PRD §4.3):
 *
 *   "When this capsule loses, how often do other capsules lose at the same time?"
 *
 * A capsule with consistent positive returns but high loss-overlap is
 * REDUNDANT: it gives the appearance of diversification without delivering
 * it. The global allocator caps its allocation regardless of profitability.
 *
 * The score:
 *   loss_overlap = mean over loss-days of fraction(others also losing)
 *                = P(other capsule lost | this capsule lost)  averaged over peers
 *
 * Range [0, 1]. Lower is better (your losses are unique).
 *
 * Pure / deterministic / no I/O. Driven by daily-PnL series aligned by date.
 *
 * See PRD: docs/prd/capsule-portfolio-governance-2026-05-27.md §4.3
 */
import type { DailyPnlPoint } from "./correlation";

export type LossOverlapInputs = {
  /** The capsule whose loss-overlap is being measured. */
  targetSeries: readonly DailyPnlPoint[];
  /** Every other capsule's daily PnL series. */
  others: readonly { capsuleId: string; series: readonly DailyPnlPoint[] }[];
  /** Look-back window in days. Series are clipped to the most recent N days
   *  via date-string DESC sort before alignment. */
  windowDays?: number;
};

export type LossOverlapResult = {
  /** Mean P(other_lost | target_lost) over peers. 0..1. 0 when target had no loss-days. */
  score: number;
  /** Per-peer breakdown — useful for the /portfolio UI tooltip. */
  perPeer: { capsuleId: string; overlap: number; samples: number }[];
  /** Number of target loss-days within the window (denominator of all per-peer overlaps). */
  targetLossDays: number;
  /** Number of days the target series contributed within the window. */
  targetSampleDays: number;
};

/**
 * Compute the loss-overlap score for `targetSeries` against every series in
 * `others`. Each peer contributes one overlap value; the final score is the
 * unweighted mean across peers (which captures "how clustered are this
 * capsule's losses with the rest of the portfolio?" rather than the
 * peer-weighted version).
 *
 * Pre-condition: each series should be sorted by date ASC (the worker
 * guarantees this when reading from capsule_pnl_daily ORDER BY pnl_date).
 *
 * Returns score=0 + targetLossDays=0 cleanly when the target had no loss
 * days in the window (you can't measure overlap of zero losses).
 */
export function lossOverlapScore(inputs: LossOverlapInputs): LossOverlapResult {
  const windowDays = inputs.windowDays ?? 30;

  const target = clipToWindow(inputs.targetSeries, windowDays);
  const targetLossDates = new Set<string>();
  for (const p of target) {
    if (Number.isFinite(p.pnl) && p.pnl < 0) targetLossDates.add(p.date);
  }
  const targetLossDays = targetLossDates.size;

  if (targetLossDays === 0) {
    return {
      score: 0,
      perPeer: inputs.others.map((o) => ({ capsuleId: o.capsuleId, overlap: 0, samples: 0 })),
      targetLossDays: 0,
      targetSampleDays: target.length,
    };
  }

  const perPeer: { capsuleId: string; overlap: number; samples: number }[] = [];
  let overlapSum = 0;
  let peerCount = 0;

  for (const other of inputs.others) {
    const otherClipped = clipToWindow(other.series, windowDays);
    // Build a quick {date → pnl} for the peer.
    const peerMap = new Map<string, number>();
    for (const p of otherClipped) {
      if (Number.isFinite(p.pnl)) peerMap.set(p.date, p.pnl);
    }
    // Count how many of target's loss-days the peer ALSO lost on.
    let joint = 0;
    let observedTargetLossDays = 0;
    for (const date of targetLossDates) {
      const peerPnl = peerMap.get(date);
      if (peerPnl === undefined) continue; // peer has no observation that day
      observedTargetLossDays++;
      if (peerPnl < 0) joint++;
    }
    // Per-peer overlap: fraction of target's loss-days (where peer ALSO had
    // data) that the peer was also losing. Skip peer with zero observed
    // overlap on the target's loss-days (no information).
    const overlap = observedTargetLossDays === 0 ? 0 : joint / observedTargetLossDays;
    perPeer.push({
      capsuleId: other.capsuleId,
      overlap,
      samples: observedTargetLossDays,
    });
    if (observedTargetLossDays > 0) {
      overlapSum += overlap;
      peerCount++;
    }
  }

  const score = peerCount === 0 ? 0 : overlapSum / peerCount;
  return {
    score,
    perPeer,
    targetLossDays,
    targetSampleDays: target.length,
  };
}

/** Clip a series to the most recent `windowDays` by date string DESC sort. */
function clipToWindow(series: readonly DailyPnlPoint[], windowDays: number): DailyPnlPoint[] {
  if (series.length <= windowDays) return [...series];
  const sorted = [...series].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return sorted.slice(-windowDays);
}

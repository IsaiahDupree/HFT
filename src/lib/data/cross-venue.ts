/**
 * cross-venue — agreement checks between two independent price sources (e.g. Coinbase vs
 * Kraken). Two jobs that directly assist trading decisions:
 *   1. DATA QUALITY — a candle that exists on one venue but is wildly off the other is a bad
 *      tick / single-source artifact (the relstr +12,614% audit lesson: don't trust a number
 *      one source can't corroborate). flagDivergentBars / crossVenueAgreement surface these.
 *   2. CONSOLIDATED PRICE — where venues agree, the mean close is a more robust "true price"
 *      than either alone; where they diverge past a threshold, that's a real-time signal
 *      (latency/arb or a feed problem) the caller should treat with caution.
 * Pure + deterministic; works on the normalized VenueCandle shape.
 */
import type { VenueCandle } from "./venue-candles";

export type AlignedBar = { start_unix: number; a: number; b: number; bps: number };

const divergenceBps = (a: number, b: number): number => {
  const mid = (a + b) / 2;
  return mid > 0 ? Math.abs(a - b) / mid * 1e4 : 0;
};

/** Inner-join two venues' candles by start_unix → close-vs-close with per-bar divergence (bps). */
export function alignVenueCloses(a: readonly VenueCandle[], b: readonly VenueCandle[]): AlignedBar[] {
  const bMap = new Map(b.map((c) => [c.start_unix, c.close]));
  const out: AlignedBar[] = [];
  for (const c of a) {
    const bc = bMap.get(c.start_unix);
    if (bc == null) continue;
    out.push({ start_unix: c.start_unix, a: c.close, b: bc, bps: divergenceBps(c.close, bc) });
  }
  return out.sort((x, y) => x.start_unix - y.start_unix);
}

const quantile = (sorted: number[], q: number): number => {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
};

export type AgreementReport = {
  overlap: number;        // bars present on BOTH venues
  onlyA: number;          // bars only on venue A
  onlyB: number;          // bars only on venue B
  medianBps: number;
  p95Bps: number;
  maxBps: number;
  divergent: AlignedBar[]; // bars exceeding maxBps (sorted worst-first)
  verdict: "agree" | "minor_drift" | "suspect";
};

/**
 * Summarize how well two venues agree on close price over their overlap. `maxBps` (default 50
 * = 0.5%) is the per-bar tolerance; p95 over `driftCeilBps` (default 30) downgrades to
 * "minor_drift", any bar over maxBps → "suspect" (audit the feed before trusting that bar).
 */
export function crossVenueAgreement(
  a: readonly VenueCandle[],
  b: readonly VenueCandle[],
  opts: { maxBps?: number; driftCeilBps?: number } = {},
): AgreementReport {
  const maxBps = opts.maxBps ?? 50, driftCeil = opts.driftCeilBps ?? 30;
  const aligned = alignVenueCloses(a, b);
  const aTs = new Set(a.map((c) => c.start_unix)), bTs = new Set(b.map((c) => c.start_unix));
  const onlyA = [...aTs].filter((t) => !bTs.has(t)).length;
  const onlyB = [...bTs].filter((t) => !aTs.has(t)).length;
  const bpsSorted = aligned.map((x) => x.bps).sort((x, y) => x - y);
  const median = quantile(bpsSorted, 0.5), p95 = quantile(bpsSorted, 0.95);
  const max = bpsSorted.length ? bpsSorted[bpsSorted.length - 1] : 0;
  const divergent = aligned.filter((x) => x.bps > maxBps).sort((x, y) => y.bps - x.bps);
  const verdict: AgreementReport["verdict"] =
    divergent.length ? "suspect" : p95 > driftCeil ? "minor_drift" : "agree";
  return { overlap: aligned.length, onlyA, onlyB, medianBps: median, p95Bps: p95, maxBps: max, divergent, verdict };
}

/**
 * Bars in `primary` whose close diverges from `reference` by more than `maxBps` — likely bad
 * ticks / single-source artifacts to exclude from a backtest or distrust live. (Bars absent
 * from the reference are NOT flagged here — see crossVenueAgreement.onlyA for those.)
 */
export function flagDivergentBars(
  primary: readonly VenueCandle[],
  reference: readonly VenueCandle[],
  opts: { maxBps?: number } = {},
): VenueCandle[] {
  const maxBps = opts.maxBps ?? 50;
  const refMap = new Map(reference.map((c) => [c.start_unix, c.close]));
  return primary.filter((c) => {
    const rc = refMap.get(c.start_unix);
    return rc != null && divergenceBps(c.close, rc) > maxBps;
  });
}

/**
 * A consolidated close series over the venue OVERLAP: the mean of the two closes where they
 * agree within `maxBps`, and (by default) the primary's close where they diverge — but flagged.
 * Returns { start_unix, close, agreed } so the caller can drop or down-weight unconfirmed bars.
 */
export function consolidatedCloses(
  a: readonly VenueCandle[],
  b: readonly VenueCandle[],
  opts: { maxBps?: number } = {},
): Array<{ start_unix: number; close: number; agreed: boolean }> {
  const maxBps = opts.maxBps ?? 50;
  return alignVenueCloses(a, b).map((x) => ({
    start_unix: x.start_unix,
    close: x.bps <= maxBps ? (x.a + x.b) / 2 : x.a,
    agreed: x.bps <= maxBps,
  }));
}

/**
 * strategy-profile — REVERSE-ENGINEER a wallet's backing strategy from its raw fills, so we can decide whether
 * (and how) to copy it. The map's `walletArchetype` is a coarse label; this is the dossier brain: it
 * reconstructs round-trips (FIFO open→close matching) to recover the ONE number copyability hinges on — median
 * HOLD TIME — plus directionality, coin focus, and a per-trade expectancy. Then it scores COPYABILITY honestly:
 *
 *   the user's thesis ("copy any real trade if you understand the strategy") is TRUE for slow strategies and
 *   FALSE for fast ones — not because of understanding, but because of latency/slippage. A 6-hour swing is
 *   mirrorable; a 30-second scalp is gone before its fill is public. This module measures which is which.
 *
 * Pure + deterministic. Scripts do the I/O (fetch fills) and the documentation (write the dossier).
 */
import type { Fill } from "./smart-money.ts";

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

export type RoundTrip = { coin: string; side: "long" | "short"; entryTime: number; exitTime: number; holdMs: number; entryPx: number; exitPx: number; sz: number; pnl: number };

/**
 * Reconstruct closed round-trips via per-coin FIFO matching. Opens push lots; closes pop the oldest matching
 * lots and emit a round-trip with the real hold time. Closes with no matching open (position opened before the
 * fills window) are skipped — we can't know their entry, so they don't pollute the hold-time distribution.
 */
export function reconstructRoundTrips(fills: readonly Fill[]): RoundTrip[] {
  const sorted = [...fills].sort((a, b) => a.time - b.time);
  const lots = new Map<string, Array<{ side: "long" | "short"; sz: number; px: number; time: number }>>();
  const trips: RoundTrip[] = [];
  for (const f of sorted) {
    const isLong = /Long/i.test(f.dir), side: "long" | "short" = isLong ? "long" : "short";
    const key = `${f.coin}:${side}`;
    const q = lots.get(key) ?? [];
    if (/Open/i.test(f.dir)) { q.push({ side, sz: Math.abs(f.sz), px: f.px, time: f.time }); lots.set(key, q); continue; }
    if (!/Close/i.test(f.dir)) continue;
    let remaining = Math.abs(f.sz);
    const closePnlPerUnit = f.sz !== 0 ? f.closedPnl / Math.abs(f.sz) : 0;
    while (remaining > 1e-12 && q.length) {
      const lot = q[0];
      const matched = Math.min(remaining, lot.sz);
      trips.push({ coin: f.coin, side, entryTime: lot.time, exitTime: f.time, holdMs: Math.max(0, f.time - lot.time), entryPx: lot.px, exitPx: f.px, sz: matched, pnl: closePnlPerUnit * matched });
      lot.sz -= matched; remaining -= matched;
      if (lot.sz <= 1e-12) q.shift();
    }
  }
  return trips;
}

const quantile = (xs: readonly number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};

export type Horizon = "scalp" | "intraday" | "swing" | "position";
export type HoldStats = { nTrips: number; medianHoldMs: number; p25HoldMs: number; p75HoldMs: number; meanHoldMs: number; horizon: Horizon };

/** Hold-time distribution + horizon bucket — the spine of copyability. */
export function holdTimeStats(trips: readonly RoundTrip[]): HoldStats {
  const h = trips.map((t) => t.holdMs);
  const median = quantile(h, 0.5);
  const horizon: Horizon = median < 5 * MIN ? "scalp" : median < 4 * HOUR ? "intraday" : median < 3 * DAY ? "swing" : "position";
  return { nTrips: trips.length, medianHoldMs: median, p25HoldMs: quantile(h, 0.25), p75HoldMs: quantile(h, 0.75), meanHoldMs: h.length ? h.reduce((a, b) => a + b, 0) / h.length : 0, horizon };
}

export type CopyMode = "trade-copy" | "position-copy" | "none";
export type Copyability = { score: number; mode: CopyMode; verdict: "copyable" | "hard" | "un-copyable"; reasons: string[] };

const TRADE_COPY_MAX_TPD = 20;   // above this, you can't mirror discrete fills — it's a concurrent book

/**
 * Score copyability ∈ [0,1] from the MECHANICS that decide whether a follower can capture the edge — never from
 * how profitable the original looks. Two distinct copy modes, because they need different machinery:
 *   • trade-copy   — LOW turnover + adequate hold ⇒ mirror each entry/exit one-for-one. The clean case.
 *   • position-copy— long net hold but HIGH turnover ⇒ a big concurrent book; you can only track NET exposure
 *                    daily, not fills. Honest caveat: the reported median hold is likely FIFO-inflated by
 *                    scalping on top of a core, so treat it as approximate. Harder, but real.
 *   • none         — sub-5min churn: latency/slippage eats it before the fill is even public.
 * Only trade-copy earns the clean "copyable" verdict; position-copy is "hard" by design.
 */
export function copyabilityScore(a: { medianHoldMs: number; tradesPerDay: number; nTrips: number }): Copyability {
  const reasons: string[] = [];
  const holdMin = a.medianHoldMs / MIN;
  // 0 at ≤1min hold, 1 at ≥1-day hold (log scale — each 10× of hold buys ~1/3 of the range)
  const holdComponent = Math.max(0, Math.min(1, Math.log10(Math.max(holdMin, 1)) / Math.log10(1440)));
  const discrete = a.tradesPerDay <= TRADE_COPY_MAX_TPD;
  let mode: CopyMode, verdict: Copyability["verdict"], score: number;

  if (holdMin < 5) {
    mode = "none"; verdict = "un-copyable"; score = Math.max(0, holdComponent - 0.5);
    reasons.push(`median hold ${holdMin.toFixed(1)}min — too fast to mirror (latency/slippage eats the edge)`);
  } else if (discrete) {
    score = holdComponent;
    verdict = score >= 0.5 && a.nTrips >= 10 ? "copyable" : score >= 0.25 ? "hard" : "un-copyable";
    mode = verdict === "un-copyable" ? "none" : "trade-copy";
    reasons.push(`${a.tradesPerDay.toFixed(1)} trades/day, median hold ${holdMin < 60 ? holdMin.toFixed(0) + "m" : holdMin < 1440 ? (holdMin / 60).toFixed(1) + "h" : (holdMin / 1440).toFixed(1) + "d"} — discrete trades you can mirror one-for-one`);
  } else if (holdMin >= 1440) {
    mode = "position-copy"; verdict = "hard"; score = Math.max(0, Math.min(0.6, holdComponent - 0.4));
    reasons.push(`${a.tradesPerDay.toFixed(0)} trades/day with a large concurrent book — NOT trade-by-trade copyable; only mirrorable by tracking NET exposure (position-copy)`);
    reasons.push(`reported median hold ${(holdMin / 1440).toFixed(1)}d is likely FIFO-inflated by scalping on top of a core position — treat as approximate`);
  } else {
    mode = "none"; verdict = "un-copyable"; score = Math.max(0, Math.min(0.4, holdComponent - 0.5));
    reasons.push(`${a.tradesPerDay.toFixed(0)} trades/day, sub-day book — churns faster than a copier can react`);
  }
  if (a.nTrips < 10) reasons.push(`only ${a.nTrips} round-trips — low confidence, need more history`);
  return { score, mode, verdict, reasons };
}

export type Directionality = "momentum-long" | "momentum-short" | "two-sided";
export type StrategyProfile = {
  label: string; horizon: Horizon; directionality: Directionality; copyability: Copyability; hold: HoldStats;
  longShare: number; topCoin: string; topCoinShare: number; nCoins: number; winRate: number; expectancyUsd: number; realizedPnl: number;
};

/**
 * Synthesize the full reverse-engineered strategy: horizon × directionality × focus × copyability, plus the
 * per-round-trip expectancy (the honest "would copying this have paid?" number). `label` is the human one-liner
 * that goes at the top of the wallet's dossier.
 */
export function profileStrategy(fills: readonly Fill[]): StrategyProfile {
  const trips = reconstructRoundTrips(fills);
  const hold = holdTimeStats(trips);
  const opens = fills.filter((f) => /Open/i.test(f.dir));
  const longShare = opens.length ? opens.filter((f) => /Long/i.test(f.dir)).length / opens.length : 0.5;
  const directionality: Directionality = longShare >= 0.7 ? "momentum-long" : longShare <= 0.3 ? "momentum-short" : "two-sided";
  const coinCount = new Map<string, number>();
  for (const f of fills) coinCount.set(f.coin, (coinCount.get(f.coin) ?? 0) + 1);
  const [topCoin, topN] = [...coinCount.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  const spanDays = fills.length ? Math.max((Math.max(...fills.map((f) => f.time)) - Math.min(...fills.map((f) => f.time))) / DAY, 1e-6) : 1;
  const tradesPerDay = fills.length / spanDays;
  const copyability = copyabilityScore({ medianHoldMs: hold.medianHoldMs, tradesPerDay, nTrips: trips.length });
  const wins = trips.filter((t) => t.pnl > 0).length;
  const winRate = trips.length ? wins / trips.length : 0;
  const realizedPnl = trips.reduce((a, t) => a + t.pnl, 0);
  const expectancyUsd = trips.length ? realizedPnl / trips.length : 0;
  const focus = topCoinShareOf(coinCount, fills.length) >= 0.6 ? `${topCoin}-specialist` : `${coinCount.size}-coin`;
  const copyTag = copyability.mode === "trade-copy" ? "trade-copy" : copyability.mode === "position-copy" ? "position-copy (net-book only)" : "un-copyable";
  const label = `${directionality} ${hold.horizon} (${focus}) — ${copyTag}`;
  return { label, horizon: hold.horizon, directionality, copyability, hold, longShare, topCoin, topCoinShare: topCoinShareOf(coinCount, fills.length), nCoins: coinCount.size, winRate, expectancyUsd, realizedPnl };
}

const topCoinShareOf = (m: Map<string, number>, total: number): number => (total ? Math.max(0, ...m.values()) / total : 0);

export const fmtHold = (ms: number): string => ms >= DAY ? `${(ms / DAY).toFixed(1)}d` : ms >= HOUR ? `${(ms / HOUR).toFixed(1)}h` : ms >= MIN ? `${(ms / MIN).toFixed(0)}m` : `${(ms / 1000).toFixed(0)}s`;

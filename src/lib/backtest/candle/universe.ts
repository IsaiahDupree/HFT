/**
 * universe — cohort selection + a SPLICE DETECTOR for the candle warehouse. Adversarial review
 * of the regime analysis found the warehouse is two ingests glued together: 12 Coinbase "-USD"
 * symbols (full history → 2026) and 66 Binance "USDT" symbols that ALL die 2024-12-31. Any
 * cross-sectional/portfolio backtest whose window crosses that date measures its strategy
 * against a buy-and-hold benchmark whose universe collapses 78→12 overnight — garbage. These
 * helpers (1) restrict to one time-stable cohort and (2) flag a composition cliff so it can
 * never silently contaminate a result again. Pure + tested.
 */
const DAY = 86_400;

export type HasTime = { start_unix: number };
export type RowMap<T extends HasTime> = Record<string, T[]>;
export type CoinSpan = { first: number; last: number; n: number };

/** Per-coin coverage span (first/last start_unix + bar count). Skips empty series. */
export function coinSpans<T extends HasTime>(rows: RowMap<T>): Record<string, CoinSpan> {
  const out: Record<string, CoinSpan> = {};
  for (const [c, arr] of Object.entries(rows)) {
    if (!arr.length) continue;
    let first = Infinity, last = -Infinity;
    for (const r of arr) { if (r.start_unix < first) first = r.start_unix; if (r.start_unix > last) last = r.start_unix; }
    out[c] = { first, last, n: arr.length };
  }
  return out;
}

/** Keep only products of one quote convention: "usd" = ends in -USD (Coinbase), "usdt" = ends in USDT (Binance). */
export function restrictToConvention<T>(rows: Record<string, T[]>, conv: "usd" | "usdt"): Record<string, T[]> {
  const match = conv === "usd" ? (c: string) => /-USD$/i.test(c) : (c: string) => /USDT$/i.test(c);
  const out: Record<string, T[]> = {};
  for (const [c, arr] of Object.entries(rows)) if (match(c)) out[c] = arr;
  return out;
}

/**
 * Keep only coins still trading near the dataset end (last bar within `graceDays` of the global
 * max). Drops cohorts that died mid-history (the USDT splice) so the surviving universe has
 * stable membership through "today". (Note: this is the opposite bias from survivorship — it's
 * deliberately the CURRENT, single-source cohort, for a clean current-data backtest.)
 */
export function aliveAtEnd<T extends HasTime>(rows: RowMap<T>, graceDays = 7): RowMap<T> {
  const spans = coinSpans(rows);
  const lasts = Object.values(spans).map((s) => s.last);
  if (!lasts.length) return {};
  const cutoff = Math.max(...lasts) - graceDays * DAY;
  const out: RowMap<T> = {};
  for (const [c, arr] of Object.entries(rows)) if (spans[c] && spans[c].last >= cutoff) out[c] = arr;
  return out;
}

export type UniverseHealth = {
  coins: number;
  days: number;
  minActive: number;   // fewest coins active on any single day
  maxActive: number;   // most coins active on any single day
  biggestDrop: { atUnix: number; from: number; to: number; lost: number } | null; // largest one-day fall in active count
  spliceSuspected: boolean; // a drop ≥ `dropThreshold` coins in a single day
};

/**
 * Active-coin count over time + the largest single-day drop — a composition-cliff detector. A
 * `spliceSuspected: true` (a ≥`dropThreshold` one-day collapse) means a portfolio benchmark
 * built over this universe changes instrument mid-sample; restrict to a cohort before trusting it.
 */
export function universeHealth<T extends HasTime>(rows: RowMap<T>, opts: { dropThreshold?: number } = {}): UniverseHealth {
  const dropThreshold = opts.dropThreshold ?? 20;
  const dayCount = new Map<number, number>();
  for (const arr of Object.values(rows)) {
    const seen = new Set<number>();
    for (const r of arr) if (!seen.has(r.start_unix)) { seen.add(r.start_unix); dayCount.set(r.start_unix, (dayCount.get(r.start_unix) ?? 0) + 1); }
  }
  const days = [...dayCount.keys()].sort((a, b) => a - b);
  if (!days.length) return { coins: Object.keys(rows).length, days: 0, minActive: 0, maxActive: 0, biggestDrop: null, spliceSuspected: false };
  let minA = Infinity, maxA = -Infinity;
  let biggest: UniverseHealth["biggestDrop"] = null;
  for (let i = 0; i < days.length; i++) {
    const c = dayCount.get(days[i])!;
    if (c < minA) minA = c;
    if (c > maxA) maxA = c;
    if (i > 0) {
      const prev = dayCount.get(days[i - 1])!;
      const lost = prev - c;
      if (!biggest || lost > biggest.lost) biggest = { atUnix: days[i], from: prev, to: c, lost };
    }
  }
  return {
    coins: Object.keys(rows).length, days: days.length, minActive: minA, maxActive: maxA,
    biggestDrop: biggest, spliceSuspected: !!biggest && biggest.lost >= dropThreshold,
  };
}

/** Resolve a --universe flag to a filtered row map. "all" = unchanged (the contaminated default). */
export function selectUniverse<T extends HasTime>(rows: RowMap<T>, mode: "all" | "usd" | "usdt" | "alive"): RowMap<T> {
  switch (mode) {
    case "usd": return restrictToConvention(rows, "usd");
    case "usdt": return restrictToConvention(rows, "usdt");
    case "alive": return aliveAtEnd(rows);
    default: return rows;
  }
}

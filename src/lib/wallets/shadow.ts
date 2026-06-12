/**
 * Pure logic for the forward shadow-tracker (scripts/shadow-wallet.ts) and its
 * report (scripts/shadow-wallet-report.ts). Everything here is plain data →
 * plain data so the unit tests can drive it without HTTP or SQLite.
 *
 * Context: COPY-BACKTEST-2026-06-11.md verdicts — 0x418d51e1 "copyable ≤300s",
 * alwaysfade "conditional on ≥$1k clips" — are settled by a 2-week forward
 * shadow that records, per detected leader trade: detection latency, the LIVE
 * executable book (best ask + spread) at detection / +60s / +300s after the
 * leader's fill, clip size in USD, and (later, via Gamma) resolution.
 */

// ── leader-trade normalization ──────────────────────────────────────────────

/** Raw row from data-api `/trades?user=…` (fields we rely on). */
export type RawLeaderTrade = {
  transactionHash?: string;
  asset?: string;          // CLOB token id of the side traded
  conditionId?: string;
  eventSlug?: string;
  slug?: string;
  title?: string;
  outcome?: string;
  outcomeIndex?: number | string;
  side?: string;           // BUY | SELL
  price?: number | string;
  size?: number | string;  // shares
  usdcSize?: number | string;
  timestamp?: number | string; // unix SECONDS (data-api) — sometimes ms elsewhere
  [k: string]: unknown;
};

export type ShadowLeaderTrade = {
  txHash: string;
  tokenId: string;
  conditionId: string | null;
  eventSlug: string | null;
  question: string | null;
  outcome: string | null;
  outcomeIndex: number | null;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  usd: number;
  /** Leader fill time, unix MILLISECONDS. */
  leaderTsMs: number;
};

/** Normalize a data-api trade row. Returns null if it lacks the fields the
 *  shadow needs (txHash, tokenId, price, timestamp). */
export function normalizeLeaderTrade(raw: RawLeaderTrade): ShadowLeaderTrade | null {
  const txHash = String(raw.transactionHash ?? "");
  const tokenId = String(raw.asset ?? "");
  const price = Number(raw.price ?? NaN);
  const tsRaw = Number(raw.timestamp ?? NaN);
  if (!txHash || !tokenId || !Number.isFinite(price) || price <= 0 || !Number.isFinite(tsRaw) || tsRaw <= 0) {
    return null;
  }
  const leaderTsMs = tsRaw > 1e12 ? tsRaw : tsRaw * 1000; // sec vs ms (repo convention)
  const size = Number(raw.size ?? 0);
  const usdRaw = Number(raw.usdcSize ?? NaN);
  const usd = Number.isFinite(usdRaw) && usdRaw > 0 ? usdRaw : size * price;
  const oiRaw = Number(raw.outcomeIndex ?? NaN);
  return {
    txHash,
    tokenId,
    conditionId: raw.conditionId ? String(raw.conditionId) : null,
    eventSlug: String(raw.eventSlug ?? raw.slug ?? "") || null,
    question: raw.title ? String(raw.title) : null,
    outcome: raw.outcome ? String(raw.outcome) : null,
    outcomeIndex: Number.isFinite(oiRaw) ? oiRaw : null,
    side: String(raw.side ?? "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY",
    price,
    size: Number.isFinite(size) ? size : 0,
    usd: Number.isFinite(usd) ? usd : 0,
    leaderTsMs,
  };
}

// ── detection latency ───────────────────────────────────────────────────────

/** Poll-detection latency. Clamped at 0 (data-api timestamps are whole seconds
 *  and can land a hair "ahead" of our clock). */
export function detectionLatencyMs(leaderTsMs: number, detectedTsMs: number): number {
  return Math.max(0, detectedTsMs - leaderTsMs);
}

// ── follow-up sample scheduling ─────────────────────────────────────────────

export type SampleDue = { offsetSec: number; dueMs: number };

/**
 * Sample times for a detected trade. Offset 0 = "at detection" (due now).
 * Offsets 60/300 are relative to the LEADER's fill (that is the delay the
 * backtest parameterized); if the poll detected the trade after the offset has
 * already passed, the sample is due immediately — the actual sampled timestamp
 * is recorded so the report computes the ACHIEVED offset honestly instead of
 * pretending it was 60s.
 */
export function sampleDueTimes(
  leaderTsMs: number,
  detectedTsMs: number,
  offsetsSec: number[] = [60, 300],
): SampleDue[] {
  const out: SampleDue[] = [{ offsetSec: 0, dueMs: detectedTsMs }];
  for (const off of offsetsSec) {
    out.push({ offsetSec: off, dueMs: Math.max(leaderTsMs + off * 1000, detectedTsMs) });
  }
  return out;
}

// ── order book top ──────────────────────────────────────────────────────────

export type BookLevel = { price: string | number; size: string | number };
export type RawBook = { bids?: BookLevel[]; asks?: BookLevel[] };
export type BookTop = {
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  mid: number | null;
};

/** Best bid/ask from a CLOB `/book` response. Does NOT assume sort order. */
export function bookTop(book: RawBook | null | undefined): BookTop {
  let bestBid: number | null = null;
  let bestAsk: number | null = null;
  for (const lvl of book?.bids ?? []) {
    const p = Number(lvl?.price);
    if (Number.isFinite(p) && p > 0 && (bestBid === null || p > bestBid)) bestBid = p;
  }
  for (const lvl of book?.asks ?? []) {
    const p = Number(lvl?.price);
    if (Number.isFinite(p) && p > 0 && (bestAsk === null || p < bestAsk)) bestAsk = p;
  }
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  return { bestBid, bestAsk, spread, mid };
}

// ── copy-entry slippage ─────────────────────────────────────────────────────

/**
 * Cost (in price units, i.e. dollars per share / "cents" × 100) a taker copier
 * pays vs the leader's fill. BUY copy crosses to the best ask; SELL copy (a
 * mirrored exit) crosses to the best bid. Positive = copier pays worse.
 */
export function copyEntrySlippage(
  side: "BUY" | "SELL",
  leaderPrice: number,
  top: Pick<BookTop, "bestBid" | "bestAsk">,
): number | null {
  if (!Number.isFinite(leaderPrice) || leaderPrice <= 0) return null;
  if (side === "BUY") {
    return top.bestAsk === null ? null : top.bestAsk - leaderPrice;
  }
  return top.bestBid === null ? null : leaderPrice - top.bestBid;
}

// ── resolution + settlement ─────────────────────────────────────────────────

export type ShadowResolution = {
  winningIndex: number;
  clobTokenIds: string[];
};

/** Did the token the leader BOUGHT win? null if the token isn't in the market. */
export function tokenWon(tokenId: string, res: ShadowResolution): boolean | null {
  const idx = res.clobTokenIds.indexOf(tokenId);
  if (idx < 0) return null;
  return idx === res.winningIndex;
}

/**
 * Settle a copied BUY. Entry at `entryPrice` (the recorded best ask at the
 * chosen offset). If the leader exited early (mirrored SELL) pass `exit`:
 * the copy exits at the recorded best bid of that SELL's sample, the leader
 * at their own SELL fill price. Otherwise hold to resolution (payout 1/0).
 * Returns per-$1 ROI for both copy and leader, or null when unpriceable
 * (missing entry, entry ≥ maxEntry — nothing left to win after the spread).
 */
export function settleCopyTrade(opts: {
  copyEntry: number | null;
  leaderEntry: number;
  won: boolean;
  exit?: { copyExit: number | null; leaderExit: number } | null;
  /** Entries above this are uncopyable (backtest convention 0.985). */
  maxEntry?: number;
}): { copyRoi: number; leaderRoi: number } | null {
  const maxEntry = opts.maxEntry ?? 0.985;
  const { copyEntry, leaderEntry, won, exit } = opts;
  if (copyEntry === null || !Number.isFinite(copyEntry) || copyEntry <= 0 || copyEntry > maxEntry) return null;
  if (!Number.isFinite(leaderEntry) || leaderEntry <= 0) return null;
  if (exit && exit.copyExit !== null && Number.isFinite(exit.copyExit) && exit.copyExit >= 0) {
    return {
      copyRoi: (exit.copyExit - copyEntry) / copyEntry,
      leaderRoi: (exit.leaderExit - leaderEntry) / leaderEntry,
    };
  }
  const payout = won ? 1 : 0;
  return {
    copyRoi: (payout - copyEntry) / copyEntry,
    leaderRoi: (payout - leaderEntry) / leaderEntry,
  };
}

// ── fill → logical-bet collapsing ───────────────────────────────────────────

export type FillForCollapse = {
  id: number;          // shadow_trades row id of the FIRST fill kept per bet
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  usd: number;
  leaderTsMs: number;
};

export type LogicalBet = {
  /** Row id of the first fill — its samples price the copy entry. */
  firstFillId: number;
  tokenId: string;
  side: "BUY" | "SELL";
  /** USD-weighted vwap of the leader's fills. */
  leaderVwap: number;
  /** Total clip size — this is what alwaysfade's ≥$1k filter applies to. */
  usd: number;
  leaderTsMs: number;  // first fill's ts
  fillCount: number;
};

/**
 * Collapse split/slugged fills into logical bets: consecutive fills by the
 * same wallet on the same (tokenId, side) within `windowSec` of the bet's
 * FIRST fill merge into one bet (mirrors collapseSluggedTrades' 1h-window
 * dedup in copy-backtest, simplified to the fields the shadow stores).
 * Input order does not matter; output is sorted by leaderTsMs.
 */
export function collapseFills(fills: FillForCollapse[], windowSec = 3600): LogicalBet[] {
  const sorted = [...fills].sort((a, b) => a.leaderTsMs - b.leaderTsMs);
  const open = new Map<string, LogicalBet & { notional: number }>();
  const out: Array<LogicalBet & { notional: number }> = [];
  for (const f of sorted) {
    const key = `${f.tokenId}|${f.side}`;
    const cur = open.get(key);
    if (cur && f.leaderTsMs - cur.leaderTsMs <= windowSec * 1000) {
      cur.usd += f.usd;
      cur.notional += f.usd * f.price;
      cur.fillCount++;
      cur.leaderVwap = cur.usd > 0 ? cur.notional / cur.usd : cur.leaderVwap;
    } else {
      const bet = {
        firstFillId: f.id,
        tokenId: f.tokenId,
        side: f.side,
        leaderVwap: f.price,
        usd: f.usd,
        leaderTsMs: f.leaderTsMs,
        fillCount: 1,
        notional: f.usd * f.price,
      };
      open.set(key, bet);
      out.push(bet);
    }
  }
  return out
    .sort((a, b) => a.leaderTsMs - b.leaderTsMs)
    .map(({ notional: _n, ...bet }) => bet);
}

// ── small stats ─────────────────────────────────────────────────────────────

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

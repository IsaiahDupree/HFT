/**
 * Short-binary resolver — settles `poly_binaries` rows when their expiry has
 * passed, and force-closes any open paper-agent positions on those tokens at
 * the actual outcome (0.0 = NO won, 1.0 = YES won).
 *
 * Outcome rule: YES wins iff the underlying asset's close price at expiry is
 * strictly greater than the close price at the event's startDate. Equal
 * counts as NO (matches Polymarket's reported rule for these markets — the
 * "up or down" question is strictly directional). We read both prices from
 * the same coinbase_candles series the strategy uses to enter, keeping the
 * sim consistent with itself.
 *
 * Called once per tick from `arena:tick` after the per-agent decide loop.
 * Idempotent — already-settled binaries are skipped.
 */
import { db } from "@/lib/db/client";
import { latestSnapshotFor } from "@/lib/db/queries";
import {
  assetToFeed, getBinaryMeta, listUnsettledExpired,
  markBinarySettled, markBinaryUnresolvable, setReferencePrice,
  type BinaryAsset, type BinaryMeta,
} from "./short-binaries";
import { listAgentsHoldingPosition, persistAgentTick, toLiveAgent, insertPaperTrade } from "./db";
import type { LiveAgent } from "./types";

/** Get the close price of the 1-min candle that contains the given timestamp.
 *  Walks back up to `lookbackMin` candles to find a usable bar if the exact
 *  minute is missing (Coinbase sometimes drops bars during low-volume periods).
 *
 *  Supports both Coinbase (coinbase_candles) and OKX (coindesk_candles
 *  market='okx') feeds via the `exchange` arg. */
function closeAtTime(exchange: "coinbase" | "okx", instrument: string, isoTs: string, lookbackMin = 15): number | null {
  const unix = Math.floor(new Date(isoTs).getTime() / 1000);
  const floor = unix - unix % 60;                  // align to 1-min boundary
  const earliest = floor - lookbackMin * 60;
  const row = exchange === "coinbase"
    ? db().prepare(
        `SELECT close FROM coinbase_candles
          WHERE product_id = ? AND granularity = 'ONE_MINUTE'
            AND start_unix BETWEEN ? AND ?
          ORDER BY start_unix DESC LIMIT 1`,
      ).get(instrument, earliest, floor) as { close: number } | undefined
    : db().prepare(
        `SELECT close FROM coindesk_candles
          WHERE market = 'okx' AND instrument = ? AND granularity = 'ONE_MINUTE'
            AND start_unix BETWEEN ? AND ?
          ORDER BY start_unix DESC LIMIT 1`,
      ).get(instrument, earliest, floor) as { close: number } | undefined;
  return row ? Number(row.close) : null;
}

/** The 5-min / 15-min binaries use a comparison window of exactly
 *  `duration_kind` minutes preceding `expiry_iso`. The Gamma `startDate` field
 *  on these events is when Polymarket *created* the event (often hours or
 *  days earlier), NOT when the price comparison window opens. */
function windowStartIso(meta: BinaryMeta): string {
  const m = meta.duration_kind.match(/^(\d+)\s*M$/i);
  const minutes = m ? Number(m[1]) : 5;
  const startMs = new Date(meta.expiry_iso).getTime() - minutes * 60_000;
  return new Date(startMs).toISOString();
}

export type ResolveOneResult = {
  token_id: string;
  asset: string;
  status: "skipped_no_product" | "skipped_no_candles" | "settled";
  outcome_yes?: 0 | 1;
  start_price?: number;
  end_price?: number;
  positions_closed?: number;
};

/**
 * Resolve a single binary. For 1-second precision we'd need orderbook data;
 * here we use Coinbase 1-min closes, which is what the live tick context
 * also reads.
 */
export function resolveBinary(meta: BinaryMeta, nowIso: string): ResolveOneResult {
  const feed = assetToFeed(meta.asset as BinaryAsset);
  if (!feed) {
    // UNKNOWN asset (parser failure) — we can't resolve. Mark settled (so the
    // resolver stops scanning it each tick) but leave outcome_yes NULL so
    // analytics don't read it as a genuine NO.
    markBinaryUnresolvable(meta.token_id, nowIso);
    return { token_id: meta.token_id, asset: meta.asset, status: "skipped_no_product" };
  }
  const refStartIso = windowStartIso(meta);
  const startPx = closeAtTime(feed.exchange, feed.instrument, refStartIso);
  const endPx = closeAtTime(feed.exchange, feed.instrument, meta.expiry_iso);
  if (startPx == null || endPx == null) {
    return { token_id: meta.token_id, asset: meta.asset, status: "skipped_no_candles" };
  }
  if (meta.reference_price == null) setReferencePrice(meta.token_id, startPx);
  const outcomeYes: 0 | 1 = endPx > startPx ? 1 : 0;
  markBinarySettled(meta.token_id, outcomeYes, nowIso);

  // Walk every agent (alive OR recently retired) that holds a position on
  // this token, and close at the actual outcome. Recently-retired inclusion
  // is critical — a position opened pre-seal, agent retired on seal,
  // binary expires post-seal would otherwise be stranded without a payout.
  // The 7-day retired-at filter trims the scan; older retired agents are
  // assumed to have had their positions already realized by the seal-time
  // force-close path.
  const resolvedPrice = outcomeYes === 1 ? 1.0 : 0.0;
  let positionsClosed = 0;
  const agents = listAgentsHoldingPosition(meta.token_id).map(toLiveAgent);
  for (const agent of agents) {
    const posIdx = agent.positions.findIndex((p) => p.market_id === meta.token_id);
    if (posIdx === -1) continue;
    const pos = agent.positions[posIdx];

    // Live-aware settlement: if the position carries `live_token_id`, settle
    // against the actual filled token (= NO token if a SELL-YES entry was
    // swapped to BUY-NO). Otherwise fall back to the sim's BUY-vs-SELL math
    // on the YES token.
    let realized: number;
    if (pos.live_token_id) {
      // Paid `live_paid_usd` for `live_filled_shares` tokens. Each filled token
      // pays $1 if it wins, $0 otherwise. Win condition:
      //   - live_token_id == meta.token_id (we hold YES) → wins iff outcome_yes=1
      //   - live_token_id == meta.no_token_id           → wins iff outcome_yes=0
      const isYes = pos.live_token_id === meta.token_id;
      const wins = isYes ? outcomeYes === 1 : outcomeYes === 0;
      const payoutPerShare = wins ? 1.0 : 0.0;
      const shares = pos.live_filled_shares
        ?? (pos.live_paid_usd && pos.entry_price > 0 ? pos.live_paid_usd / pos.entry_price : 0);
      const paid = pos.live_paid_usd ?? pos.size_usd;
      realized = shares * payoutPerShare - paid;
      agent.cash_usd_current += paid + realized;   // return notional + pnl
    } else {
      // Sim-only math (no live entry happened). SELL is BUY-NO-equivalent so
      // loss is bounded at stake (see sim.ts applySignal — same formula).
      const shareRet = pos.side === "BUY"
        ? (resolvedPrice - pos.entry_price) / pos.entry_price
        : (pos.entry_price - resolvedPrice) / (1 - pos.entry_price);
      realized = pos.size_usd * shareRet;          // POLY fee = 0 bps
      agent.cash_usd_current += pos.size_usd + realized;
    }
    agent.realized_pnl_usd += realized;
    agent.trades_count += 1;
    if (realized > 0) agent.wins_count += 1;
    agent.positions.splice(posIdx, 1);
    insertPaperTrade({
      paper_agent_id: agent.id, venue: pos.venue, market_id: pos.market_id,
      side: pos.side === "BUY" ? "SELL" : "BUY", intent: "exit",
      price: resolvedPrice, size_usd: pos.size_usd, fee_usd: 0,
      realized_pnl_usd: realized, linked_entry_id: pos.entry_trade_id ?? null,
      signal_rationale: `binary-resolve ${meta.asset} ${outcomeYes === 1 ? "UP" : "DOWN"} (start=${startPx} end=${endPx}${pos.live_token_id ? " live" : ""})`,
      tick_at: nowIso, generation: agent.generation,
    });
    persistAgentTick(agent);
    positionsClosed += 1;
  }

  return {
    token_id: meta.token_id, asset: meta.asset, status: "settled",
    outcome_yes: outcomeYes, start_price: startPx, end_price: endPx,
    positions_closed: positionsClosed,
  };
}

export type ResolverPassResult = {
  candidates: number;
  settled: number;
  positions_closed: number;
  by_status: Record<string, number>;
  details: ResolveOneResult[];
};

/** Iterate every unsettled binary whose expiry has already passed and resolve
 *  it. Caller (arena-tick) decides when this runs. */
export function resolveExpiredBinaries(nowIso = new Date().toISOString()): ResolverPassResult {
  const pending = listUnsettledExpired(nowIso);
  const details: ResolveOneResult[] = [];
  const byStatus: Record<string, number> = {};
  let settled = 0;
  let positionsClosed = 0;
  for (const meta of pending) {
    const result = resolveBinary(meta, nowIso);
    details.push(result);
    byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
    if (result.status === "settled") settled += 1;
    positionsClosed += result.positions_closed ?? 0;
  }
  return { candidates: pending.length, settled, positions_closed: positionsClosed, by_status: byStatus, details };
}

/** Test/operator helper — useful for triaging from the REPL. */
export function reloadBinaryMeta(tokenId: string) {
  return getBinaryMeta(tokenId);
}

// Suppress unused-import lint when the snapshot helper is wanted elsewhere.
void latestSnapshotFor;

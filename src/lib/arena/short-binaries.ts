/**
 * Short-duration Polymarket binaries — 5-min / 15-min crypto Up-or-Down events.
 *
 * Polymarket runs rolling "Bitcoin Up or Down — May 25, 10:50PM–10:55PM ET"
 * style markets that expire every 5 (or 15) minutes. They settle YES if the
 * asset's price at the event end is above its price at the event start. The
 * order book closes ~2 min before settlement (the "cutoff").
 *
 * This module owns the snapshot universe for those markets:
 *   - fetchShortBinaries(): hits Gamma with tag_slug=5M/15M and end_date_min=now
 *   - persists per-token metadata to `poly_binaries`
 *   - records the YES token's midpoint to `market_snapshots` so the sim can
 *     pick it up in the same way it does any other Polymarket market
 *
 * Strategies operate on these by looking up the metadata to find the matching
 * Coinbase product (for velocity signal) and the expiry timestamp (for time
 * stop). The resolver in `binary-resolver.ts` force-closes positions when
 * expiry passes.
 */
import { poly } from "@/lib/polymarket/client";
import { db } from "@/lib/db/client";
import { recordMarketSnapshot } from "@/lib/db/queries";
import { classifyMarket } from "@/lib/polymarket/category";

/** Assets we know how to interpret. Mapping to Coinbase product when available. */
export type BinaryAsset = "BTC" | "ETH" | "SOL" | "XRP" | "DOGE" | "BNB" | "HYPE" | "UNKNOWN";

const ASSET_TO_CB_PRODUCT: Partial<Record<BinaryAsset, string>> = {
  BTC: "BTC-USD",
  ETH: "ETH-USD",
  SOL: "SOL-USD",
  XRP: "XRP-USD",
  DOGE: "DOGE-USD",
  // BNB, HYPE are not on Coinbase — they get an OKX-USDT feed instead
  // (see assetToFeed below). assetToCbProduct returns null for them.
};

export function assetToCbProduct(asset: BinaryAsset): string | null {
  return ASSET_TO_CB_PRODUCT[asset] ?? null;
}

/**
 * Generic "where do I get candles for this asset" mapping. Returns the
 * exchange (= coindesk_candles.market) and instrument id used by the candle
 * persistence layer. Used by both the strategy decide() (to load velocity)
 * and the resolver (to read endpoint prices).
 *
 *   BTC/ETH/SOL/XRP/DOGE → coinbase ($-USD pairs from coinbase_candles)
 *   BNB/HYPE             → okx ($-USDT pairs from coindesk_candles market='okx')
 */
export type CandleFeed = { exchange: "coinbase" | "okx"; instrument: string };
const ASSET_TO_FEED: Partial<Record<BinaryAsset, CandleFeed>> = {
  BTC:  { exchange: "coinbase", instrument: "BTC-USD" },
  ETH:  { exchange: "coinbase", instrument: "ETH-USD" },
  SOL:  { exchange: "coinbase", instrument: "SOL-USD" },
  XRP:  { exchange: "coinbase", instrument: "XRP-USD" },
  DOGE: { exchange: "coinbase", instrument: "DOGE-USD" },
  BNB:  { exchange: "okx",      instrument: "BNB-USDT" },
  HYPE: { exchange: "okx",      instrument: "HYPE-USDT" },
};

export function assetToFeed(asset: BinaryAsset): CandleFeed | null {
  return ASSET_TO_FEED[asset] ?? null;
}

/** Extract the underlying asset from an event title like "Bitcoin Up or Down". */
export function parseAssetFromTitle(title: string): BinaryAsset {
  const t = title.toLowerCase();
  if (t.includes("bitcoin")) return "BTC";
  if (t.includes("ethereum")) return "ETH";
  if (t.includes("solana")) return "SOL";
  if (/(^|\s)xrp(\s|$)/.test(t)) return "XRP";
  if (t.includes("dogecoin") || /(^|\s)doge(\s|$)/.test(t)) return "DOGE";
  if (t.includes("bnb") || t.includes("binance coin")) return "BNB";
  if (t.includes("hyperliquid") || /(^|\s)hype(\s|$)/.test(t)) return "HYPE";
  return "UNKNOWN";
}

export type BinaryMeta = {
  token_id: string;
  condition_id: string;
  no_token_id: string | null;
  question: string;
  asset: BinaryAsset;
  duration_kind: string;
  start_iso: string | null;
  expiry_iso: string;
  reference_price: number | null;
  settled: 0 | 1;
  outcome_yes: 0 | 1 | null;
  resolved_at: string | null;
  event_slug: string | null;
};

export function upsertBinary(meta: {
  token_id: string;
  condition_id: string;
  no_token_id?: string | null;
  question: string;
  asset: BinaryAsset;
  duration_kind: string;
  start_iso?: string | null;
  expiry_iso: string;
  event_slug?: string | null;
}): void {
  db().prepare(
    `INSERT INTO poly_binaries
       (token_id, condition_id, no_token_id, question, asset, duration_kind, start_iso, expiry_iso, event_slug)
     VALUES (@token_id, @condition_id, @no_token_id, @question, @asset, @duration_kind, @start_iso, @expiry_iso, @event_slug)
     ON CONFLICT(token_id) DO UPDATE SET
       no_token_id = COALESCE(excluded.no_token_id, no_token_id),
       question = excluded.question,
       expiry_iso = excluded.expiry_iso,
       event_slug = COALESCE(excluded.event_slug, event_slug),
       updated_at = datetime('now')`,
  ).run({
    token_id: meta.token_id,
    condition_id: meta.condition_id,
    no_token_id: meta.no_token_id ?? null,
    question: meta.question,
    asset: meta.asset,
    duration_kind: meta.duration_kind,
    start_iso: meta.start_iso ?? null,
    expiry_iso: meta.expiry_iso,
    event_slug: meta.event_slug ?? null,
  });
}

export function getBinaryMeta(tokenId: string): BinaryMeta | null {
  const row = db().prepare(`SELECT * FROM poly_binaries WHERE token_id = ?`).get(tokenId) as BinaryMeta | undefined;
  return row ?? null;
}

export function listBinariesByExpiryRange(opts: { fromIso?: string; toIso?: string; settled?: 0 | 1 } = {}): BinaryMeta[] {
  const clauses: string[] = [];
  const params: Record<string, string | number> = {};
  if (opts.fromIso) { clauses.push("expiry_iso >= @fromIso"); params.fromIso = opts.fromIso; }
  if (opts.toIso)   { clauses.push("expiry_iso <= @toIso");   params.toIso   = opts.toIso; }
  if (opts.settled !== undefined) { clauses.push("settled = @settled"); params.settled = opts.settled; }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db().prepare(`SELECT * FROM poly_binaries ${where} ORDER BY expiry_iso ASC`).all(params) as BinaryMeta[];
}

export function listUnsettledExpired(nowIso: string): BinaryMeta[] {
  return db().prepare(
    `SELECT * FROM poly_binaries WHERE settled = 0 AND expiry_iso <= ? ORDER BY expiry_iso ASC`,
  ).all(nowIso) as BinaryMeta[];
}

export function setReferencePrice(tokenId: string, price: number): void {
  db().prepare(`UPDATE poly_binaries SET reference_price = ?, updated_at = datetime('now') WHERE token_id = ?`)
    .run(price, tokenId);
}

export function markBinarySettled(tokenId: string, outcomeYes: 0 | 1, resolvedAtIso: string): void {
  db().prepare(
    `UPDATE poly_binaries
        SET settled = 1, outcome_yes = ?, resolved_at = ?, updated_at = datetime('now')
      WHERE token_id = ?`,
  ).run(outcomeYes, resolvedAtIso, tokenId);
}

/** Mark a binary as "done with no opinion on outcome" — used for assets we
 *  can't resolve off Coinbase (BNB, HYPE, UNKNOWN). The row is set settled=1
 *  so the resolver stops scanning it, but outcome_yes stays NULL so analytics
 *  don't mistake it for a real NO. */
export function markBinaryUnresolvable(tokenId: string, resolvedAtIso: string): void {
  db().prepare(
    `UPDATE poly_binaries
        SET settled = 1, outcome_yes = NULL, resolved_at = ?, updated_at = datetime('now')
      WHERE token_id = ?`,
  ).run(resolvedAtIso, tokenId);
}

/** Parse the clobTokenIds JSON Gamma returns ("[\"<yes>\", \"<no>\"]"). */
function parseClobTokens(raw: unknown): { yes: string; no: string | null } | null {
  if (typeof raw !== "string") return null;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const yes = typeof arr[0] === "string" ? arr[0] : null;
    const no = typeof arr[1] === "string" ? arr[1] : null;
    if (!yes) return null;
    return { yes, no };
  } catch { return null; }
}

export type FetchShortBinariesResult = {
  events_seen: number;
  markets_recorded: number;
  by_asset: Record<string, number>;
  errors: string[];
};

/**
 * Pull live 5-min / 15-min Up-or-Down events from Gamma, persist metadata to
 * `poly_binaries`, and record the YES token's midpoint to `market_snapshots`
 * (category='5min-binary' or '15min-binary'). Idempotent — re-running mid-tick
 * just updates the same rows.
 *
 * `assetFilter` lets the caller restrict the universe (e.g. ["BTC","ETH"]).
 * Unknown assets are still snapshotted but tagged asset='UNKNOWN' so strategies
 * can ignore them.
 */
export async function fetchShortBinaries(opts: {
  limit?: number;
  tags?: string[];
  assetFilter?: BinaryAsset[];
} = {}): Promise<FetchShortBinariesResult> {
  const limit = opts.limit ?? 40;
  const tags = opts.tags ?? ["5M"];           // 15M also supported by Gamma
  const assetFilter = opts.assetFilter;       // undefined = all
  const nowIso = new Date().toISOString();
  const errors: string[] = [];
  const byAsset: Record<string, number> = {};
  let eventsSeen = 0;
  let marketsRecorded = 0;

  for (const tag of tags) {
    let events: any[] = [];
    try {
      events = await poly.events({
        limit,
        closed: false,
        tag_slug: tag,
        end_date_min: nowIso,
        order: "endDate",
        ascending: true,
      });
    } catch (err) {
      errors.push(`gamma events[tag=${tag}]: ${(err as Error).message}`);
      continue;
    }
    eventsSeen += events.length;

    for (const ev of events) {
      const title: string = ev.title ?? "";
      const asset = parseAssetFromTitle(title);
      if (assetFilter && !assetFilter.includes(asset)) continue;
      const endDate: string | undefined = ev.endDate;
      if (!endDate) continue;
      const startDate: string | undefined = ev.startDate;

      for (const m of (ev.markets ?? []) as any[]) {
        if (!m.conditionId) continue;
        const tokens = parseClobTokens(m.clobTokenIds);
        if (!tokens) continue;
        const tokenId = tokens.yes;
        const question = m.question ?? title;

        // Get midpoint + spread from CLOB. If the order book is closed (we're
        // past the 2-min cutoff), CLOB may 404 — skip silently.
        let midVal: number | null = null;
        let spreadVal: number | null = null;
        try {
          const mid = await poly.midpoint(tokenId);
          midVal = mid ? Number((mid as { mid: string }).mid) : null;
        } catch { /* book may be closed */ }
        try {
          const sp = await poly.spread(tokenId);
          spreadVal = sp ? Number((sp as { spread: string }).spread) : null;
        } catch { /* ignore */ }

        // Persist metadata first so the resolver can find this token even if
        // the CLOB call failed.
        upsertBinary({
          token_id: tokenId,
          condition_id: m.conditionId,
          no_token_id: tokens.no,
          question,
          asset,
          duration_kind: tag,
          start_iso: startDate ?? null,
          expiry_iso: endDate,
          event_slug: typeof ev.slug === "string" ? ev.slug : null,
        });

        if (midVal === null) continue;

        // Tag category so the strategy can filter on it.
        const category = tag === "5M" ? "5min-binary" : tag === "15M" ? "15min-binary" : `${tag}-binary`;
        recordMarketSnapshot({
          condition_id: m.conditionId,
          token_id: tokenId,
          question,
          yes_price: midVal,
          no_price: midVal != null ? 1 - midVal : null,
          midpoint: midVal,
          spread: spreadVal,
          volume_24h: m.volume24hr ?? m.volume_24hr ?? null,
          open_interest: m.openInterest ?? null,
          liquidity_usd: m.liquidity ?? null,
          category,
        });
        marketsRecorded += 1;
        byAsset[asset] = (byAsset[asset] ?? 0) + 1;
      }
    }
  }
  // classifyMarket import kept for potential downstream use (kept silent).
  void classifyMarket;
  return { events_seen: eventsSeen, markets_recorded: marketsRecorded, by_asset: byAsset, errors };
}

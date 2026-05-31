/**
 * Snapshot pass — importable version of scripts/snapshot-worker.ts so the
 * Next.js API can trigger live data refreshes on demand (button click) and
 * not just on cron.
 */
import { poly } from "@/lib/polymarket/client";
import { cb } from "@/lib/coinbase/client";
import { okx } from "@/lib/okx/client";
import { recordMarketSnapshot } from "@/lib/db/queries";
import { classifyMarket } from "@/lib/polymarket/category";
import { db } from "@/lib/db/client";
import { fetchShortBinaries, type BinaryAsset } from "./short-binaries";

// Env defaults read at CALL time (not module load) so tests can swap them
// per-case without vi.resetModules().
function defaultPolyLimit(): number {
  return Number(process.env.ARENA_SNAPSHOT_POLY_LIMIT ?? "20");
}
function defaultCbProducts(): string[] {
  return (process.env.ARENA_SNAPSHOT_CB_PRODUCTS ?? "BTC-USD,ETH-USD,SOL-USD,XRP-USD,DOGE-USD")
    .split(",").map((s) => s.trim()).filter(Boolean);
}
/** When set (e.g. "Crypto"), Polymarket snapshots filter to events tagged
 *  with one of these slugs (CSV). Empty/unset = full sampling-markets universe. */
function defaultPolyTags(): string[] {
  return (process.env.ARENA_POLY_TAGS ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function recordCoinbaseSnapshot(s: {
  product_id: string; best_bid?: number; best_ask?: number; midpoint?: number;
  spread?: number; volume_24h?: number; price_24h_change_pct?: number;
}) {
  return db().prepare(
    `INSERT INTO coinbase_snapshots
       (product_id, best_bid, best_ask, midpoint, spread, volume_24h, price_24h_change_pct)
     VALUES (@product_id, @best_bid, @best_ask, @midpoint, @spread, @volume_24h, @price_24h_change_pct)`,
  ).run({
    product_id: s.product_id,
    best_bid: s.best_bid ?? null,
    best_ask: s.best_ask ?? null,
    midpoint: s.midpoint ?? null,
    spread: s.spread ?? null,
    volume_24h: s.volume_24h ?? null,
    price_24h_change_pct: s.price_24h_change_pct ?? null,
  });
}

/**
 * Short-binary universe controls. ARENA_SHORT_BINARIES=0 disables the fetch.
 * ARENA_SHORT_BINARY_TAGS=5M,15M (CSV) picks which Polymarket tag(s) to pull.
 * ARENA_SHORT_BINARY_ASSETS=BTC,ETH,SOL,XRP,DOGE filters to specific assets
 * (empty/unset = no filter).
 */
function shortBinariesEnabled(): boolean {
  return (process.env.ARENA_SHORT_BINARIES ?? "1") !== "0";
}
function shortBinaryTags(): string[] {
  return (process.env.ARENA_SHORT_BINARY_TAGS ?? "5M,15M")
    .split(",").map((s) => s.trim()).filter(Boolean);
}
function shortBinaryAssetFilter(): BinaryAsset[] | undefined {
  const raw = (process.env.ARENA_SHORT_BINARY_ASSETS ?? "").trim();
  if (!raw) return undefined;
  return raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) as BinaryAsset[];
}

export type SnapshotPassResult = {
  poly_count: number;
  coinbase_count: number;
  candle_count: number;
  warehouse_mirrored: number;   // ONE_MINUTE candles best-effort upserted into the TimescaleDB warehouse
  short_binaries_count: number;
  short_binaries_by_asset: Record<string, number>;
  latency_ms: number;
  errors: string[];
};

type RawCandle = { start: string; low: string; high: string; open: string; close: string; volume: string };

/** Best-effort mirror of ONE_MINUTE candles into the TimescaleDB warehouse so it
 *  stays the canonical store, while SQLite remains the loop's resilient local
 *  cache. Dynamic import + try/catch so a missing `pg` dep or a down warehouse
 *  (Docker off) degrades gracefully and never breaks the live snapshot pass.
 *  Toggle with ARENA_WAREHOUSE_MIRROR=0. Opens and closes its own pool so the
 *  short-lived worker process can still exit cleanly. */
async function mirrorCandlesToWarehouse(batches: Array<{ product: string; rows: RawCandle[] }>): Promise<{ mirrored: number; error?: string }> {
  if ((process.env.ARENA_WAREHOUSE_MIRROR ?? "1") !== "1" || batches.length === 0) return { mirrored: 0 };
  let store: typeof import("../db/candle-store") | undefined;
  try {
    store = await import("../db/candle-store");
    let mirrored = 0;
    for (const b of batches) {
      const rows = b.rows
        .map((c) => ({ start_unix: Number(c.start), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume ?? 0) }))
        .filter((r) => Number.isFinite(r.start_unix) && Number.isFinite(r.open));
      mirrored += await store.upsertCandles(b.product, "ONE_MINUTE", rows);
    }
    return { mirrored };
  } catch (err) {
    return { mirrored: 0, error: (err as Error).message };
  } finally {
    try { await store?.closeTsdb(); } catch { /* ignore */ }
  }
}

/** Insert OKX 1-min candles into coindesk_candles with market='okx'. The
 *  table's UNIQUE(market, instrument, granularity, start_unix) constraint
 *  makes this idempotent — running every tick just merges new bars. */
function recordOkxCandles(instId: string, rows: Array<{ ts_unix: number; open: number; high: number; low: number; close: number; volume: number }>): number {
  if (!rows || rows.length === 0) return 0;
  const stmt = db().prepare(
    `INSERT OR IGNORE INTO coindesk_candles
       (market, instrument, granularity, start_unix, open, high, low, close, volume, quote_volume, total_trades)
     VALUES ('okx', ?, 'ONE_MINUTE', ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  );
  const insert = db().transaction((arr: typeof rows) => {
    let n = 0;
    for (const r of arr) {
      if (!Number.isFinite(r.ts_unix) || !Number.isFinite(r.close)) continue;
      const res = stmt.run(instId, r.ts_unix, r.open, r.high, r.low, r.close, r.volume ?? 0);
      if ((res.changes ?? 0) > 0) n += 1;
    }
    return n;
  });
  return insert(rows);
}

/** Insert candles, ignoring rows that already exist for (product, gran, start). */
function recordCoinbaseCandles(productId: string, candles: Array<{ start: string; low: string; high: string; open: string; close: string; volume: string }>): number {
  if (!candles || candles.length === 0) return 0;
  const stmt = db().prepare(
    `INSERT OR IGNORE INTO coinbase_candles
       (product_id, granularity, start_unix, open, high, low, close, volume)
     VALUES (?, 'ONE_MINUTE', ?, ?, ?, ?, ?, ?)`,
  );
  const insert = db().transaction((rows: typeof candles) => {
    let n = 0;
    for (const c of rows) {
      const startUnix = Number(c.start);
      const open = Number(c.open), high = Number(c.high), low = Number(c.low), close = Number(c.close);
      if (!Number.isFinite(startUnix) || !Number.isFinite(open)) continue;
      const res = stmt.run(productId, startUnix, open, high, low, close, Number(c.volume ?? 0));
      if ((res.changes ?? 0) > 0) n += 1;
    }
    return n;
  });
  return insert(candles);
}

export async function runSnapshotPass(opts: { polyLimit?: number; cbProducts?: string[]; candleWindowMin?: number; polyTags?: string[] } = {}): Promise<SnapshotPassResult> {
  const t0 = Date.now();
  const polyLimit = opts.polyLimit ?? defaultPolyLimit();
  const products = opts.cbProducts ?? defaultCbProducts();
  const candleWindowMin = opts.candleWindowMin ?? 60;
  const polyTags = opts.polyTags ?? defaultPolyTags();
  const errors: string[] = [];
  let polyCount = 0;
  let cbCount = 0;
  let candleCount = 0;

  try {
    // Two modes:
    //   (a) sampling-markets when no tag filter (legacy default)
    //   (b) Gamma /events?tag_slug=<tag> when ARENA_POLY_TAGS is set
    //       (e.g. "crypto" → only crypto-tagged events become snapshots)
    let candidates: Array<{ condition_id: string; tokens?: any[]; question?: string; volume_24hr?: number; open_interest?: number; liquidity?: number }> = [];
    if (polyTags.length > 0) {
      for (const tag of polyTags) {
        try {
          const events = await poly.events({ limit: polyLimit, closed: false, tag_slug: tag });
          for (const ev of events ?? []) {
            for (const m of (ev as any).markets ?? []) {
              if (!m?.conditionId) continue;
              let tokens: any[] = [];
              try {
                const tids: string[] = JSON.parse(m.clobTokenIds ?? "[]");
                tokens = tids.map((t, i) => ({ token_id: t, outcome: i === 0 ? "Yes" : "No" }));
              } catch {}
              candidates.push({
                condition_id: m.conditionId,
                tokens,
                question: m.question ?? ev.title,
                volume_24hr: m.volume24hr ?? m.volume_24hr,
                open_interest: m.openInterest,
                liquidity: m.liquidity,
              });
            }
          }
        } catch (err) {
          errors.push(`polymarket events[tag=${tag}]: ${(err as Error).message}`);
        }
      }
      const seen = new Set<string>();
      candidates = candidates.filter((c) => (seen.has(c.condition_id) ? false : (seen.add(c.condition_id), true))).slice(0, polyLimit);
    } else {
      const sampling = await poly.samplingMarkets(polyLimit);
      candidates = sampling.data;
    }
    for (const m of candidates) {
      const yes = (m as any).tokens?.find((t: any) => t.outcome === "Yes");
      const no = (m as any).tokens?.find((t: any) => t.outcome === "No");
      const tokenId = yes?.token_id ?? (m as any).tokens?.[0]?.token_id;
      if (!tokenId || !(m as any).condition_id) continue;
      const [mid, spread] = await Promise.all([
        poly.midpoint(tokenId).catch(() => null),
        poly.spread(tokenId).catch(() => null),
      ]);
      const midVal = mid ? Number((mid as { mid: string }).mid) : null;
      const spreadVal = spread ? Number((spread as { spread: string }).spread) : null;
      const question = (m as any).question ?? "(no question)";
      const slug = (m as any).market_slug ?? (m as any).slug ?? undefined;
      recordMarketSnapshot({
        condition_id: (m as any).condition_id,
        token_id: tokenId,
        question,
        yes_price: Number(yes?.price ?? midVal ?? 0) || null,
        no_price: Number(no?.price ?? (midVal != null ? 1 - midVal : 0)) || null,
        midpoint: midVal,
        spread: spreadVal,
        volume_24h: (m as any).volume_24hr ?? null,
        open_interest: (m as any).open_interest ?? null,
        liquidity_usd: (m as any).liquidity ?? null,
        category: classifyMarket(question, slug),
      });
      polyCount += 1;
    }
  } catch (err) {
    errors.push(`polymarket: ${(err as Error).message}`);
  }

  try {
    let book: any = null;
    try { book = await cb.getBestBidAsk({ product_ids: products }); } catch {}
    if (book?.pricebooks) {
      for (const pb of book.pricebooks) {
        const bid = Number(pb.bids?.[0]?.price ?? 0) || null;
        const ask = Number(pb.asks?.[0]?.price ?? 0) || null;
        const mid = bid && ask ? (bid + ask) / 2 : null;
        const spr = bid && ask ? ask - bid : null;
        recordCoinbaseSnapshot({
          product_id: pb.product_id, best_bid: bid ?? undefined, best_ask: ask ?? undefined,
          midpoint: mid ?? undefined, spread: spr ?? undefined,
        });
        cbCount += 1;
      }
    } else {
      for (const pid of products) {
        try {
          const prod = await cb.publicGetProduct(pid);
          const price = Number((prod as { price?: string })?.price ?? 0);
          if (!Number.isFinite(price) || price <= 0) continue;
          recordCoinbaseSnapshot({
            product_id: pid, midpoint: price,
            best_bid: price * 0.9995, best_ask: price * 1.0005, spread: price * 0.001,
          });
          cbCount += 1;
        } catch (err) {
          errors.push(`coinbase[${pid}]: ${(err as Error).message}`);
        }
      }
    }
  } catch (err) {
    errors.push(`coinbase: ${(err as Error).message}`);
  }

  // 1-minute candles for momentum derivatives. Public endpoint (no auth);
  // up to ~300 candles per call. We ask for last `candleWindowMin` minutes
  // per configured product. ON CONFLICT IGNORE makes this fully idempotent.
  const nowSec = Math.floor(Date.now() / 1000);
  const candleBatches: Array<{ product: string; rows: RawCandle[] }> = [];
  for (const pid of products) {
    try {
      const candles = await cb.publicGetProductCandles(pid, {
        start: String(nowSec - candleWindowMin * 60),
        end: String(nowSec),
        granularity: "ONE_MINUTE",
      });
      const rows = ((candles as { candles: RawCandle[] })?.candles ?? []);
      candleCount += recordCoinbaseCandles(pid, rows);
      if (rows.length) candleBatches.push({ product: pid, rows });
    } catch (err) {
      errors.push(`coinbase candles[${pid}]: ${(err as Error).message}`);
    }
  }
  // Best-effort: mirror the ONE_MINUTE candles into the canonical warehouse.
  const mirror = await mirrorCandlesToWarehouse(candleBatches);
  if (mirror.error) errors.push(`warehouse-mirror: ${mirror.error}`);

  // OKX 1-min candles for BNB-USDT and HYPE-USDT — Coinbase doesn't list
  // these, and Binance is geoblocked from US IPs, so OKX is our feed. We
  // write into `coindesk_candles` with market='okx' and union via
  // loadRecentCandles when a strategy requests candles for those assets.
  const okxFeeds = (process.env.ARENA_OKX_PRODUCTS ?? "BNB-USDT,HYPE-USDT")
    .split(",").map((s) => s.trim()).filter(Boolean);
  for (const instId of okxFeeds) {
    try {
      const candles = await okx.publicGetCandles(instId, { bar: "1m", limit: candleWindowMin + 5 });
      const n = recordOkxCandles(instId, candles);
      candleCount += n;
    } catch (err) {
      errors.push(`okx candles[${instId}]: ${(err as Error).message}`);
    }
  }

  // Short-duration BTC/ETH/SOL/XRP/DOGE Up-or-Down binaries. These are the
  // 5-min and 15-min hourly markets the sampling-markets endpoint never
  // surfaces. Persists both the snapshot row (so the sim sees them in
  // ctx.snapshots) and the per-token metadata (expiry, asset) the resolver
  // needs to settle positions when the binary closes.
  let shortBinariesCount = 0;
  let shortBinariesByAsset: Record<string, number> = {};
  if (shortBinariesEnabled()) {
    try {
      const sb = await fetchShortBinaries({
        limit: 40,
        tags: shortBinaryTags(),
        assetFilter: shortBinaryAssetFilter(),
      });
      shortBinariesCount = sb.markets_recorded;
      shortBinariesByAsset = sb.by_asset;
      for (const e of sb.errors) errors.push(`short-binaries: ${e}`);
    } catch (err) {
      errors.push(`short-binaries: ${(err as Error).message}`);
    }
  }

  return {
    poly_count: polyCount,
    coinbase_count: cbCount,
    candle_count: candleCount,
    warehouse_mirrored: mirror.mirrored,
    short_binaries_count: shortBinariesCount,
    short_binaries_by_asset: shortBinariesByAsset,
    latency_ms: Date.now() - t0,
    errors,
  };
}

/**
 * Per-market freshness — newest snapshot timestamp + age in seconds. Used by
 * the safety dashboard to flag stale data before live trades fire.
 */
export type MarketFreshness = {
  venue: "polymarket" | "coinbase";
  market_id: string;
  last_seen: string;
  age_seconds: number;
  is_stale: boolean;
};

/**
 * SQLite `datetime('now')` returns UTC text in "YYYY-MM-DD HH:MM:SS" form
 * (no timezone marker). JS Date parses unzoned strings as LOCAL time, which
 * shifts the result by the host's UTC offset. Force UTC parsing here.
 */
function parseSqliteUtcTs(s: string): number {
  const normalized = /Z|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(" ", "T") + "Z";
  return new Date(normalized).getTime();
}

export function getMarketFreshness(opts: { staleSeconds?: number } = {}): MarketFreshness[] {
  const stale = opts.staleSeconds ?? 600; // 10 min
  const now = Date.now();
  const out: MarketFreshness[] = [];
  const polyRows = db().prepare(
    `SELECT token_id AS market_id, MAX(captured_at) AS last_seen
       FROM market_snapshots WHERE captured_at >= datetime('now', '-1 day') GROUP BY token_id`,
  ).all() as Array<{ market_id: string; last_seen: string }>;
  for (const r of polyRows) {
    const ageMs = now - parseSqliteUtcTs(r.last_seen);
    const age = Math.max(0, ageMs / 1000);
    out.push({ venue: "polymarket", market_id: r.market_id, last_seen: r.last_seen, age_seconds: age, is_stale: age > stale });
  }
  const cbRows = db().prepare(
    `SELECT product_id AS market_id, MAX(captured_at) AS last_seen
       FROM coinbase_snapshots WHERE captured_at >= datetime('now', '-1 day') GROUP BY product_id`,
  ).all() as Array<{ market_id: string; last_seen: string }>;
  for (const r of cbRows) {
    const ageMs = now - parseSqliteUtcTs(r.last_seen);
    const age = Math.max(0, ageMs / 1000);
    out.push({ venue: "coinbase", market_id: r.market_id, last_seen: r.last_seen, age_seconds: age, is_stale: age > stale });
  }
  out.sort((a, b) => a.age_seconds - b.age_seconds);
  return out;
}

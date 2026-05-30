/**
 * Sub-minute crypto price persistence — bridges `worker:realtime` WS feed
 * into a DB table the arena context can read for freshness.
 *
 * Per-symbol 1-second debounce: drop intermediate ticks, keep the latest.
 * Daily cleanup keeps last 24h; older rows pruned in a background sweep
 * triggered by the worker's heartbeat.
 *
 * Spec: `docs/prds/arena-agent-decision-framework.md` §6.3.L3 + Phase 7.
 */
import { db } from "@/lib/db/client";

/** Map symbol (Polymarket WS convention) → Coinbase product_id. Used to align
 *  WS ticks with `coinbase_snapshots.product_id` so the arena context can
 *  override the right SnapshotWindow.latest.price. */
const SYMBOL_TO_PRODUCT: Record<string, string> = {
  btcusdt: "BTC-USD",
  ethusdt: "ETH-USD",
  solusdt: "SOL-USD",
  dogeusdt: "DOGE-USD",
  xrpusdt: "XRP-USD",
};

// Per-symbol last-write timestamp (ms) for debouncing — keep in module scope
// so we share state across worker callbacks within the same process.
const LAST_WRITE: Map<string, number> = new Map();
const DEBOUNCE_MS = 1000;

/**
 * Persist a tick if the previous tick for this symbol is older than
 * `DEBOUNCE_MS`. Returns true when written, false when debounced.
 */
export function persistRealtimeTick(symbol: string, price: number, source = "poly-ws"): boolean {
  const productId = SYMBOL_TO_PRODUCT[symbol.toLowerCase()];
  if (!productId) return false;
  if (!Number.isFinite(price) || price <= 0) return false;
  const now = Date.now();
  const last = LAST_WRITE.get(symbol) ?? 0;
  if (now - last < DEBOUNCE_MS) return false;
  LAST_WRITE.set(symbol, now);
  db().prepare(
    `INSERT INTO realtime_ticks (symbol, product_id, price, source, ts_unix)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(symbol.toLowerCase(), productId, price, source, Math.floor(now / 1000));
  return true;
}

/** Delete ticks older than `keepHours` (default 24). Returns rows deleted. */
export function pruneOldTicks(keepHours = 24): number {
  const cutoffUnix = Math.floor(Date.now() / 1000) - keepHours * 3600;
  const res = db().prepare(`DELETE FROM realtime_ticks WHERE ts_unix < ?`).run(cutoffUnix);
  return res.changes;
}

/** Most recent tick per product within `maxAgeSec` seconds. Returns a map
 *  product_id → {price, ageSec, ts_unix}. Used by buildLiveTickContext to
 *  override stale REST snapshot prices with fresh WS data. */
export type FreshTick = { product_id: string; price: number; ageSec: number; ts_unix: number };
export function latestRealtimeTicks(maxAgeSec = 90): Map<string, FreshTick> {
  const cutoffUnix = Math.floor(Date.now() / 1000) - maxAgeSec;
  const rows = db().prepare(
    `SELECT product_id, price, MAX(ts_unix) AS ts_unix
       FROM realtime_ticks
      WHERE ts_unix >= ?
      GROUP BY product_id`,
  ).all(cutoffUnix) as Array<{ product_id: string; price: number; ts_unix: number }>;
  const out = new Map<string, FreshTick>();
  const nowSec = Math.floor(Date.now() / 1000);
  for (const r of rows) {
    out.set(r.product_id, { product_id: r.product_id, price: r.price, ts_unix: r.ts_unix, ageSec: nowSec - r.ts_unix });
  }
  return out;
}

/** WS health for the UI pill: per-product latest age. Returns rows even if
 *  the tick is stale, so the operator can see WS-dead state. */
export type WsHealth = { product_id: string; ageSec: number; latest_price: number; fresh: boolean };
export function wsHealth(freshnessSec = 60): WsHealth[] {
  const rows = db().prepare(
    `SELECT product_id, price, ts_unix
       FROM realtime_ticks
      WHERE id IN (
        SELECT MAX(id) FROM realtime_ticks GROUP BY product_id
      )`,
  ).all() as Array<{ product_id: string; price: number; ts_unix: number }>;
  const nowSec = Math.floor(Date.now() / 1000);
  return rows.map((r) => {
    const age = nowSec - r.ts_unix;
    return { product_id: r.product_id, ageSec: age, latest_price: r.price, fresh: age <= freshnessSec };
  });
}

/** Test-only — clear the debounce cache. */
export function _resetDebounce(): void { LAST_WRITE.clear(); }

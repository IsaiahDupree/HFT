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

// Buffer of ticks awaiting a best-effort warehouse mirror. Bounded so a
// perpetually-down warehouse can't grow it without limit (drops oldest).
type BufferedTick = { symbol: string; product_id: string; price: number; source: string; ts_unix: number };
const TICK_BUFFER: BufferedTick[] = [];
const TICK_BUFFER_MAX = 5000;

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
  const tsUnix = Math.floor(now / 1000);
  db().prepare(
    `INSERT INTO realtime_ticks (symbol, product_id, price, source, ts_unix)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(symbol.toLowerCase(), productId, price, source, tsUnix);
  // queue for the warehouse mirror (the loop's SQLite write above is canonical-local).
  if (TICK_BUFFER.length >= TICK_BUFFER_MAX) TICK_BUFFER.shift();
  TICK_BUFFER.push({ symbol: symbol.toLowerCase(), product_id: productId, price, source, ts_unix: tsUnix });
  return true;
}

/** Best-effort flush of buffered ticks into the canonical TimescaleDB warehouse.
 *  Called periodically by the long-running realtime worker (does NOT close the
 *  shared pool — the worker closes it on shutdown). Toggle ARENA_WAREHOUSE_MIRROR=0.
 *  On any failure the buffered ticks are re-queued for the next flush. */
export async function flushTicksToWarehouse(): Promise<{ mirrored: number; error?: string }> {
  if ((process.env.ARENA_WAREHOUSE_MIRROR ?? "1") !== "1" || TICK_BUFFER.length === 0) return { mirrored: 0 };
  const batch = TICK_BUFFER.splice(0, TICK_BUFFER.length); // take all, clear buffer
  try {
    const { insertTicks } = await import("@/lib/db/candle-store");
    const mirrored = await insertTicks(batch);
    return { mirrored };
  } catch (err) {
    // Re-queue the failed batch at the front; if any new ticks arrived during the
    // flush and we're over cap, drop the OLDEST (consistent with persistRealtimeTick's
    // shift policy) so a transient warehouse outage keeps the most recent ticks.
    TICK_BUFFER.unshift(...batch);
    if (TICK_BUFFER.length > TICK_BUFFER_MAX) TICK_BUFFER.splice(0, TICK_BUFFER.length - TICK_BUFFER_MAX);
    return { mirrored: 0, error: (err as Error).message };
  }
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

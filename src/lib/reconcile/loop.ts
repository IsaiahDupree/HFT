import { cb } from "@/lib/coinbase/client";
import { db } from "@/lib/db/client";
import { poly } from "@/lib/polymarket/client";
import { appendOrderEvent, listOrderEvents } from "@/lib/venue/order-events";
import { diffOrders } from "./diff";
import type { LocalOrderRecord, ReconcileSummary, RemoteOrderRecord } from "./types";

/**
 * Reconcile local DB state with venue truth, append drift events to
 * order_events. Ported (concept-only) from TradingBot/src/execution/reconciler.py
 * — the SQLite + Polymarket/Coinbase shape is enough simpler that we don't need
 * the full reconciler class hierarchy. One function per venue is plenty.
 *
 * Called by `npm run worker:reconcile` (one-shot) or from a cron / /loop skill.
 */

/** Reconcile Coinbase OPEN orders. */
export async function reconcileCoinbase(): Promise<ReconcileSummary> {
  const t0 = Date.now();
  // Local: every coinbase_orders row not in a terminal state
  const localRows = db()
    .prepare(
      `SELECT order_id, status, filled_size, average_filled_price
         FROM coinbase_orders
         WHERE status NOT IN ('FILLED','CANCELLED','EXPIRED','FAILED')`,
    )
    .all() as Array<{
      order_id: string;
      status: string;
      filled_size: number | null;
      average_filled_price: number | null;
    }>;
  const local: LocalOrderRecord[] = localRows.map((r) => ({
    brokerOrderId: r.order_id,
    status: r.status,
    filledSize: r.filled_size ?? undefined,
    averagePrice: r.average_filled_price ?? undefined,
  }));

  // Remote: OPEN + PENDING orders from Coinbase.
  // Coinbase Advanced Trade API rejects {order_status: [OPEN, PENDING]} with
  // 400 INVALID_ARGUMENT "Cannot pass multiple statuses with OPEN" — OPEN
  // must be queried alone. Issue two requests and merge. Bug-fix #15 (2026-05-26).
  const [openResp, pendingResp] = await Promise.all([
    cb.listOrders({ order_status: ["OPEN"], limit: 1000 }),
    cb.listOrders({ order_status: ["PENDING"], limit: 1000 }).catch(() => ({ orders: [] as any[] })),
  ]);
  const remoteOrders = [...(openResp?.orders ?? []), ...(pendingResp?.orders ?? [])];
  const remoteResp = { orders: remoteOrders };
  const remote: RemoteOrderRecord[] = remoteOrders.map((o: any) => ({
    brokerOrderId: o.order_id,
    status: o.status,
    filledSize: o.filled_size != null ? Number(o.filled_size) : undefined,
    averagePrice: o.average_filled_price != null ? Number(o.average_filled_price) : undefined,
  }));

  const drifts = diffOrders(local, remote);

  // Persist drift events + upsert the local row to venue truth so the next
  // pass doesn't re-flag the same drift.
  const upsert = db().prepare(
    `INSERT INTO coinbase_orders (order_id, product_id, side, status, filled_size, average_filled_price, raw_json, updated_at)
     VALUES (@order_id, @product_id, @side, @status, @filled_size, @average_filled_price, @raw_json, datetime('now'))
     ON CONFLICT(order_id) DO UPDATE SET
        status = excluded.status,
        filled_size = excluded.filled_size,
        average_filled_price = excluded.average_filled_price,
        raw_json = excluded.raw_json,
        updated_at = datetime('now')`,
  );

  for (const d of drifts) {
    appendOrderEvent({
      event: "reconcile_drift",
      venue: "coinbase",
      clientOrderId: d.brokerOrderId, // we don't always know the original COID after restart
      brokerOrderId: d.brokerOrderId,
      status: d.remote?.status ?? d.local?.status ?? null ?? undefined,
      metadata: {
        kind: d.kind,
        local: d.local,
        remote: d.remote,
      },
    });
    // Adopt remote truth if we have it
    if (d.remote) {
      const raw = (remoteResp?.orders ?? []).find((o: any) => o.order_id === d.brokerOrderId);
      upsert.run({
        order_id: d.brokerOrderId,
        product_id: raw?.product_id ?? "",
        side: raw?.side ?? "",
        status: d.remote.status,
        filled_size: d.remote.filledSize ?? null,
        average_filled_price: d.remote.averagePrice ?? null,
        raw_json: raw ? JSON.stringify(raw) : null,
      });
    }
  }

  return {
    venue: "coinbase",
    scannedLocal: local.length,
    scannedRemote: remote.length,
    drifts,
    durationMs: Date.now() - t0,
  };
}

/**
 * Reconcile Polymarket trades observed by the venue against local `order_events`.
 *
 * Asymmetric with the Coinbase path: we don't have a mirror table for
 * Polymarket orders (only the audit log in order_events + evolution_log),
 * so this reconciler is observe-and-flag, not upsert-and-correct:
 *
 *   1. Pull recent trades from the authenticated CLOB endpoint (`poly.myTrades()`).
 *   2. Pull recent order_events for venue='polymarket' that resolved (status_filled).
 *   3. For each remote trade, check whether the local audit chain has a
 *      corresponding fill. Trades unmatched locally are written as
 *      `reconcile_drift` with `kind: 'missing_locally'` — the operator
 *      should investigate (likely a manual UI submit or a crash mid-submit).
 *
 * Skipped gracefully when CLOB auth isn't configured.
 */
export async function reconcilePolymarket(opts: { lookbackHours?: number; maxEvents?: number } = {}): Promise<ReconcileSummary> {
  const t0 = Date.now();
  const lookbackMs = (opts.lookbackHours ?? 6) * 3_600_000;
  const cutoff = Date.now() - lookbackMs;

  let remoteTrades: any[] = [];
  try {
    remoteTrades = await poly.myTrades();
  } catch (err) {
    // Auth not configured or endpoint failure — return an empty result so
    // a scheduled call doesn't take down the worker.
    return {
      venue: "polymarket",
      scannedLocal: 0,
      scannedRemote: 0,
      drifts: [{
        brokerOrderId: "auth-or-network",
        kind: "missing_remotely",
        local: null,
        remote: null,
      }],
      durationMs: Date.now() - t0,
    };
  }
  if (!Array.isArray(remoteTrades)) remoteTrades = [];

  // Trim to lookback window — CLOB trades carry millisecond timestamps in `match_time`
  // or `last_update`; tolerate either.
  const recentRemote = remoteTrades.filter((t: any) => {
    const tsRaw = t.match_time ?? t.last_update ?? t.timestamp;
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts)) return true; // keep if we can't tell
    // Heuristic: tsRaw may be ms-since-epoch or seconds; assume ms if > 10^12
    const ms = ts > 1e12 ? ts : ts * 1000;
    return ms >= cutoff;
  });

  // Local fills we know about
  const localFillEvents = listOrderEvents({ venue: "polymarket", limit: opts.maxEvents ?? 200 })
    .filter((e) => e.event === "status_filled" || e.event === "status_partially_filled")
    .filter((e) => Date.parse(e.created_at) >= cutoff);

  // For each remote trade, see if a local event references it (via broker_order_id
  // OR symbol+price+size match within tolerance).
  const drifts: ReturnType<typeof diffOrders> = [];
  for (const rt of recentRemote) {
    const rtId = String(rt.id ?? rt.trade_id ?? rt.taker_order_id ?? "");
    const matched = localFillEvents.some((e) => {
      if (e.broker_order_id && rtId && e.broker_order_id === rtId) return true;
      // Polymarket basket fills emit composite broker IDs (yes|no); check substring
      if (e.broker_order_id && rtId && e.broker_order_id.includes(rtId)) return true;
      // Fall back to symbol + side + qty + price (approximate match)
      const symMatch = e.symbol && rt.asset_id && String(e.symbol) === String(rt.asset_id);
      const qtyMatch = e.qty != null && rt.size != null && Math.abs(Number(e.qty) - Number(rt.size)) < 1e-6;
      const priceMatch = e.price != null && rt.price != null && Math.abs(Number(e.price) - Number(rt.price)) < 1e-4;
      return symMatch && qtyMatch && priceMatch;
    });
    if (!matched) {
      drifts.push({
        brokerOrderId: rtId || `${rt.asset_id ?? "?"}@${rt.price ?? "?"}`,
        kind: "missing_locally",
        local: null,
        remote: {
          brokerOrderId: rtId,
          status: String(rt.status ?? "FILLED"),
          filledSize: rt.size != null ? Number(rt.size) : undefined,
          averagePrice: rt.price != null ? Number(rt.price) : undefined,
        },
      });
      appendOrderEvent({
        event: "reconcile_drift",
        venue: "polymarket",
        clientOrderId: rtId || "polymarket-observed",
        brokerOrderId: rtId,
        status: String(rt.status ?? "FILLED"),
        metadata: { kind: "missing_locally", remote: rt },
      });
    }
  }

  return {
    venue: "polymarket",
    scannedLocal: localFillEvents.length,
    scannedRemote: recentRemote.length,
    drifts,
    durationMs: Date.now() - t0,
  };
}

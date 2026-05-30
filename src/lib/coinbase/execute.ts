/**
 * Coinbase Advanced Trade execution with the same hard safety gates as
 * src/lib/polymarket/execute.ts. Separate opt-in flag (`COINBASE_ALLOW_TRADE=1`)
 * so enabling Polymarket live trading doesn't silently arm Coinbase too.
 *
 * Three layers of protection — ALL must be satisfied for a real order:
 *   1. ENV: `COINBASE_ALLOW_TRADE=1` (otherwise DRY_RUN, only logs intent)
 *   2. Per-trade cap: `COINBASE_MAX_TRADE_USD` (default $25)
 *   3. Per-day cap:   `COINBASE_MAX_DAILY_USD` (default $100), summed from
 *                     evolution_log rows with event_type LIKE 'cb-executed%'
 *
 * Every intent writes an evolution_log row BEFORE attempting the call so
 * crashes still leave an audit trail. `killSwitch()` batches-cancel every open
 * order regardless of safety mode.
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { insertEvolutionEvent } from "@/lib/db/queries";
import { cb, type OrderSide } from "./client";

export type ExecuteMode = "DRY_RUN" | "LIVE";

function readMode(): ExecuteMode {
  return process.env.COINBASE_ALLOW_TRADE === "1" ? "LIVE" : "DRY_RUN";
}
function readMaxTradeUsd(): number {
  return Number(process.env.COINBASE_MAX_TRADE_USD ?? "25");
}
function readMaxDailyUsd(): number {
  return Number(process.env.COINBASE_MAX_DAILY_USD ?? "100");
}

function dailyExecutedUsd(): number {
  const row = db().prepare(
    `SELECT COALESCE(SUM(json_extract(payload_json, '$.cost_usd')), 0) AS spend
     FROM evolution_log
     WHERE event_type LIKE 'cb-executed%' AND created_at > datetime('now', '-1 day')`,
  ).get() as { spend: number };
  return row.spend ?? 0;
}

export type CbMarketIntent = {
  productId: string;
  side: OrderSide;
  /** For BUY: USD quote size. For SELL: base-asset size (e.g., BTC). */
  size: string;
  agentId?: number;
  strategyId?: number;
  /** Free-form note logged with the evolution event. */
  note?: string;
};

export type CbExecuteVerdict =
  | { kind: "dry-run"; reason: string; intent: CbMarketIntent; usdEquivalent: number }
  | { kind: "executed"; intent: CbMarketIntent; response: any; usdEquivalent: number }
  | { kind: "rejected"; reason: string };

function buildMarketBody(intent: CbMarketIntent): Record<string, unknown> {
  // Coinbase distinguishes `quote_size` (USD for BUY) vs `base_size` (asset for SELL).
  const cfg = intent.side === "BUY"
    ? { market_market_ioc: { quote_size: intent.size } }
    : { market_market_ioc: { base_size: intent.size } };
  return {
    client_order_id: randomUUID(),
    product_id: intent.productId,
    side: intent.side,
    order_configuration: cfg,
  };
}

/** Best-effort USD equivalent for cap accounting. Uses live best bid/ask for SELLs. */
async function estimateUsd(intent: CbMarketIntent): Promise<number> {
  if (intent.side === "BUY") return Number(intent.size);
  // SELL: convert base_size to USD using best bid (conservative).
  try {
    const book = await cb.getBestBidAsk({ product_ids: [intent.productId] });
    const top = book.pricebooks?.[0];
    const bid = Number(top?.bids?.[0]?.price ?? "0");
    return bid * Number(intent.size);
  } catch {
    return Number(intent.size); // fall back so caps still bind on something
  }
}

/** Submit a single market order with the full safety pipeline. */
export async function executeCoinbaseMarket(intent: CbMarketIntent): Promise<CbExecuteVerdict> {
  const mode = readMode();
  const maxTrade = readMaxTradeUsd();
  const maxDaily = readMaxDailyUsd();
  const usd = await estimateUsd(intent);

  if (usd > maxTrade) {
    insertEvolutionEvent({
      agent_id: intent.agentId, strategy_id: intent.strategyId,
      event_type: "cb-rejected",
      summary: `Trade exceeds COINBASE_MAX_TRADE_USD ($${usd.toFixed(2)} > $${maxTrade})`,
      payload_json: JSON.stringify({ intent, usd }),
    });
    return { kind: "rejected", reason: "trade cap" };
  }
  const dailySpent = dailyExecutedUsd();
  if (dailySpent + usd > maxDaily) {
    insertEvolutionEvent({
      agent_id: intent.agentId, strategy_id: intent.strategyId,
      event_type: "cb-rejected",
      summary: `Trade exceeds COINBASE_MAX_DAILY_USD ($${(dailySpent + usd).toFixed(2)} > $${maxDaily})`,
      payload_json: JSON.stringify({ intent, usd, dailySpent }),
    });
    return { kind: "rejected", reason: "daily cap" };
  }

  if (mode === "DRY_RUN") {
    const reason = `COINBASE_ALLOW_TRADE!=1 → not submitting; intended $${usd.toFixed(2)} ${intent.side} ${intent.productId}`;
    insertEvolutionEvent({
      agent_id: intent.agentId, strategy_id: intent.strategyId,
      event_type: "cb-dry-run",
      summary: `DRY: ${intent.side} ${intent.size} ${intent.productId}${intent.note ? ` — ${intent.note}` : ""}`,
      payload_json: JSON.stringify({ intent, cost_usd: usd, mode }),
    });
    return { kind: "dry-run", reason, intent, usdEquivalent: usd };
  }

  insertEvolutionEvent({
    agent_id: intent.agentId, strategy_id: intent.strategyId,
    event_type: "cb-submitting",
    summary: `LIVE: ${intent.side} ${intent.size} ${intent.productId}`,
    payload_json: JSON.stringify({ intent, cost_usd: usd }),
  });

  try {
    const response = await cb.createOrder(buildMarketBody(intent) as any);
    const ok = response?.success ?? false;
    insertEvolutionEvent({
      agent_id: intent.agentId, strategy_id: intent.strategyId,
      event_type: ok ? "cb-executed" : "cb-rejected",
      summary: `${ok ? "EXEC" : "REJECT"}: ${intent.side} ${intent.size} ${intent.productId}${response?.failure_reason ? ` (${response.failure_reason})` : ""}`,
      payload_json: JSON.stringify({ intent, response, cost_usd: usd }),
    });
    if (!ok) return { kind: "rejected", reason: response?.failure_reason ?? "unknown" };
    return { kind: "executed", intent, response, usdEquivalent: usd };
  } catch (err) {
    insertEvolutionEvent({
      agent_id: intent.agentId, strategy_id: intent.strategyId,
      event_type: "cb-error",
      summary: `Submission failure: ${(err as Error).message.slice(0, 120)}`,
      payload_json: JSON.stringify({ intent, error: (err as Error).message }),
    });
    return { kind: "rejected", reason: (err as Error).message };
  }
}

/**
 * Emergency: cancel every currently-OPEN order. Always allowed; ignores
 * COINBASE_ALLOW_TRADE because cancellation is defensive.
 */
export async function killSwitch(): Promise<{ ok: boolean; cancelled: number; result?: any; error?: string }> {
  try {
    const open = await cb.listOrders({ order_status: ["OPEN"], limit: 1000 });
    const orderIds = (open?.orders ?? []).map((o: any) => o.order_id).filter(Boolean);
    if (orderIds.length === 0) {
      insertEvolutionEvent({ event_type: "cb-kill-switch", summary: "killSwitch(): no open orders", payload_json: "{}" });
      return { ok: true, cancelled: 0 };
    }
    const result = await cb.batchCancelOrders({ order_ids: orderIds });
    insertEvolutionEvent({
      event_type: "cb-kill-switch",
      summary: `killSwitch() cancelled ${orderIds.length} orders`,
      payload_json: JSON.stringify({ orderIds, result }),
    });
    return { ok: true, cancelled: orderIds.length, result };
  } catch (err) {
    return { ok: false, cancelled: 0, error: (err as Error).message };
  }
}

export const cbSafety = {
  mode: readMode,
  maxTrade: readMaxTradeUsd,
  maxDaily: readMaxDailyUsd,
  dailyExecutedUsd,
};

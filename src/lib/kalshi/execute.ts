/**
 * Kalshi execution with the same hard safety gates as src/lib/coinbase/execute.ts.
 * Separate opt-in flag (`KALSHI_ALLOW_TRADE=1`) so enabling Coinbase or
 * Polymarket live trading doesn't silently arm Kalshi too.
 *
 * Three layers of protection — ALL must be satisfied for a real order:
 *   1. ENV: `KALSHI_ALLOW_TRADE=1` (otherwise DRY_RUN, only logs intent)
 *   2. Per-trade cap: `KALSHI_MAX_TRADE_USD` (default $25)
 *   3. Per-day cap:   `KALSHI_MAX_DAILY_USD` (default $100), summed from
 *                     evolution_log rows with event_type LIKE 'ks-executed%'
 *
 * Every intent writes an evolution_log row BEFORE attempting the call so
 * crashes still leave an audit trail. `killSwitch()` cancels every resting
 * order regardless of safety mode.
 *
 * Kalshi prices are integer cents (1–99) per contract; payout is 100¢ on win.
 *   risk(BUY  yes_price) = count * yes_price / 100   USD
 *   risk(SELL yes_price) = count * (100 - yes_price) / 100  USD  (short-equivalent)
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { insertEvolutionEvent } from "@/lib/db/queries";
import { kalshi, type KalshiAction, type KalshiSide, type KalshiOrderType } from "./client";

export type ExecuteMode = "DRY_RUN" | "LIVE";

function readMode(): ExecuteMode {
  return process.env.KALSHI_ALLOW_TRADE === "1" ? "LIVE" : "DRY_RUN";
}
function readMaxTradeUsd(): number {
  return Number(process.env.KALSHI_MAX_TRADE_USD ?? "25");
}
function readMaxDailyUsd(): number {
  return Number(process.env.KALSHI_MAX_DAILY_USD ?? "100");
}

function dailyExecutedUsd(): number {
  const row = db().prepare(
    `SELECT COALESCE(SUM(json_extract(payload_json, '$.cost_usd')), 0) AS spend
     FROM evolution_log
     WHERE event_type LIKE 'ks-executed%' AND created_at > datetime('now', '-1 day')`,
  ).get() as { spend: number };
  return row.spend ?? 0;
}

export type KsIntent = {
  ticker: string;
  action: KalshiAction;       // "buy" | "sell"
  side: KalshiSide;           // "yes" | "no"
  type: KalshiOrderType;      // "limit" | "market"
  count: number;              // number of contracts
  /** Required for limit orders. Integer 1–99 cents (YES-side reference price). */
  yesPriceCents?: number;
  agentId?: number;
  strategyId?: number;
  /** Free-form note logged with the evolution event. */
  note?: string;
  /** Optional caller-supplied idempotency key; one is generated if absent. */
  clientOrderId?: string;
};

export type KsExecuteVerdict =
  | { kind: "dry-run"; reason: string; intent: KsIntent; usdEquivalent: number }
  | { kind: "executed"; intent: KsIntent; response: any; usdEquivalent: number }
  | { kind: "rejected"; reason: string };

/**
 * Convert a YES-side reference price to the effective price you'd pay for
 * the side you're actually trading. Kalshi orderbooks quote YES bid/ask;
 * the NO side trades at (100 - yes_price).
 */
function effectivePriceCents(side: KalshiSide, yesPriceCents: number): number {
  return side === "yes" ? yesPriceCents : 100 - yesPriceCents;
}

/** Max USD you could lose on the order — used for cap enforcement. */
function estimateUsd(intent: KsIntent): number {
  // For limit orders we know exactly; for market we use the supplied price as
  // an estimate (callers should fetch best bid/ask and pass it in).
  if (intent.yesPriceCents == null) {
    // Without a price we can't bound risk; force callers to supply one.
    throw new Error("KsIntent.yesPriceCents is required for cap accounting (pass best bid/ask for market orders)");
  }
  const px = effectivePriceCents(intent.side, intent.yesPriceCents);
  const cost = intent.count * (intent.action === "buy" ? px : (100 - px));
  return cost / 100;
}

function buildOrderBody(intent: KsIntent) {
  // Kalshi expects yes_price for YES-side and no_price for NO-side limits.
  const body: Record<string, unknown> = {
    ticker: intent.ticker,
    action: intent.action,
    side: intent.side,
    type: intent.type,
    count: intent.count,
    client_order_id: intent.clientOrderId ?? randomUUID(),
  };
  if (intent.type === "limit" && intent.yesPriceCents != null) {
    if (intent.side === "yes") body.yes_price = intent.yesPriceCents;
    else body.no_price = 100 - intent.yesPriceCents;
  }
  return body;
}

/** Submit a single order through the full safety pipeline. */
export async function executeKalshi(intent: KsIntent): Promise<KsExecuteVerdict> {
  const mode = readMode();
  const maxTrade = readMaxTradeUsd();
  const maxDaily = readMaxDailyUsd();
  const usd = estimateUsd(intent);

  if (usd > maxTrade) {
    insertEvolutionEvent({
      agent_id: intent.agentId, strategy_id: intent.strategyId,
      event_type: "ks-rejected",
      summary: `Trade exceeds KALSHI_MAX_TRADE_USD ($${usd.toFixed(2)} > $${maxTrade})`,
      payload_json: JSON.stringify({ intent, usd }),
    });
    return { kind: "rejected", reason: "trade cap" };
  }
  const dailySpent = dailyExecutedUsd();
  if (dailySpent + usd > maxDaily) {
    insertEvolutionEvent({
      agent_id: intent.agentId, strategy_id: intent.strategyId,
      event_type: "ks-rejected",
      summary: `Trade exceeds KALSHI_MAX_DAILY_USD ($${(dailySpent + usd).toFixed(2)} > $${maxDaily})`,
      payload_json: JSON.stringify({ intent, usd, dailySpent }),
    });
    return { kind: "rejected", reason: "daily cap" };
  }

  if (mode === "DRY_RUN") {
    const reason = `KALSHI_ALLOW_TRADE!=1 → not submitting; intended $${usd.toFixed(2)} ${intent.action} ${intent.count} ${intent.side.toUpperCase()} @ ${intent.ticker}`;
    insertEvolutionEvent({
      agent_id: intent.agentId, strategy_id: intent.strategyId,
      event_type: "ks-dry-run",
      summary: `DRY: ${intent.action} ${intent.count} ${intent.side} ${intent.ticker}${intent.note ? ` — ${intent.note}` : ""}`,
      payload_json: JSON.stringify({ intent, cost_usd: usd, mode }),
    });
    return { kind: "dry-run", reason, intent, usdEquivalent: usd };
  }

  insertEvolutionEvent({
    agent_id: intent.agentId, strategy_id: intent.strategyId,
    event_type: "ks-submitting",
    summary: `LIVE: ${intent.action} ${intent.count} ${intent.side} ${intent.ticker}`,
    payload_json: JSON.stringify({ intent, cost_usd: usd }),
  });

  try {
    const response = await kalshi.createOrder(buildOrderBody(intent) as any);
    const ok = !!response?.order?.order_id;
    insertEvolutionEvent({
      agent_id: intent.agentId, strategy_id: intent.strategyId,
      event_type: ok ? "ks-executed" : "ks-rejected",
      summary: `${ok ? "EXEC" : "REJECT"}: ${intent.action} ${intent.count} ${intent.side} ${intent.ticker}`,
      payload_json: JSON.stringify({ intent, response, cost_usd: usd }),
    });
    if (!ok) return { kind: "rejected", reason: "no order_id in response" };
    return { kind: "executed", intent, response, usdEquivalent: usd };
  } catch (err) {
    insertEvolutionEvent({
      agent_id: intent.agentId, strategy_id: intent.strategyId,
      event_type: "ks-error",
      summary: `Submission failure: ${(err as Error).message.slice(0, 120)}`,
      payload_json: JSON.stringify({ intent, error: (err as Error).message }),
    });
    return { kind: "rejected", reason: (err as Error).message };
  }
}

/**
 * Emergency: cancel every currently-resting order. Ignores KALSHI_ALLOW_TRADE
 * because cancellation is defensive. Returns count of orders cancelled.
 */
export async function killSwitch(): Promise<{ ok: boolean; cancelled: number; errors?: string[] }> {
  const errors: string[] = [];
  try {
    const open = await kalshi.listOrders({ status: "resting", limit: 1000 });
    const ids: string[] = (open?.orders ?? []).map((o: any) => o.order_id).filter(Boolean);
    if (ids.length === 0) {
      insertEvolutionEvent({ event_type: "ks-kill-switch", summary: "killSwitch(): no resting orders", payload_json: "{}" });
      return { ok: true, cancelled: 0 };
    }
    // Kalshi has no documented bulk-cancel-by-id endpoint that takes an array
    // in a query-string-free way; cancel sequentially. Order is bounded by
    // list limit above.
    let cancelled = 0;
    for (const id of ids) {
      try {
        await kalshi.cancelOrder(id);
        cancelled++;
      } catch (e) {
        errors.push(`${id}: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    insertEvolutionEvent({
      event_type: "ks-kill-switch",
      summary: `killSwitch() cancelled ${cancelled}/${ids.length} orders`,
      payload_json: JSON.stringify({ ids, cancelled, errors }),
    });
    return { ok: errors.length === 0, cancelled, errors: errors.length ? errors : undefined };
  } catch (err) {
    return { ok: false, cancelled: 0, errors: [(err as Error).message] };
  }
}

export const ksSafety = {
  mode: readMode,
  maxTrade: readMaxTradeUsd,
  maxDaily: readMaxDailyUsd,
  dailyExecutedUsd,
  estimateUsd,
};

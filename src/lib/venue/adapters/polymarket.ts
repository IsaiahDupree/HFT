import {
  executeSingleMarketArb, killSwitch as pmKillSwitch, safety as pmSafety,
  submitSingleSideMarket,
} from "@/lib/polymarket/execute";
import type { SingleMarketArb } from "@/lib/polymarket/arb";
import type { SubmitVerdict, UnifiedOrder, VenueAdapter, VenueCapabilities } from "../types";

/**
 * Polymarket adapter — wraps the existing executeSingleMarketArb path so the
 * router-driven and direct paths share the same safety pipeline (ALLOW_TRADE,
 * MAX_TRADE_USD, MAX_DAILY_USD). The router lets you submit an arb basket via
 * the generic UnifiedOrder shape:
 *
 *   {
 *     venue: 'polymarket', type: 'FOK_BASKET',
 *     symbol: '<condition_id>',
 *     metadata: { arb: <SingleMarketArb>, sizeUsd: <USD> },
 *     ...
 *   }
 *
 * We deliberately did not collapse the existing single-call API — researchers
 * still call executeSingleMarketArb directly with full typing.
 */
export class PolymarketAdapter implements VenueAdapter {
  readonly name = "polymarket";
  readonly capabilities: VenueCapabilities = {
    market: true,           // single-side MARKET (BUY YES/NO) via submitSingleSideMarket
    limit: false,           // would require a separate execute path
    fok: true,              // FOK_BASKET for arb pairs
    cancel: false,          // single-order cancel not implemented (FOK fills or auto-cancels)
    cancelAll: true,
    userChannelWs: false,   // not wired yet — real-time-data-client adds this
  };

  isAvailable(): boolean {
    return Boolean(process.env.POLYMARKET_PRIVATE_KEY);
  }

  async submit(order: UnifiedOrder): Promise<SubmitVerdict> {
    if (order.type === "MARKET") return submitMarket(order);
    if (order.type === "FOK_BASKET") return submitFokBasket(order);
    return {
      ok: false,
      code: "INVALID_INPUT",
      reason: `polymarket adapter only supports type=MARKET or FOK_BASKET (got ${order.type})`,
      usdEquivalent: order.refPrice * order.size || 0,
    };
  }

  async cancel(_brokerOrderId: string): Promise<{ ok: boolean; error?: string }> {
    // FOK baskets either fill in full or are auto-cancelled by the venue.
    // Singleton cancel isn't meaningful here, so we expose only the bulk path.
    return { ok: false, error: "polymarket adapter does not support single-order cancel (FOK only)" };
  }

  async cancelAll(): Promise<{ ok: boolean; cancelled: number; error?: string; raw?: unknown }> {
    const result = await pmKillSwitch();
    if (!result.ok) return { ok: false, cancelled: 0, error: result.error };
    return { ok: true, cancelled: result.result?.canceled?.length ?? 0, raw: result.result };
  }

  async health() {
    return {
      ok: this.isAvailable(),
      name: this.name,
      details: {
        mode: pmSafety.mode(),
        max_trade_usd: pmSafety.maxTrade(),
        max_daily_usd: pmSafety.maxDaily(),
        daily_executed_usd: pmSafety.dailyExecutedUsd(),
      },
    };
  }
}

function extractBasketId(orders: any[]): string | undefined {
  const ids = (orders ?? [])
    .map((o) => o?.orderID ?? o?.order_id ?? o?.id)
    .filter(Boolean) as string[];
  return ids.length ? ids.join("|") : undefined;
}

/**
 * MARKET handler — single-side BUY or SELL on a Polymarket CLOB token.
 *
 * Arena directional strategies use this:
 *   - BUY  YES   → bet on YES winning (long YES)
 *   - SELL YES (with metadata.no_token_id) → swap to BUY NO (cleanest way to bet against)
 *   - SELL YES (no swap)                   → close an existing YES position (size = shares)
 *
 * Caller signals intent via metadata.intent ('entry' | 'exit'). On entry SELL
 * with a no_token_id, we swap to BUY NO. On exit SELL, we treat size as the
 * share count to dump back to the book.
 */
async function submitMarket(order: UnifiedOrder): Promise<SubmitVerdict> {
  const intent = (order.metadata?.intent as "entry" | "exit" | undefined) ?? "entry";
  const noTokenId = order.metadata?.no_token_id as string | undefined;

  // Determine final tokenId + side after the YES/NO swap rule.
  let tokenId = order.symbol;
  let side: "BUY" | "SELL" = order.side;
  if (intent === "entry" && order.side === "SELL" && noTokenId) {
    // SELL-YES entry → buy the NO token instead. This is how directional shorts
    // get expressed on Polymarket (you can't short the YES token; you buy NO).
    tokenId = noTokenId;
    side = "BUY";
  }

  const sizeUsd = Number(order.metadata?.sizeUsd ?? order.size);
  // For exits (SELL of YES we hold), `order.size` is the share count.
  const shares = side === "SELL" ? Number(order.size) : undefined;
  const refPrice = order.refPrice > 0 ? order.refPrice : 0.5; // fallback to a midpoint guess if absent

  const verdict = await submitSingleSideMarket({
    tokenId,
    side,
    sizeUsd,
    shares,
    refPrice,
    agentId: order.agentId,
    strategyId: order.strategyId,
    rationale: (order.metadata?.rationale as string | undefined) ?? "arena-live",
  });

  if (verdict.kind === "dry-run") {
    return { ok: true, status: "dry_run", reason: verdict.reason, usdEquivalent: verdict.capUsed.trade };
  }
  if (verdict.kind === "executed") {
    return {
      ok: true,
      status: "filled",
      brokerOrderId: verdict.brokerOrderId,
      raw: verdict.raw,
      usdEquivalent: side === "BUY" ? sizeUsd : Number(shares ?? 0) * refPrice,
    };
  }
  return { ok: false, code: "ADAPTER_ERROR", reason: verdict.reason };
}

/** FOK_BASKET handler — the original arb path. Untouched by the directional changes. */
async function submitFokBasket(order: UnifiedOrder): Promise<SubmitVerdict> {
  const arb = order.metadata?.arb as SingleMarketArb | undefined;
  if (!arb) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      reason: "polymarket FOK_BASKET requires metadata.arb (SingleMarketArb)",
    };
  }
  const sizeUsd = Number(order.metadata?.sizeUsd ?? order.size);
  const verdict = await executeSingleMarketArb(arb, {
    sizeUsd,
    agentId: order.agentId,
    strategyId: order.strategyId,
  });

  if (verdict.kind === "dry-run") {
    return { ok: true, status: "dry_run", reason: verdict.reason, usdEquivalent: verdict.capUsed.trade };
  }
  if (verdict.kind === "executed") {
    return {
      ok: true,
      brokerOrderId: extractBasketId(verdict.orders),
      status: "filled",
      raw: verdict,
      usdEquivalent: verdict.planned.yes.sizeUsd + verdict.planned.no.sizeUsd,
    };
  }
  return { ok: false, code: "ADAPTER_ERROR", reason: verdict.reason };
}

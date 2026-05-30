import { cb } from "@/lib/coinbase/client";
import { cbSafety, executeCoinbaseMarket, killSwitch as cbKillSwitch } from "@/lib/coinbase/execute";
import type { SubmitVerdict, UnifiedOrder, VenueAdapter, VenueCapabilities } from "../types";

/**
 * Coinbase Advanced Trade adapter — wraps executeCoinbaseMarket so the
 * router-driven path shares the same safety pipeline (COINBASE_ALLOW_TRADE,
 * COINBASE_MAX_TRADE_USD, COINBASE_MAX_DAILY_USD).
 */
export class CoinbaseAdapter implements VenueAdapter {
  readonly name = "coinbase";
  readonly capabilities: VenueCapabilities = {
    market: true,
    limit: false,           // executeCoinbaseMarket() is MARKET-only today
    fok: false,
    cancel: true,
    cancelAll: true,
    userChannelWs: false,   // public WS only — user channel needs auth + extra wiring
  };

  isAvailable(): boolean {
    return Boolean(
      process.env.COINBASE_CDP_KEY_NAME ||
        process.env.COINBASE_CDP_KEY_FILE ||
        process.env.COINBASE_CDP_PRIVATE_KEY,
    );
  }

  async submit(order: UnifiedOrder): Promise<SubmitVerdict> {
    if (order.type !== "MARKET") {
      return {
        ok: false,
        code: "INVALID_INPUT",
        reason: `coinbase adapter only supports type=MARKET (got ${order.type})`,
      };
    }
    const verdict = await executeCoinbaseMarket({
      productId: order.symbol,
      side: order.side,
      size: String(order.size),
      agentId: order.agentId,
      strategyId: order.strategyId,
      note: typeof order.metadata?.note === "string" ? (order.metadata!.note as string) : undefined,
    });

    if (verdict.kind === "dry-run") {
      return {
        ok: true,
        status: "dry_run",
        reason: verdict.reason,
        usdEquivalent: verdict.usdEquivalent,
      };
    }
    if (verdict.kind === "executed") {
      const broker = verdict.response?.success_response?.order_id ?? verdict.response?.order_id;
      return {
        ok: true,
        brokerOrderId: broker,
        status: "filled",
        raw: verdict.response,
        usdEquivalent: verdict.usdEquivalent,
      };
    }
    return {
      ok: false,
      code: "ADAPTER_ERROR",
      reason: verdict.reason,
    };
  }

  async cancel(brokerOrderId: string): Promise<{ ok: boolean; error?: string; raw?: unknown }> {
    try {
      const result = await cb.batchCancelOrders({ order_ids: [brokerOrderId] });
      return { ok: true, raw: result };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async cancelAll(): Promise<{ ok: boolean; cancelled: number; error?: string; raw?: unknown }> {
    const result = await cbKillSwitch();
    if (!result.ok) return { ok: false, cancelled: 0, error: result.error };
    return { ok: true, cancelled: result.cancelled, raw: result.result };
  }

  async health() {
    return {
      ok: this.isAvailable(),
      name: this.name,
      details: {
        mode: cbSafety.mode(),
        max_trade_usd: cbSafety.maxTrade(),
        max_daily_usd: cbSafety.maxDaily(),
        daily_executed_usd: cbSafety.dailyExecutedUsd(),
      },
    };
  }
}

import { randomUUID } from "node:crypto";
import type { SubmitVerdict, UnifiedOrder, VenueAdapter, VenueCapabilities } from "../types";

/**
 * SimAdapter — paper-mode venue.
 *
 * Always succeeds, records the order in memory, returns a fake brokerOrderId.
 * The router still writes order_events on submit/status so the audit trail
 * matches a real venue. Patterned after Hummingbot's `paper_trade_exchange`
 * and Freqtrade's `dry_run` mode — the difference is that here it's a
 * *first-class venue* the router can target via `order.venue = 'sim'`,
 * which means a `stage='paper'` strategy_version submits through the exact
 * same pipeline a `stage='live'` version uses, just with a no-op adapter
 * at the end.
 */
export class SimAdapter implements VenueAdapter {
  readonly name = "sim";
  readonly capabilities: VenueCapabilities = {
    market: true,
    limit: true,
    fok: true,
    cancel: true,
    cancelAll: true,
    userChannelWs: false,
  };

  private orders = new Map<string, { order: UnifiedOrder; status: "filled" | "cancelled" }>();

  isAvailable(): boolean {
    return true;
  }

  async submit(order: UnifiedOrder): Promise<SubmitVerdict> {
    const brokerOrderId = `SIM-${randomUUID()}`;
    this.orders.set(brokerOrderId, { order, status: "filled" });
    return {
      ok: true,
      brokerOrderId,
      status: "filled",
      raw: { sim: true, filledAt: new Date().toISOString() },
      usdEquivalent: order.refPrice * order.size,
    };
  }

  async cancel(brokerOrderId: string): Promise<{ ok: boolean; error?: string }> {
    const row = this.orders.get(brokerOrderId);
    if (!row) return { ok: false, error: `unknown sim order ${brokerOrderId}` };
    row.status = "cancelled";
    return { ok: true };
  }

  async cancelAll(): Promise<{ ok: boolean; cancelled: number }> {
    let n = 0;
    for (const row of this.orders.values()) {
      if (row.status === "filled") continue;
      row.status = "cancelled";
      n++;
    }
    return { ok: true, cancelled: n };
  }

  async health() {
    return {
      ok: true,
      name: this.name,
      details: {
        recorded_orders: this.orders.size,
        always_available: true,
      },
    };
  }
}

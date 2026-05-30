import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../helpers/db";

let memDb: ReturnType<typeof makeMemoryDb> | null = null;
vi.mock("@/lib/db/client", () => ({
  db: () => {
    if (!memDb) memDb = makeMemoryDb();
    return memDb;
  },
  closeDb: () => { memDb?.close(); memDb = null; },
}));

import { ExecutionRouter } from "@/lib/venue/router";
import { RiskEngine } from "@/lib/risk/engine";
import { KillSwitch } from "@/lib/risk/kill-switch";
import { createCapsule, setStatus } from "@/lib/capsules/store";
import type { SubmitVerdict, UnifiedOrder, VenueAdapter, VenueCapabilities } from "@/lib/venue/types";
import { listOrderEvents } from "@/lib/venue/order-events";

class FakeAdapter implements VenueAdapter {
  readonly name = "fake";
  readonly capabilities: VenueCapabilities = {
    market: true, limit: true, fok: true, cancel: true, cancelAll: true, userChannelWs: false,
  };
  submitted: UnifiedOrder[] = [];
  cancelled = 0;
  available = true;

  isAvailable() { return this.available; }
  async submit(order: UnifiedOrder): Promise<SubmitVerdict> {
    this.submitted.push(order);
    return { ok: true, brokerOrderId: "FAKE-1", status: "filled", usdEquivalent: order.refPrice * order.size };
  }
  async cancel() { this.cancelled++; return { ok: true }; }
  async cancelAll() { this.cancelled++; return { ok: true, cancelled: 1 }; }
}

function makeRouter() {
  const risk = new RiskEngine({
    enabled: true,
    max_order_notional_usd: 1000,
    max_position_notional_usd: 5000,
    max_daily_loss_usd: 1000,
    max_open_positions: 10,
    max_orders_per_minute: 60,
    max_concentration_pct: 1.0,
    require_confirmation_above_usd: 10_000,
    forbidden_symbols: [],
  });
  const kill = new KillSwitch(risk);
  const router = new ExecutionRouter({ riskEngine: risk, killSwitch: kill });
  const adapter = new FakeAdapter();
  router.registerAdapter(adapter);
  return { router, risk, kill, adapter };
}

beforeEach(() => { memDb?.close(); memDb = null; });
afterEach(() => { memDb?.close(); memDb = null; });

function baseOrder(overrides: Partial<UnifiedOrder> = {}): UnifiedOrder {
  return {
    clientOrderId: `coid-${Math.random().toString(36).slice(2)}`,
    venue: "fake",
    symbol: "BTC-USD",
    side: "BUY",
    type: "MARKET",
    size: 1,
    refPrice: 100,
    ...overrides,
  };
}

describe("router — idempotency + halt gate", () => {
  it("dedups by clientOrderId", async () => {
    const { router, adapter } = makeRouter();
    const order = baseOrder({ clientOrderId: "dup-1" });
    const r1 = await router.submit(order);
    expect(r1.ok).toBe(true);
    const r2 = await router.submit({ ...order });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("DUPLICATE_CLIENT_ORDER_ID");
    expect(adapter.submitted).toHaveLength(1);
  });

  it("rejects with HALTED when kill switch is engaged", async () => {
    const { router, kill, adapter } = makeRouter();
    await kill.haltAll("test halt", "pause_new_only");
    const verdict = await router.submit(baseOrder());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("HALTED");
    expect(adapter.submitted).toHaveLength(0);
  });

  it("resume clears the halt and allows new orders", async () => {
    const { router, kill, adapter } = makeRouter();
    await kill.haltAll("test halt", "pause_new_only");
    kill.resume();
    const verdict = await router.submit(baseOrder());
    expect(verdict.ok).toBe(true);
    expect(adapter.submitted).toHaveLength(1);
  });
});

describe("router — capsule gate integration", () => {
  it("rejects when bound capsule does not exist", async () => {
    const { router } = makeRouter();
    const verdict = await router.submit(baseOrder({ capsuleId: "nonexistent" }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("CAPSULE_NOT_FOUND");
  });

  it("rejects when capsule status is draft (CAPSULE_NOT_ACTIVE)", async () => {
    const { router } = makeRouter();
    const cap = createCapsule({ name: "draft", capitalUsd: 1000, allowedVenues: ["fake"] });
    const verdict = await router.submit(baseOrder({ capsuleId: cap.id }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("CAPSULE_NOT_ACTIVE");
  });

  it("submits when capsule is active and within caps", async () => {
    const { router, adapter } = makeRouter();
    const cap = createCapsule({ name: "live", capitalUsd: 10_000, allowedVenues: ["fake"] });
    setStatus(cap.id, "live");
    const verdict = await router.submit(baseOrder({ capsuleId: cap.id }));
    expect(verdict.ok).toBe(true);
    expect(adapter.submitted).toHaveLength(1);
  });
});

describe("router — order_events trail", () => {
  it("writes a submitting + status_filled pair on a successful submit", async () => {
    const { router } = makeRouter();
    const order = baseOrder({ clientOrderId: "trail-1" });
    await router.submit(order);
    const events = listOrderEvents({ clientOrderId: "trail-1" });
    const types = events.map((e) => e.event).sort();
    expect(types).toEqual(["status_filled", "submitting"]);
  });

  it("writes rejected_halt when the halt gate blocks", async () => {
    const { router, kill } = makeRouter();
    await kill.haltAll("test halt", "pause_new_only");
    const order = baseOrder({ clientOrderId: "halt-1" });
    await router.submit(order);
    const events = listOrderEvents({ clientOrderId: "halt-1" });
    expect(events.some((e) => e.event === "rejected_halt")).toBe(true);
  });
});

describe("router — kill switch wiring", () => {
  it("haltAll cancels every registered adapter", async () => {
    const { kill, adapter } = makeRouter();
    await kill.haltAll("test", "liquidate");
    expect(adapter.cancelled).toBeGreaterThan(0);
  });
});

/**
 * Integration test for the router's pre-submit signal snapshot hook.
 *
 * Verifies that after a successful submit, the router writes an
 * `order-context-snapshot` evolution_log event capturing counts + samples
 * of consensus/opportunity/trade-classification events scoped to the symbol.
 */
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

import * as dbModule from "@/lib/db/client";
import { ExecutionRouter, resetDefaultRouterForTests } from "@/lib/venue/router";
import { SimAdapter } from "@/lib/venue/adapters/sim";
import { insertEvolutionEvent } from "@/lib/db/queries";
import type { UnifiedOrder } from "@/lib/venue/types";

beforeEach(() => {
  memDb?.close();
  memDb = null;
  resetDefaultRouterForTests();
});
afterEach(() => {
  memDb?.close();
  memDb = null;
  resetDefaultRouterForTests();
});

function snapshotEvents() {
  return (dbModule as any)
    .db()
    .prepare("SELECT summary, payload_json FROM evolution_log WHERE event_type = 'order-context-snapshot' ORDER BY id ASC")
    .all() as Array<{ summary: string; payload_json: string }>;
}

describe("router pre-submit signal snapshot", () => {
  it("writes an order-context-snapshot event after a successful sim submit", async () => {
    const router = new ExecutionRouter();
    router.registerAdapter(new SimAdapter());
    const order: UnifiedOrder = {
      clientOrderId: "test-1",
      venue: "sim",
      symbol: "cond-xyz",
      side: "BUY",
      type: "MARKET",
      size: 100,
      refPrice: 0.5,
    };
    const v = await router.submit(order);
    expect(v.ok).toBe(true);
    const snaps = snapshotEvents();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].summary).toContain("test-1");
    const p = JSON.parse(snaps[0].payload_json);
    expect(p.clientOrderId).toBe("test-1");
    expect(p.symbol).toBe("cond-xyz");
    expect(p.counts).toEqual({ consensus: 0, opportunities: 0, tradeClassifications: 0 });
  });

  it("captures consensus signal on same market in the snapshot", async () => {
    insertEvolutionEvent({
      event_type: "consensus-signal",
      summary: "consensus on cond-xyz",
      payload_json: JSON.stringify({
        marketKey: "cond-xyz",
        direction: "YES",
        effectiveWallets: 4,
        combinedTrust: 10,
        combinedUsd: 5000,
        avgPrice: 0.55,
      }),
    });
    const router = new ExecutionRouter();
    router.registerAdapter(new SimAdapter());
    await router.submit({
      clientOrderId: "test-2",
      venue: "sim",
      symbol: "cond-xyz",
      side: "BUY",
      type: "MARKET",
      size: 100,
      refPrice: 0.5,
    });
    const snaps = snapshotEvents();
    expect(snaps).toHaveLength(1);
    const p = JSON.parse(snaps[0].payload_json);
    expect(p.counts.consensus).toBe(1);
    expect(p.consensusSample.marketKey).toBe("cond-xyz");
  });

  it("captures opportunity on same market in the snapshot", async () => {
    insertEvolutionEvent({
      event_type: "near-resolution-opportunity",
      summary: "NRS opp",
      payload_json: JSON.stringify({
        marketKey: "cond-xyz",
        conditionId: "cond-xyz",
        side: "NO",
        edge: 0.03,
        annualizedEdge: 1.5,
        entryPrice: 0.97,
      }),
    });
    const router = new ExecutionRouter();
    router.registerAdapter(new SimAdapter());
    await router.submit({
      clientOrderId: "test-3",
      venue: "sim",
      symbol: "cond-xyz",
      side: "BUY",
      type: "MARKET",
      size: 50,
      refPrice: 0.97,
    });
    const p = JSON.parse(snapshotEvents()[0].payload_json);
    expect(p.counts.opportunities).toBe(1);
    expect(p.opportunitySample.type).toBe("near-resolution-opportunity");
  });

  it("does NOT write snapshot for rejected orders", async () => {
    const router = new ExecutionRouter();
    router.registerAdapter(new SimAdapter());
    // First submit succeeds
    await router.submit({
      clientOrderId: "test-4",
      venue: "sim",
      symbol: "cond-xyz",
      side: "BUY",
      type: "MARKET",
      size: 100,
      refPrice: 0.5,
    });
    // Same clientOrderId → DUPLICATE_CLIENT_ORDER_ID rejection
    const v = await router.submit({
      clientOrderId: "test-4",
      venue: "sim",
      symbol: "cond-xyz",
      side: "BUY",
      type: "MARKET",
      size: 100,
      refPrice: 0.5,
    });
    expect(v.ok).toBe(false);
    // Only one snapshot (from the first successful submit)
    expect(snapshotEvents()).toHaveLength(1);
  });

  it("does NOT write snapshot when adapter is missing (no-adapter rejection)", async () => {
    const router = new ExecutionRouter();
    // Don't register any adapter
    const v = await router.submit({
      clientOrderId: "test-5",
      venue: "nonexistent",
      symbol: "cond-xyz",
      side: "BUY",
      type: "MARKET",
      size: 100,
      refPrice: 0.5,
    });
    expect(v.ok).toBe(false);
    expect(snapshotEvents()).toHaveLength(0);
  });
});

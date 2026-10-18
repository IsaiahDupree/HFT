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

import { appendOrderEvent, listOrderEvents, verifyChain } from "@/lib/venue/order-events";

beforeEach(() => {
  memDb?.close();
  memDb = null;
});
afterEach(() => {
  memDb?.close();
  memDb = null;
});

describe("order_events hash chain", () => {
  it("appends events with monotonic seq starting at 0", () => {
    const r1 = appendOrderEvent({ event: "submitting", venue: "coinbase", clientOrderId: "c1" });
    const r2 = appendOrderEvent({ event: "status_filled", venue: "coinbase", clientOrderId: "c1" });
    expect(r1.seq).toBe(0);
    expect(r2.seq).toBe(1);
    expect(r2.prev_hash).toBe(r1.hash);
  });

  it("verifyChain returns ok=true on a clean chain", () => {
    appendOrderEvent({ event: "submitting", venue: "polymarket", clientOrderId: "p1" });
    appendOrderEvent({ event: "status_filled", venue: "polymarket", clientOrderId: "p1" });
    appendOrderEvent({ event: "rejected_risk", venue: "polymarket", clientOrderId: "p2" });
    const v = verifyChain();
    expect(v.ok).toBe(true);
    expect(v.nChecked).toBe(3);
    expect(v.brokenAtSeq).toBeNull();
  });

  it("verifyChain detects tampering in the middle of the chain", () => {
    appendOrderEvent({ event: "submitting", venue: "coinbase", clientOrderId: "c1" });
    appendOrderEvent({ event: "submitting", venue: "coinbase", clientOrderId: "c2" });
    appendOrderEvent({ event: "submitting", venue: "coinbase", clientOrderId: "c3" });
    // Tamper with seq=1's status field — should break verification at seq=1.
    if (memDb) memDb.prepare("UPDATE order_events SET status='TAMPERED' WHERE seq = 1").run();
    const v = verifyChain();
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(1);
  });

  it("listOrderEvents filters by venue and clientOrderId", () => {
    appendOrderEvent({ event: "submitting", venue: "coinbase", clientOrderId: "c1" });
    appendOrderEvent({ event: "submitting", venue: "polymarket", clientOrderId: "p1" });
    appendOrderEvent({ event: "status_filled", venue: "coinbase", clientOrderId: "c1" });
    expect(listOrderEvents({ venue: "coinbase" })).toHaveLength(2);
    expect(listOrderEvents({ venue: "polymarket" })).toHaveLength(1);
    expect(listOrderEvents({ clientOrderId: "c1" })).toHaveLength(2);
  });
});

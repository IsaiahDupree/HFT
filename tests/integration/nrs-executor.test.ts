/**
 * Integration test for the near-resolution auto-executor.
 *
 * Mirrors the consensus-executor test pattern. Stubs the venue router; seeds
 * synthetic `near-resolution-opportunity` events; verifies the executor
 * picks them up, sizes correctly, submits, dedupes, and respects caps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../helpers/db";

let memDb: ReturnType<typeof makeMemoryDb> | null = null;

vi.mock("@/lib/db/client", () => ({
  db: () => {
    if (!memDb) memDb = makeMemoryDb();
    return memDb;
  },
  closeDb: () => {
    memDb?.close();
    memDb = null;
  },
}));

const submitSpy = vi.fn(async (_order: any) => ({
  ok: true,
  status: "filled",
  brokerOrderId: "SIM-test",
  usdEquivalent: 25,
}));

vi.mock("@/lib/venue/router", () => ({
  getDefaultRouter: () => ({
    submit: submitSpy,
  }),
}));

import * as dbModule from "@/lib/db/client";
import { insertEvolutionEvent } from "@/lib/db/queries";

beforeEach(() => {
  memDb?.close();
  memDb = null;
  submitSpy.mockClear();
});
afterEach(() => {
  memDb?.close();
  memDb = null;
});

function seedOpp(
  conditionId: string,
  side: "YES" | "NO",
  entryPrice: number,
  edge: number,
  opts: { daysToResolution?: number; annualizedEdge?: number } = {},
): number {
  insertEvolutionEvent({
    event_type: "near-resolution-opportunity",
    summary: `NRS ${side} ${conditionId}`,
    payload_json: JSON.stringify({
      conditionId,
      marketKey: conditionId,
      side,
      entryPrice,
      edge,
      daysToResolution: opts.daysToResolution ?? 7,
      annualizedEdge: opts.annualizedEdge ?? 1.5,
    }),
  });
  const row = (dbModule as any)
    .db()
    .prepare("SELECT id FROM evolution_log ORDER BY id DESC LIMIT 1")
    .get();
  return row.id;
}

describe("NRS auto-executor — pollOnce", () => {
  it("dispatches an order for each new opportunity", async () => {
    seedOpp("cond-1", "NO", 0.97, 0.028);
    const { pollOnce } = await import("../../scripts/worker-near-resolution-exec.ts");
    const r = await pollOnce();
    expect(r.executed).toBe(1);
    expect(submitSpy).toHaveBeenCalledOnce();
    const order = submitSpy.mock.calls[0][0];
    expect(order.symbol).toBe("cond-1");
    expect(order.side).toBe("BUY");
    expect(order.refPrice).toBe(0.97);
    expect(order.venue).toBe("sim"); // default; NRS_LIVE not set
  });

  it("never re-executes the same opportunity (dedup by opportunity ID)", async () => {
    seedOpp("cond-2", "NO", 0.96, 0.038);
    const { pollOnce } = await import("../../scripts/worker-near-resolution-exec.ts");
    const a = await pollOnce();
    const b = await pollOnce();
    expect(a.executed).toBe(1);
    expect(b.executed).toBe(0);
    expect(b.skipped).toBeGreaterThanOrEqual(1);
    expect(submitSpy).toHaveBeenCalledOnce();
  });

  it("writes nrs-auto-exec event with opportunityId for audit", async () => {
    const oppId = seedOpp("cond-3", "NO", 0.95, 0.048);
    const { pollOnce } = await import("../../scripts/worker-near-resolution-exec.ts");
    await pollOnce();
    const rows = (dbModule as any)
      .db()
      .prepare("SELECT payload_json FROM evolution_log WHERE event_type = 'nrs-auto-exec'")
      .all();
    expect(rows).toHaveLength(1);
    const p = JSON.parse(rows[0].payload_json);
    expect(p.opportunityId).toBe(oppId);
    expect(p.mode).toBe("sim");
    expect(p.orderUsd).toBeGreaterThan(0);
  });

  it("edge-proportional sizing: larger edge → larger order", async () => {
    seedOpp("cond-small-edge", "NO", 0.98, 0.018);
    seedOpp("cond-big-edge", "NO", 0.95, 0.048);
    const { pollOnce } = await import("../../scripts/worker-near-resolution-exec.ts");
    await pollOnce();
    expect(submitSpy).toHaveBeenCalledTimes(2);
    const orders = submitSpy.mock.calls.map((c) => c[0]);
    const smallOrder = orders.find((o) => o.symbol === "cond-small-edge");
    const bigOrder = orders.find((o) => o.symbol === "cond-big-edge");
    expect(smallOrder).toBeDefined();
    expect(bigOrder).toBeDefined();
    const smallUsd = smallOrder!.size * smallOrder!.refPrice;
    const bigUsd = bigOrder!.size * bigOrder!.refPrice;
    expect(bigUsd).toBeGreaterThan(smallUsd);
  });

  it("respects the daily USD cap", async () => {
    // Seed 10 opportunities, default per-signal $25 + daily $100 → should fill 4-5 then stop
    for (let i = 0; i < 10; i++) seedOpp(`cond-${i}`, "NO", 0.95, 0.05);
    const { pollOnce } = await import("../../scripts/worker-near-resolution-exec.ts");
    const r = await pollOnce();
    expect(r.executed).toBeLessThanOrEqual(6); // at most 5-6 with $25/each capped at $100
    const totalUsd = submitSpy.mock.calls
      .map((c) => c[0].size * c[0].refPrice)
      .reduce((a, b) => a + b, 0);
    expect(totalUsd).toBeLessThanOrEqual(110); // small overshoot tolerance
  });

  it("skips opportunity with edge <= 0", async () => {
    seedOpp("cond-no-edge", "NO", 0.999, 0);
    const { pollOnce } = await import("../../scripts/worker-near-resolution-exec.ts");
    const r = await pollOnce();
    expect(r.executed).toBe(0);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("skips opportunity with invalid entryPrice", async () => {
    seedOpp("cond-bad", "NO", 1.5, 0.04); // > 1, invalid
    const { pollOnce } = await import("../../scripts/worker-near-resolution-exec.ts");
    const r = await pollOnce();
    expect(r.executed).toBe(0);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("returns empty result when no recent opportunities", async () => {
    const { pollOnce } = await import("../../scripts/worker-near-resolution-exec.ts");
    const r = await pollOnce();
    expect(r).toMatchObject({ checked: 0, executed: 0, skipped: 0 });
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("skips malformed payload without crashing", async () => {
    (dbModule as any)
      .db()
      .prepare(`INSERT INTO evolution_log (event_type, summary, payload_json) VALUES (?, ?, ?)`)
      .run("near-resolution-opportunity", "bad", "{not valid json");
    seedOpp("cond-good", "NO", 0.96, 0.038);
    const { pollOnce } = await import("../../scripts/worker-near-resolution-exec.ts");
    const r = await pollOnce();
    expect(r.executed).toBe(1);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });
});

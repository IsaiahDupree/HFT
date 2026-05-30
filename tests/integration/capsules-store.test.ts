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

import {
  createCapsule,
  deleteCapsule,
  getCapsule,
  listCapsules,
  setStatus,
  updateRealtime,
} from "@/lib/capsules/store";

beforeEach(() => {
  memDb?.close();
  memDb = null;
});
afterEach(() => {
  memDb?.close();
  memDb = null;
});

describe("CapsuleStore — create + read", () => {
  it("create yields a capsule with status='draft' and serialized JSON columns", () => {
    const cap = createCapsule({
      name: "test",
      capitalUsd: 500,
      allowedVenues: ["polymarket", "coinbase"],
      allowedSymbols: ["BTC-USD"],
      maxDailyLossUsd: 50,
      maxPositionPct: 0.25,
    });
    expect(cap.status).toBe("draft");
    expect(cap.capital_allocated_usd).toBe(500);
    expect(cap.capital_available_usd).toBe(500);
    expect(cap.allowed_venues).toEqual(["polymarket", "coinbase"]);
    expect(cap.allowed_symbols).toEqual(["BTC-USD"]);
    expect(cap.max_daily_loss_usd).toBe(50);
    expect(cap.max_position_pct).toBe(0.25);
  });

  it("getCapsule returns null when not found", () => {
    expect(getCapsule("does-not-exist")).toBeNull();
  });

  it("listCapsules filters by status", () => {
    const a = createCapsule({ name: "a", capitalUsd: 1, allowedVenues: ["coinbase"] });
    const b = createCapsule({ name: "b", capitalUsd: 2, allowedVenues: ["coinbase"] });
    setStatus(b.id, "live");
    expect(listCapsules({ status: "live" }).map((c) => c.id)).toEqual([b.id]);
    expect(listCapsules({ status: "draft" }).map((c) => c.id)).toEqual([a.id]);
  });
});

describe("CapsuleStore — status transitions", () => {
  it("setStatus to 'live' sets activated_at", () => {
    const cap = createCapsule({ name: "x", capitalUsd: 1, allowedVenues: ["coinbase"] });
    expect(cap.activated_at).toBeNull();
    setStatus(cap.id, "live");
    expect(getCapsule(cap.id)?.activated_at).not.toBeNull();
  });

  it("setStatus to 'paused' does not reset activated_at", () => {
    const cap = createCapsule({ name: "x", capitalUsd: 1, allowedVenues: ["coinbase"] });
    setStatus(cap.id, "live");
    const activatedAt = getCapsule(cap.id)?.activated_at;
    setStatus(cap.id, "paused");
    expect(getCapsule(cap.id)?.activated_at).toBe(activatedAt);
  });
});

describe("CapsuleStore — updateRealtime", () => {
  it("updates realtime fields without touching caps", () => {
    const cap = createCapsule({ name: "x", capitalUsd: 1000, allowedVenues: ["coinbase"], maxDailyLossUsd: 100 });
    updateRealtime(cap.id, { current_pnl_usd: 25, trades_today: 3, capital_deployed_usd: 200 });
    const r = getCapsule(cap.id)!;
    expect(r.current_pnl_usd).toBe(25);
    expect(r.trades_today).toBe(3);
    expect(r.capital_deployed_usd).toBe(200);
    expect(r.max_daily_loss_usd).toBe(100);
  });
});

describe("CapsuleStore — delete", () => {
  it("removes the row", () => {
    const cap = createCapsule({ name: "tbd", capitalUsd: 1, allowedVenues: ["coinbase"] });
    deleteCapsule(cap.id);
    expect(getCapsule(cap.id)).toBeNull();
  });
});

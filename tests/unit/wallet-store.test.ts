import { describe, it, expect } from "vitest";
import { openWalletDb, type WalletSnapshot, type TripRow } from "@/lib/exec/wallet-store";

const snap = (over: Partial<WalletSnapshot> & { ts: number; address: string }): WalletSnapshot => ({
  iso: new Date(over.ts).toISOString(), accountValue: 100_000, archetype: "directional-swing", label: "momentum-long swing — copyable",
  horizon: "swing", directionality: "momentum-long", copyabilityScore: 0.7, copyabilityVerdict: "copyable",
  tradesPerDay: 4, medianHoldMs: 8 * 3_600_000, longShare: 0.9, topCoin: "HYPE", topCoinShare: 0.6, nCoins: 5,
  nTrips: 40, winRate: 0.6, expectancyUsd: 50, realizedPnl: 2000, verified: true, flowDistorted: false, withdrawnUsd: 0, openPositions: "L HYPE $23k",
  ...over,
});

describe("wallet-store — longitudinal dataset", () => {
  it("saves snapshots and returns the LATEST per address (history accrues)", () => {
    const s = openWalletDb(":memory:");
    s.saveSnapshot(snap({ ts: 1000, address: "0xA", accountValue: 100_000 }));
    s.saveSnapshot(snap({ ts: 2000, address: "0xA", accountValue: 120_000 })); // newer
    s.saveSnapshot(snap({ ts: 1500, address: "0xB", accountValue: 50_000 }));
    const latest = s.latest().sort((a, b) => a.address.localeCompare(b.address));
    expect(latest).toHaveLength(2);
    expect(latest[0].address).toBe("0xA");
    expect(latest[0].accountValue).toBe(120_000); // the newer A snapshot
    expect(s.history("0xA")).toHaveLength(2);      // both A snapshots retained
    expect(s.snapshotCount()).toBe(3);
    s.close();
  });

  it("round-trips are idempotent — re-saving the same trades does not duplicate", () => {
    const s = openWalletDb(":memory:");
    const trips: TripRow[] = [
      { address: "0xA", coin: "BTC", side: "long", entryTime: 1, exitTime: 100, holdMs: 99, entryPx: 60000, exitPx: 61000, sz: 1, pnl: 1000 },
      { address: "0xA", coin: "ETH", side: "short", entryTime: 2, exitTime: 50, holdMs: 48, entryPx: 2000, exitPx: 1950, sz: 2, pnl: 100 },
    ];
    s.saveTrips(trips);
    s.saveTrips(trips); // re-run — INSERT OR IGNORE
    expect(s.tripCount("0xA")).toBe(2);
    s.close();
  });

  it("verified/flowDistorted booleans round-trip through INTEGER columns", () => {
    const s = openWalletDb(":memory:");
    s.saveSnapshot(snap({ ts: 1, address: "0xC", verified: false, flowDistorted: true }));
    const r = s.latest()[0];
    expect(!!r.verified).toBe(false);
    expect(!!r.flowDistorted).toBe(true);
    s.close();
  });
});

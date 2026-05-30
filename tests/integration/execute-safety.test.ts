import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../helpers/db";
import { samplePair } from "../helpers/fixtures";
import type { SingleMarketArb } from "@/lib/polymarket/arb";

let memDb: ReturnType<typeof makeMemoryDb> | null = null;
vi.mock("@/lib/db/client", () => ({
  db: () => {
    if (!memDb) memDb = makeMemoryDb();
    return memDb;
  },
}));

import { executeSingleMarketArb, safety } from "@/lib/polymarket/execute";

beforeEach(() => {
  memDb?.close();
  memDb = null;
  delete process.env.ALLOW_TRADE;
  delete process.env.MAX_TRADE_USD;
  delete process.env.MAX_DAILY_USD;
});

afterEach(() => {
  memDb?.close();
  memDb = null;
});

function fakeArb(over: Partial<SingleMarketArb> = {}): SingleMarketArb {
  return {
    conditionId: samplePair.conditionId,
    question: samplePair.question,
    yesTokenId: samplePair.yesTokenId,
    noTokenId: samplePair.noTokenId,
    bestYesAsk: 0.45,
    yesAskSize: 100,
    bestNoAsk: 0.45,
    noAskSize: 100,
    sumOfAsks: 0.9,
    rawEdgePerShare: 0.1,
    edgeAfterFeesPerShare: 0.095,
    maxExecutableShares: 50,
    expectedProfitUsd: 4.75,
    qualityScore: 1000,
    ...over,
  };
}

describe("safety helpers", () => {
  it("defaults to DRY_RUN", () => {
    expect(safety.mode()).toBe("DRY_RUN");
  });

  it("flips to LIVE when ALLOW_TRADE=1", () => {
    process.env.ALLOW_TRADE = "1";
    expect(safety.mode()).toBe("LIVE");
  });

  it.each(["0", "true", "yes", "", "false"])("ALLOW_TRADE=%s is DRY_RUN unless exactly '1'", (val) => {
    process.env.ALLOW_TRADE = val;
    expect(safety.mode()).toBe("DRY_RUN");
  });

  it.each([10, 25, 50, 100])("MAX_TRADE_USD=$val honored", (val) => {
    process.env.MAX_TRADE_USD = String(val);
    expect(safety.maxTrade()).toBe(val);
  });

  it.each([50, 100, 250, 500])("MAX_DAILY_USD=$val honored", (val) => {
    process.env.MAX_DAILY_USD = String(val);
    expect(safety.maxDaily()).toBe(val);
  });
});

describe("executeSingleMarketArb — dry-run path", () => {
  it("logs intent without submitting in DRY_RUN", async () => {
    const v = await executeSingleMarketArb(fakeArb(), { sizeUsd: 10 });
    expect(v.kind).toBe("dry-run");
    if (v.kind === "dry-run") {
      expect(v.planned.yes.shares).toBe(v.planned.no.shares);
      expect(v.planned.yes.shares).toBeGreaterThan(0);
    }
  });

  it("rejects when planned cost exceeds MAX_TRADE_USD cap", async () => {
    // Force per-share cost high enough that even 1 share exceeds a tiny cap.
    process.env.MAX_TRADE_USD = "0.5";
    // sumOfAsks=0.9 → 1 basket share costs $0.90 > $0.50 cap
    const v = await executeSingleMarketArb(fakeArb(), { sizeUsd: 100 });
    expect(v.kind).toBe("rejected");
  });

  it("rejects when sizeUsd too small for one whole share", async () => {
    const v = await executeSingleMarketArb(fakeArb(), { sizeUsd: 0.5 });
    expect(v.kind).toBe("rejected");
  });

  it.each([1, 2, 5, 10])("plans %i USD into reasonable shares", async (size) => {
    process.env.MAX_TRADE_USD = "100";
    const v = await executeSingleMarketArb(fakeArb(), { sizeUsd: size });
    if (v.kind === "dry-run") {
      const totalCost = v.planned.yes.sizeUsd + v.planned.no.sizeUsd;
      expect(totalCost).toBeLessThanOrEqual(size + 1);
    }
  });

  it("caps share count at maxExecutableShares from the arb", async () => {
    process.env.MAX_TRADE_USD = "1000";
    const v = await executeSingleMarketArb(fakeArb({ maxExecutableShares: 3 }), { sizeUsd: 500 });
    if (v.kind === "dry-run") {
      expect(v.planned.yes.shares).toBeLessThanOrEqual(3);
    }
  });

  it.each([
    { yes: 0.45, no: 0.45 },
    { yes: 0.40, no: 0.50 },
    { yes: 0.30, no: 0.60 },
    { yes: 0.05, no: 0.05 },
  ])("plan invariant: yes and no shares always equal (yes=$yes no=$no)", async ({ yes, no }) => {
    process.env.MAX_TRADE_USD = "50";
    const v = await executeSingleMarketArb(fakeArb({ bestYesAsk: yes, bestNoAsk: no, sumOfAsks: yes + no }), { sizeUsd: 20 });
    if (v.kind === "dry-run") {
      expect(v.planned.yes.shares).toBe(v.planned.no.shares);
    }
  });
});

import { describe, expect, it } from "vitest";
import { applyRiskRails } from "@/lib/arena/risk-wrapper";
import type { LiveAgent, Signal, Snapshot, SnapshotWindow, TickContext } from "@/lib/arena/types";

function makeCtx(marketId: string, price: number): TickContext {
  const snap: Snapshot = { venue: "sim-poly", market_id: marketId, price, captured_at: "2026-05-25T23:00:00Z" };
  const win: SnapshotWindow = { history: [snap], latest: snap };
  return { now: "2026-05-25T23:00:00Z", snapshots: new Map([[marketId, win]]) };
}
function makeAgent(cash = 1000): LiveAgent {
  return {
    id: 1, name: "test", generation: 0, parent_paper_agent_id: null,
    genome_json: "{}", introduced_by: "test",
    cash_usd_start: cash, cash_usd_current: cash, position_basket_json: "[]",
    realized_pnl_usd: 0, unrealized_pnl_usd: 0,
    peak_equity_usd: cash, max_drawdown_usd: 0,
    trades_count: 0, entries_count: 0, wins_count: 0,
    alive: 1, retire_reason: null, retired_at: null,
    created_at: "", updated_at: "",
    genome: { kind: "random_walk_baseline", params: { trade_prob: 0.05, buy_bias_pct: 0.5, entry_size_usd: 10 } },
    positions: [],
  };
}
const entry = (overrides: Partial<Extract<Signal, { kind: "entry" }>> = {}): Signal => ({
  kind: "entry", venue: "sim-poly", market_id: "m1", side: "BUY", size_usd: 50,
  rationale: "test", ...overrides,
});

describe("applyRiskRails — engagement", () => {
  it("passes through entries without pTrueEstimate (rail not engaged)", () => {
    const ctx = makeCtx("m1", 0.4);
    const sig = entry();
    const r = applyRiskRails(sig, ctx, makeAgent());
    expect(r.kept).toBe(true);
    if (r.kept) {
      expect(r.engaged).toBe(false);
      expect(r.signal).toBe(sig);
    }
  });

  it("passes through Coinbase entries even with pTrueEstimate (no binary semantics)", () => {
    const ctx = makeCtx("BTC-USD", 50_000);
    const sig = entry({ venue: "sim-coinbase", market_id: "BTC-USD", pTrueEstimate: { pTrue: 0.7 } });
    const r = applyRiskRails(sig, ctx, makeAgent());
    expect(r.kept).toBe(true);
    if (r.kept) expect(r.engaged).toBe(false);
  });

  it("passes through hold + exit signals untouched", () => {
    const ctx = makeCtx("m1", 0.4);
    const r = applyRiskRails({ kind: "hold" }, ctx, makeAgent());
    expect(r.kept).toBe(true);
    if (r.kept) expect(r.engaged).toBe(false);
  });
});

describe("applyRiskRails — EV gate", () => {
  it("blocks BUY entry when EV is below the 5% gate", () => {
    // pMarket = 0.40, pTrue = 0.42 → EV = 0.42×0.60 − 0.58×0.40 = 0.252 − 0.232 = 0.020 (2%)
    const ctx = makeCtx("m1", 0.40);
    const sig = entry({ pTrueEstimate: { pTrue: 0.42 } });
    const r = applyRiskRails(sig, ctx, makeAgent());
    expect(r.kept).toBe(false);
    if (!r.kept) {
      expect(r.reason).toMatch(/EV/);
      expect(r.ev).toBeCloseTo(0.020, 2);
    }
  });

  it("allows BUY entry when EV >= 5% gate (article's STRONG_EDGE example)", () => {
    // pMarket = 0.40, pTrue = 0.60 → EV = 0.60×0.60 − 0.40×0.40 = 0.36 − 0.16 = 0.20 (20%)
    const ctx = makeCtx("m1", 0.40);
    const sig = entry({ pTrueEstimate: { pTrue: 0.60 } });
    const r = applyRiskRails(sig, ctx, makeAgent());
    expect(r.kept).toBe(true);
    if (r.kept) {
      expect(r.engaged).toBe(true);
      expect(r.ev).toBeCloseTo(0.20, 2);
    }
  });

  it("custom minEv override is honored", () => {
    const ctx = makeCtx("m1", 0.40);
    const sig = entry({ pTrueEstimate: { pTrue: 0.42 } }); // 2% EV
    const r = applyRiskRails(sig, ctx, makeAgent(), { minEv: 0.01 });
    expect(r.kept).toBe(true);
  });
});

describe("applyRiskRails — Kelly sizing", () => {
  it("shrinks size to Kelly when genome requested more than Kelly recommends", () => {
    // pMarket = 0.40, pTrue = 0.60, bankroll = 1000
    // Full Kelly = 0.60 − 0.40/(0.60/0.40) ≈ 0.333; Quarter = 0.0833; betUsd ≈ $83
    const ctx = makeCtx("m1", 0.40);
    const sig = entry({ pTrueEstimate: { pTrue: 0.60 }, size_usd: 500 }); // genome asked for $500
    const r = applyRiskRails(sig, ctx, makeAgent(1000));
    expect(r.kept).toBe(true);
    if (r.kept) {
      expect(r.sizeAdjusted).toBe(true);
      expect(r.signal.kind).toBe("entry");
      if (r.signal.kind === "entry") {
        expect(r.signal.size_usd).toBeLessThan(500);
        expect(r.signal.size_usd).toBeLessThan(200); // Quarter Kelly is way below $500
        expect(r.signal.size_usd).toBeGreaterThan(0);
      }
    }
  });

  it("does not grow size — keeps genome's smaller request if Kelly suggests more", () => {
    const ctx = makeCtx("m1", 0.40);
    const sig = entry({ pTrueEstimate: { pTrue: 0.60 }, size_usd: 5 }); // tiny request
    const r = applyRiskRails(sig, ctx, makeAgent(1000));
    expect(r.kept).toBe(true);
    if (r.kept && r.signal.kind === "entry") {
      expect(r.signal.size_usd).toBe(5);
      expect(r.sizeAdjusted).toBe(false);
    }
  });
});

describe("applyRiskRails — SELL side (mirror)", () => {
  it("evaluates SELL using pTrue=1-pT vs pMarket=1-pM", () => {
    // We believe pTrue=0.40 (so P(NO)=0.60). Market says pMarket=0.60 (P(NO)=0.40).
    // Mirroring: pTrueForSide = 0.60, pMarketForSide = 0.40 → EV = +20%.
    const ctx = makeCtx("m1", 0.60);
    const sig = entry({ side: "SELL", pTrueEstimate: { pTrue: 0.40 } });
    const r = applyRiskRails(sig, ctx, makeAgent(1000));
    expect(r.kept).toBe(true);
    if (r.kept) {
      expect(r.engaged).toBe(true);
      expect(r.ev).toBeCloseTo(0.20, 2);
    }
  });
});

describe("applyRiskRails — degenerate cases", () => {
  it("refuses when pMarket is 0 or 1 (degenerate)", () => {
    const ctx = makeCtx("m1", 0);
    const r = applyRiskRails(entry({ pTrueEstimate: { pTrue: 0.5 } }), ctx, makeAgent());
    expect(r.kept).toBe(false);
  });
  it("refuses when no snapshot for the market", () => {
    const ctx = makeCtx("OTHER", 0.5);
    const r = applyRiskRails(entry({ market_id: "m1", pTrueEstimate: { pTrue: 0.7 } }), ctx, makeAgent());
    expect(r.kept).toBe(false);
  });
});

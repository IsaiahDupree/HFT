/**
 * Tests for the golden-signal → order mapping (the 2dollar-bot → HFT-work bridge
 * intake). Pure — no DB / network / execution.
 */
import { describe, expect, it } from "vitest";
import { planFromSignal, type GoldenSignal } from "@/lib/signal/intake";

function sig(over: Partial<GoldenSignal> = {}): GoldenSignal {
  return {
    source: "golden-window", asset: "SOL", recurrence: "5m", side: "UP",
    size_usd: 2, token_id: "0xTOK", entry_price: 0.84, est_win_prob: 0.96,
    edge: 0.12, readiness_ok: true, ...over,
  };
}

const OPTS = { maxTradeUsd: 2 };

describe("planFromSignal", () => {
  it("accepts a valid signal → BUY the side's token", () => {
    const d = planFromSignal(sig(), OPTS);
    expect(d.accepted).toBe(true);
    expect(d.order).toMatchObject({ tokenId: "0xTOK", side: "BUY", sizeUsd: 2, refPrice: 0.84 });
    expect(d.order!.rationale).toContain("SOL:5m");
  });

  it("rejects when the 2dollar readiness gate failed", () => {
    const d = planFromSignal(sig({ readiness_ok: false }), OPTS);
    expect(d.accepted).toBe(false);
    expect(d.reason).toContain("readiness");
  });

  it("rejects a missing token_id", () => {
    expect(planFromSignal(sig({ token_id: undefined }), OPTS).accepted).toBe(false);
  });

  it("rejects a bad side", () => {
    expect(planFromSignal(sig({ side: "SIDEWAYS" }), OPTS).accepted).toBe(false);
  });

  it("rejects an out-of-range entry price", () => {
    expect(planFromSignal(sig({ entry_price: 1.4 }), OPTS).accepted).toBe(false);
    expect(planFromSignal(sig({ entry_price: 0 }), OPTS).accepted).toBe(false);
  });

  it("rejects zero size", () => {
    expect(planFromSignal(sig({ size_usd: 0 }), OPTS).accepted).toBe(false);
  });

  it("caps size at maxTradeUsd", () => {
    const d = planFromSignal(sig({ size_usd: 50 }), { maxTradeUsd: 2 });
    expect(d.order!.sizeUsd).toBe(2); // never exceeds the per-trade cap
  });

  it("accepts DOWN / NO sides too", () => {
    expect(planFromSignal(sig({ side: "DOWN" }), OPTS).accepted).toBe(true);
    expect(planFromSignal(sig({ side: "no" }), OPTS).accepted).toBe(true);
  });
});

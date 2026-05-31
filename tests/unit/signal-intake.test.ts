/**
 * Tests for the golden-signal → order mapping (the 2dollar-bot → HFT-work bridge
 * intake). Pure — no DB / network / execution.
 */
import { describe, expect, it } from "vitest";
import { planFromSignal, regimeOf, dedupKey, type GoldenSignal } from "@/lib/signal/intake";

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

describe("single-regime allowlist", () => {
  const ALLOW = { maxTradeUsd: 2, allow: ["SOL:5m"] };

  it("accepts the allowed regime", () => {
    expect(planFromSignal(sig({ asset: "SOL", recurrence: "5m" }), ALLOW).accepted).toBe(true);
  });

  it("REJECTS every other coin+window (no trades against the rest)", () => {
    expect(planFromSignal(sig({ asset: "ETH", recurrence: "5m" }), ALLOW).accepted).toBe(false);
    expect(planFromSignal(sig({ asset: "SOL", recurrence: "15m" }), ALLOW).accepted).toBe(false);
    expect(planFromSignal(sig({ asset: "BTC", recurrence: "15m" }), ALLOW).reason).toContain("not in allowlist");
  });

  it("empty allowlist allows all (allowlist disabled)", () => {
    expect(planFromSignal(sig({ asset: "BTC" }), { maxTradeUsd: 2, allow: [] }).accepted).toBe(true);
  });

  it("regimeOf normalizes ASSET:rec", () => {
    expect(regimeOf(sig({ asset: "sol", recurrence: "5M" }))).toBe("SOL:5m");
  });
});

describe("dedupKey (one order per window)", () => {
  it("is the regime + window_end_ts", () => {
    expect(dedupKey(sig({ asset: "ETH", recurrence: "5m", window_end_ts: 1780242300 }))).toBe("ETH:5m@1780242300");
  });
  it("same window → same key (would dedup), different window → different key", () => {
    const a = dedupKey(sig({ window_end_ts: 1000 }));
    const b = dedupKey(sig({ window_end_ts: 1000 }));
    const c = dedupKey(sig({ window_end_ts: 1300 }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it("null when no window_end_ts (non-dedupable)", () => {
    expect(dedupKey(sig({ window_end_ts: undefined }))).toBeNull();
  });
});

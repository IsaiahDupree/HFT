import { describe, it, expect } from "vitest";
import { detectMoves, alphaAhead, copySignal, type Position } from "@/lib/exec/move-detector";

const HOUR = 3_600_000, MIN = 60_000;
const pos = (coin: string, notionalUsd: number): Position => ({ coin, notionalUsd });

describe("detectMoves — diff two snapshots into discrete moves", () => {
  it("classifies open / increase / reduce / close / flip", () => {
    const prev = [pos("BTC", 0), pos("ETH", 100_000), pos("SOL", 50_000), pos("HYPE", 30_000), pos("XRP", 20_000)];
    const cur = [pos("BTC", 80_000), pos("ETH", 150_000), pos("SOL", 20_000), pos("HYPE", 0), pos("XRP", -25_000)];
    const m = detectMoves(prev, cur);
    const by = Object.fromEntries(m.map((x) => [x.coin, x.type]));
    expect(by.BTC).toBe("open");
    expect(by.ETH).toBe("increase");
    expect(by.SOL).toBe("reduce");
    expect(by.HYPE).toBe("close");
    expect(by.XRP).toBe("flip"); // +20k long → −25k short
  });
  it("ignores sub-threshold wiggles", () => {
    expect(detectMoves([pos("BTC", 100_000)], [pos("BTC", 100_500)], 1_000)).toHaveLength(0);
  });
  it("sorts by absolute size of the move (biggest first)", () => {
    const m = detectMoves([pos("A", 0), pos("B", 0)], [pos("A", 10_000), pos("B", 90_000)]);
    expect(m[0].coin).toBe("B");
  });
});

describe("alphaAhead — fraction of the wallet's horizon still in front of you", () => {
  it("a 1-min lag on an 8-hour hold leaves ~all the alpha; a 6h lag on 8h leaves little", () => {
    expect(alphaAhead(8 * HOUR, MIN)).toBeGreaterThan(0.99);
    expect(alphaAhead(8 * HOUR, 6 * HOUR)).toBeCloseTo(0.25, 2);
  });
  it("lag past the hold horizon → zero alpha ahead", () => {
    expect(alphaAhead(HOUR, 2 * HOUR)).toBe(0);
  });
});

describe("copySignal — the honest live-copy gate", () => {
  const move = detectMoves([pos("BTC", 0)], [pos("BTC", 80_000)])[0];

  it("NEVER actionable on an HFT/scalper — flags the latency trap with the reason", () => {
    const s = copySignal(move, "none", 30_000, MIN);
    expect(s.actionable).toBe(false);
    expect(s.latencyTrap).toBe(true);
    expect(s.urgency).toBe("none");
    expect(s.reason).toMatch(/exit liquidity|after the move/);
  });
  it("trade-copy + small lag vs long hold → actionable NOW", () => {
    const s = copySignal(move, "trade-copy", 8 * HOUR, MIN);
    expect(s.actionable).toBe(true);
    expect(s.latencyTrap).toBe(false);
    expect(s.urgency).toBe("now");
    expect(s.alphaAhead).toBeGreaterThan(0.9);
  });
  it("position-copy → actionable but SOON (net-book adjust, not trade-for-trade)", () => {
    const s = copySignal(move, "position-copy", 2 * 86_400_000, HOUR);
    expect(s.actionable).toBe(true);
    expect(s.urgency).toBe("soon");
    expect(s.reason).toMatch(/NET book/);
  });
  it("even a slow wallet is a PASS once the lag has eaten most of its horizon", () => {
    const s = copySignal(move, "trade-copy", 2 * HOUR, 1.8 * HOUR); // 90% gone
    expect(s.actionable).toBe(false);
    expect(s.latencyTrap).toBe(false);
    expect(s.reason).toMatch(/too late/);
  });
});

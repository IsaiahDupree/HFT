import { describe, it, expect } from "vitest";
import { reconstructRoundTrips, holdTimeStats, copyabilityScore, profileStrategy } from "@/lib/exec/strategy-profile";
import type { Fill } from "@/lib/exec/smart-money";

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const f = (coin: string, dir: string, sz: number, px: number, time: number, closedPnl = 0): Fill => ({ coin, dir, sz, px, closedPnl, time });

describe("reconstructRoundTrips — FIFO open→close matching recovers hold time", () => {
  it("matches one open to one close and computes the hold", () => {
    const trips = reconstructRoundTrips([
      f("BTC", "Open Long", 1, 60000, 0),
      f("BTC", "Close Long", 1, 61000, 6 * HOUR, 1000),
    ]);
    expect(trips).toHaveLength(1);
    expect(trips[0].holdMs).toBe(6 * HOUR);
    expect(trips[0].side).toBe("long");
    expect(trips[0].pnl).toBe(1000);
  });
  it("splits a close across two FIFO lots, allocating pnl by size", () => {
    const trips = reconstructRoundTrips([
      f("ETH", "Open Long", 1, 2000, 0),
      f("ETH", "Open Long", 1, 2010, 1 * HOUR),
      f("ETH", "Close Long", 2, 2050, 3 * HOUR, 80), // closes both lots, +$80 over 2 units
    ]);
    expect(trips).toHaveLength(2);
    expect(trips[0].holdMs).toBe(3 * HOUR);  // first lot held 3h
    expect(trips[1].holdMs).toBe(2 * HOUR);  // second lot held 2h
    expect(trips[0].pnl + trips[1].pnl).toBeCloseTo(80, 6);
  });
  it("ignores a close with no matching open (position opened before the window)", () => {
    expect(reconstructRoundTrips([f("SOL", "Close Long", 1, 150, HOUR, 50)])).toHaveLength(0);
  });
  it("keeps long and short inventory separate", () => {
    const trips = reconstructRoundTrips([
      f("BTC", "Open Long", 1, 60000, 0),
      f("BTC", "Open Short", 1, 60000, 0),
      f("BTC", "Close Short", 1, 59000, HOUR, 1000),
    ]);
    expect(trips).toHaveLength(1);
    expect(trips[0].side).toBe("short");
  });
});

describe("holdTimeStats — horizon bucketing", () => {
  const trip = (holdMs: number) => ({ coin: "X", side: "long" as const, entryTime: 0, exitTime: holdMs, holdMs, entryPx: 1, exitPx: 1, sz: 1, pnl: 0 });
  it("buckets sub-5min as scalp, hours as intraday, days as swing, weeks as position", () => {
    expect(holdTimeStats([trip(MIN), trip(2 * MIN), trip(3 * MIN)]).horizon).toBe("scalp");
    expect(holdTimeStats([trip(HOUR), trip(2 * HOUR), trip(3 * HOUR)]).horizon).toBe("intraday");
    expect(holdTimeStats([trip(DAY), trip(2 * DAY)]).horizon).toBe("swing");
    expect(holdTimeStats([trip(7 * DAY), trip(10 * DAY)]).horizon).toBe("position");
  });
});

describe("copyabilityScore — the honest gate (mechanics, not profitability)", () => {
  it("a 30-second scalper is un-copyable no matter how good", () => {
    const c = copyabilityScore({ medianHoldMs: 30_000, tradesPerDay: 300, nTrips: 5000 });
    expect(c.verdict).toBe("un-copyable");
    expect(c.score).toBeLessThan(0.25);
    expect(c.reasons.join(" ")).toMatch(/too fast|churns/);
  });
  it("a multi-hour swing trader is copyable", () => {
    const c = copyabilityScore({ medianHoldMs: 8 * HOUR, tradesPerDay: 4, nTrips: 40 });
    expect(c.verdict).toBe("copyable");
    expect(c.score).toBeGreaterThanOrEqual(0.5);
  });
  it("a great-looking wallet with too few round-trips is 'hard', not 'copyable' (low confidence)", () => {
    const c = copyabilityScore({ medianHoldMs: 8 * HOUR, tradesPerDay: 2, nTrips: 4 });
    expect(c.verdict).not.toBe("copyable");
    expect(c.reasons.join(" ")).toMatch(/low confidence/);
  });
});

describe("profileStrategy — the full reverse-engineered dossier line", () => {
  it("labels a momentum-long HYPE swing specialist as copyable", () => {
    const fills: Fill[] = [];
    for (let i = 0; i < 15; i++) {
      fills.push(f("HYPE", "Open Long", 10, 20, i * DAY));
      fills.push(f("HYPE", "Close Long", 10, 21, i * DAY + 8 * HOUR, 10)); // +$10 each, 8h holds, all long
    }
    const p = profileStrategy(fills);
    expect(p.directionality).toBe("momentum-long");
    expect(p.horizon).toBe("swing"); // 8h median hold → swing (intraday is <4h)
    expect(p.topCoin).toBe("HYPE");
    expect(p.copyability.verdict).toBe("copyable");
    expect(p.winRate).toBe(1);
    expect(p.expectancyUsd).toBeCloseTo(10, 6);
    expect(p.label).toContain("copyable");
  });
  it("labels a two-sided HFT scalper as un-copyable", () => {
    const fills: Fill[] = [];
    for (let i = 0; i < 1000; i++) {
      const long = i % 2 === 0;
      fills.push(f("BTC", long ? "Open Long" : "Open Short", 1, 60000, i * 1000));
      fills.push(f("BTC", long ? "Close Long" : "Close Short", 1, 60001, i * 1000 + 30_000, 1));
    }
    const p = profileStrategy(fills);
    expect(p.directionality).toBe("two-sided");
    expect(p.horizon).toBe("scalp");
    expect(p.copyability.verdict).toBe("un-copyable");
  });
});

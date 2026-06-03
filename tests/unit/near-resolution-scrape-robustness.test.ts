import { describe, it, expect } from "vitest";
import {
  detectNearResolutionScrape,
  type ScrapeMarket,
  type ScrapeOpportunity,
} from "@/lib/strategies/near-resolution-scrape";

/**
 * Robustness / invariant suite for the near-resolution scraper.
 *
 * Complementary to near-resolution-scrape.test.ts (happy-path cases): this file
 * stresses the gating boundaries, monotonicity, determinism, and edge/empty
 * inputs. All inputs are fixed and synthetic; a seeded LCG provides any
 * pseudo-randomness so the file is fully deterministic (no wall-clock / no RNG).
 */

// Fixed clock — never read Date.now() in any test value.
const NOW = Date.parse("2026-05-26T00:00:00Z");
const DAY = 86_400_000;
const inDays = (d: number): string => new Date(NOW + d * DAY).toISOString();

// Deterministic LCG (Numerical Recipes constants) → reproducible "noise".
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function mkt(overrides: Partial<ScrapeMarket> = {}): ScrapeMarket {
  return {
    conditionId: "0xcond1",
    title: "Will BTC reach $90K in May?",
    endDate: inDays(14),
    bestAskYes: 0.03,
    bestAskNo: 0.97,
    liquidityUsd: 10_000,
    ...overrides,
  };
}

const run = (m: Partial<ScrapeMarket>, opts = {}) =>
  detectNearResolutionScrape(mkt(m), { nowMs: NOW, ...opts });

describe("near-resolution-scrape — time-to-resolution gating", () => {
  it("returns null strictly below minDays, passes at exactly minDays", () => {
    // minDays default 1. daysToResolution = exactly the offset in days.
    expect(run({ endDate: inDays(0.5) })).toBeNull(); // 0.5 < 1
    const atBoundary = run({ endDate: inDays(1) }); // 1 is NOT < 1 → passes
    expect(atBoundary).not.toBeNull();
    expect(atBoundary!.daysToResolution).toBeCloseTo(1, 9);
  });

  it("returns null strictly above maxDays, passes at exactly maxDays", () => {
    // maxDays default 30.
    expect(run({ endDate: inDays(30.5) })).toBeNull(); // 30.5 > 30
    const atBoundary = run({ endDate: inDays(30) }); // 30 is NOT > 30 → passes
    expect(atBoundary).not.toBeNull();
    expect(atBoundary!.daysToResolution).toBeCloseTo(30, 9);
  });

  it("returns null when endDate is already in the past (negative days < minDays)", () => {
    expect(run({ endDate: inDays(-3) })).toBeNull();
  });

  it("returns null when endDate equals now (0 days < minDays default 1)", () => {
    expect(run({ endDate: inDays(0) })).toBeNull();
  });

  it("custom window can admit a same-hour market when minDays is set to 0", () => {
    const op = run({ endDate: inDays(0.25) }, { minDaysToResolution: 0 });
    expect(op).not.toBeNull();
    expect(op!.daysToResolution).toBeGreaterThan(0);
    expect(op!.daysToResolution).toBeLessThan(1);
  });

  it("custom maxDays widens the window to admit far-dated markets", () => {
    expect(run({ endDate: inDays(60) })).toBeNull(); // default max 30
    expect(run({ endDate: inDays(60) }, { maxDaysToResolution: 90 })).not.toBeNull();
  });

  it("daysToResolution carries the exact fractional offset, not a rounded day count", () => {
    const op = run({ endDate: inDays(7.5) });
    expect(op!.daysToResolution).toBeCloseTo(7.5, 9);
  });
});

describe("near-resolution-scrape — price / confidence thresholds", () => {
  it("returns null when both legs are below minPrice (no confident side)", () => {
    expect(run({ bestAskYes: 0.5, bestAskNo: 0.5 })).toBeNull();
    expect(run({ bestAskYes: 0.6, bestAskNo: 0.42 })).toBeNull();
  });

  it("passes at exactly minPrice (>= boundary is inclusive)", () => {
    const op = run({ bestAskYes: 0.04, bestAskNo: 0.95 }); // winning = 0.95 == default minPrice
    expect(op).not.toBeNull();
    expect(op!.entryPrice).toBe(0.95);
  });

  it("rejects winning price one tick below minPrice", () => {
    expect(run({ bestAskYes: 0.06, bestAskNo: 0.9499 })).toBeNull();
  });

  it("returns null on any non-positive price (zero or negative)", () => {
    expect(run({ bestAskYes: 0, bestAskNo: 0.97 })).toBeNull();
    expect(run({ bestAskYes: 0.03, bestAskNo: 0 })).toBeNull();
    expect(run({ bestAskYes: -0.1, bestAskNo: 0.97 })).toBeNull();
    expect(run({ bestAskYes: 0.97, bestAskNo: -0.05 })).toBeNull();
  });

  it("returns null when either price is >= 1 (resolved / malformed book)", () => {
    expect(run({ bestAskYes: 1, bestAskNo: 0.03 })).toBeNull();
    expect(run({ bestAskYes: 0.03, bestAskNo: 1 })).toBeNull();
    expect(run({ bestAskYes: 1.2, bestAskNo: 0.03 })).toBeNull();
  });

  it("does NOT guard against NaN prices — they slip past <=0 / >=1 and propagate", () => {
    // Documents real behavior: NaN <= 0 and NaN >= 1 are both false, so the
    // price guards do not reject NaN; the winning side carries NaN through.
    const op = run({ bestAskNo: Number.NaN });
    expect(op).not.toBeNull();
    expect(Number.isNaN(op!.edge)).toBe(true);
    expect(Number.isNaN(op!.annualizedEdge)).toBe(true);
  });

  it("custom minPrice of 0.98 rejects a 0.97 market but admits a 0.985 market", () => {
    expect(run({ bestAskNo: 0.97 }, { minPrice: 0.98 })).toBeNull();
    expect(run({ bestAskYes: 0.014, bestAskNo: 0.985 }, { minPrice: 0.98 })).not.toBeNull();
  });
});

describe("near-resolution-scrape — invalid endDate handling", () => {
  it("returns null for unparseable endDate strings", () => {
    for (const bad of ["not-a-date", "", "2026-13-99", "tomorrow"]) {
      expect(run({ endDate: bad })).toBeNull();
    }
  });
});

describe("near-resolution-scrape — side selection & edge math", () => {
  it("picks the higher leg as the winning side (NO when NO is richer)", () => {
    const op = run({ bestAskYes: 0.03, bestAskNo: 0.97 });
    expect(op!.side).toBe("NO");
    expect(op!.entryPrice).toBe(0.97);
  });

  it("picks YES when YES is the richer leg", () => {
    const op = run({ bestAskYes: 0.96, bestAskNo: 0.04 });
    expect(op!.side).toBe("YES");
    expect(op!.entryPrice).toBe(0.96);
  });

  it("breaks an exact tie in favour of YES (Math.max + === yesPrice first)", () => {
    // Both legs 0.96: winningPrice === yesPrice is checked first → YES.
    const op = run({ bestAskYes: 0.96, bestAskNo: 0.96 });
    expect(op).not.toBeNull();
    expect(op!.side).toBe("YES");
    expect(op!.entryPrice).toBe(0.96);
  });

  it("edge = (1 - entryPrice) - feeBps/10000 exactly", () => {
    const op = run({ bestAskNo: 0.97 }, { feeBps: 20 });
    expect(op!.edge).toBeCloseTo(1 - 0.97 - 0.002, 9);
  });

  it("zero fee leaves the full gross convergence as edge", () => {
    const op = run({ bestAskNo: 0.97 }, { feeBps: 0 });
    expect(op!.edge).toBeCloseTo(0.03, 9);
  });

  it("higher fee monotonically shrinks the surviving edge", () => {
    const lo = run({ bestAskNo: 0.96 }, { feeBps: 10 });
    const hi = run({ bestAskNo: 0.96 }, { feeBps: 100 });
    expect(lo).not.toBeNull();
    expect(hi).not.toBeNull();
    expect(hi!.edge).toBeLessThan(lo!.edge);
    expect(lo!.edge - hi!.edge).toBeCloseTo((100 - 10) / 10_000, 9);
  });

  it("returns null when fees clearly exceed gross convergence", () => {
    // entry 0.97 → gross convergence 0.03. A fee comfortably above 300bps drives
    // edge negative → null. (Exactly 300bps lands within float epsilon of zero,
    // so we use a margin to assert the strict <=0 rejection.)
    expect(run({ bestAskNo: 0.97 }, { feeBps: 350 })).toBeNull();
    // fee 250bps → edge 0.005 > 0 → survives
    expect(run({ bestAskNo: 0.97 }, { feeBps: 250 })).not.toBeNull();
  });

  it("returns a positive edge for every opportunity it surfaces", () => {
    const rnd = lcg(12345);
    for (let i = 0; i < 200; i++) {
      const no = 0.9 + rnd() * 0.099; // 0.90..0.999
      const op = run({ bestAskYes: +(1 - no).toFixed(4), bestAskNo: +no.toFixed(4) });
      if (op) {
        expect(op.edge).toBeGreaterThan(0);
        expect(op.entryPrice).toBeGreaterThanOrEqual(0.95);
      }
    }
  });
});

describe("near-resolution-scrape — annualized edge invariants", () => {
  it("annualizedEdge = (edge / entryPrice) * (365 / daysToResolution)", () => {
    const op = run({});
    const expected = (op!.edge / op!.entryPrice) * (365 / op!.daysToResolution);
    expect(op!.annualizedEdge).toBeCloseTo(expected, 9);
  });

  it("is strictly positive whenever an opportunity is returned", () => {
    const op = run({});
    expect(op!.annualizedEdge).toBeGreaterThan(0);
  });

  it("is inversely monotonic in days-to-resolution (shorter hold → higher annualized)", () => {
    const fast = run({ endDate: inDays(2) });
    const slow = run({ endDate: inDays(20) });
    expect(fast!.annualizedEdge).toBeGreaterThan(slow!.annualizedEdge);
    // exact 10x ratio in days → ~10x ratio in annualized (same edge/price).
    expect(fast!.annualizedEdge / slow!.annualizedEdge).toBeCloseTo(10, 6);
  });

  it("scales linearly with days: halving the window doubles annualized edge", () => {
    const long = run({ endDate: inDays(28) });
    const half = run({ endDate: inDays(14) });
    expect(half!.annualizedEdge / long!.annualizedEdge).toBeCloseTo(2, 6);
  });
});

describe("near-resolution-scrape — passthrough & shape", () => {
  it("passes conditionId, title, and liquidity straight through", () => {
    const op = run({ conditionId: "0xABCDEF", title: "Custom?", liquidityUsd: 777_777 });
    expect(op!.conditionId).toBe("0xABCDEF");
    expect(op!.title).toBe("Custom?");
    expect(op!.liquidityUsd).toBe(777_777);
  });

  it("title may be omitted (optional) and surfaces as undefined", () => {
    const m = mkt();
    delete (m as Partial<ScrapeMarket>).title;
    const op = detectNearResolutionScrape(m, { nowMs: NOW });
    expect(op).not.toBeNull();
    expect(op!.title).toBeUndefined();
  });

  it("reason string encodes side, rounded price, days, and edge", () => {
    const op = run({ bestAskNo: 0.97, endDate: inDays(14) });
    expect(op!.reason).toContain("NO @ 0.970");
    expect(op!.reason).toContain("14.0d");
    expect(op!.reason).toContain("edge");
    expect(op!.reason).toContain("annualized");
  });

  it("every numeric output field is finite for a valid opportunity", () => {
    const op = run({}) as ScrapeOpportunity;
    for (const v of [op.entryPrice, op.edge, op.annualizedEdge, op.daysToResolution, op.liquidityUsd]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("near-resolution-scrape — determinism & purity", () => {
  it("is deterministic: identical inputs yield deep-equal opportunities", () => {
    const a = run({});
    const b = run({});
    expect(a).toEqual(b);
  });

  it("does not mutate the input market object", () => {
    const m = mkt();
    const snapshot = JSON.parse(JSON.stringify(m));
    detectNearResolutionScrape(m, { nowMs: NOW });
    expect(m).toEqual(snapshot);
  });

  it("is stable across a deterministic sweep of synthetic markets", () => {
    const rnd = lcg(987654321);
    const first: (ScrapeOpportunity | null)[] = [];
    for (let i = 0; i < 50; i++) {
      const no = +(0.9 + rnd() * 0.09).toFixed(4);
      const days = 1 + Math.floor(rnd() * 25);
      first.push(run({ bestAskYes: +(1 - no).toFixed(4), bestAskNo: no, endDate: inDays(days) }));
    }
    // Replay with the same seed → identical sequence.
    const rnd2 = lcg(987654321);
    for (let i = 0; i < 50; i++) {
      const no = +(0.9 + rnd2() * 0.09).toFixed(4);
      const days = 1 + Math.floor(rnd2() * 25);
      const again = run({ bestAskYes: +(1 - no).toFixed(4), bestAskNo: no, endDate: inDays(days) });
      expect(again).toEqual(first[i]);
    }
  });
});

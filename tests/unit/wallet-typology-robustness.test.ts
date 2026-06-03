/**
 * Robustness / invariant / edge-case tests for the wallet typology classifier.
 *
 * Complementary to tests/unit/wallet-typology.test.ts (which covers the seven
 * archetypal happy-path classifications). This file instead pins down the
 * INVARIANTS the classifier must always hold regardless of input — feature-
 * extraction math, candidate ordering, the bucket→copyability mapping,
 * determinism, boundary behavior, and degenerate/empty inputs.
 *
 * Everything here is constructed from pure synthetic fixtures. No DB, no
 * network, no files, no wall-clock, no RNG except a small fixed-seed LCG used
 * to fuzz inputs deterministically.
 */
import { describe, expect, it } from "vitest";
import {
  classifyWalletTypology,
  type WalletTypologyInput,
  type WalletTypology,
  type WalletTypologyBucket,
  type CopyabilityClass,
} from "@/lib/wallets/typology";
import type { WalletFingerprint } from "@/lib/wallets/fingerprint";
import type { CopyabilityReport } from "@/lib/wallets/copyability";

// --- Fixtures -------------------------------------------------------------

function fpStub(overrides: Partial<WalletFingerprint> = {}): WalletFingerprint {
  return {
    proxyWallet: "0xtest",
    sampledTrades: 100,
    sampledOpenPositions: 5,
    sampledClosedPositions: 50,
    distinctConditionIds: 50,
    windowDays: 30,
    tradesPerHourMean: 0.14,
    interTradeMedianSec: 3600,
    interTradeStdevSec: 1800,
    cadenceBotScore: 0.1,
    avgTradeUsd: 1000,
    medianTradeUsd: 800,
    maxTradeUsd: 10_000,
    sizeBuckets: { lt10: 0, lt100: 5, lt1000: 30, gt1000: 65 },
    topEventSlugs: [],
    topTitles: [],
    cryptoPct: 0.2,
    concentrationPct: 0.3,
    avgEntryPrice: 0.5,
    midpointEntryPct: 0.4,
    tailEntryPct: 0.1,
    correlatedBasketCohorts: 0,
    correlatedBasketExamples: [],
    hourlyHistogram: new Array(24).fill(0),
    peakHourUtc: 14,
    peakHourConcentrationPct: 0.3,
    realizedPnlUsd: null,
    winRate: null,
    strategyFamily: "generalist",
    classificationReasons: [],
    caveats: [],
    ...overrides,
  };
}

function copyStub(overrides: Partial<CopyabilityReport> = {}): CopyabilityReport {
  return {
    wallet: "0xtest",
    observedClosed: 50,
    observedTrades: 100,
    winRate: 0.6,
    avgPnlUsd: 100,
    medianPnlUsd: 80,
    pnlStdevUsd: 200,
    totalPnlUsd: 5000,
    largestWinUsd: 1000,
    largestLossUsd: -500,
    medianHoldMinutes: 60,
    copyabilityScore: 50,
    caveats: [],
    ...overrides,
  };
}

function input(over: Partial<WalletTypologyInput> = {}): WalletTypologyInput {
  return {
    wallet: over.wallet ?? "0xtest",
    fingerprint: over.fingerprint ?? fpStub(),
    copyability: over.copyability ?? copyStub(),
    portfolioValueUsd: over.portfolioValueUsd,
  };
}

// The full closed set of bucket labels and their authoritative copyability map.
// This mirrors COPYABILITY_BY_BUCKET inside the module; the tests below assert
// the classifier's output never disagrees with it.
const COPYABILITY_BY_BUCKET: Record<WalletTypologyBucket, CopyabilityClass> = {
  hft_bot: "un_copyable",
  conviction_trader: "potentially_copyable",
  market_mover_whale: "un_copyable",
  mid_run_gambler: "needs_verification",
  insider_pattern: "flagged_high_risk",
  retail: "uninteresting",
  unclear: "needs_more_data",
};

const ALL_BUCKETS = Object.keys(COPYABILITY_BY_BUCKET) as WalletTypologyBucket[];

// Small deterministic LCG (Numerical Recipes constants) for repeatable fuzzing.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000; // [0,1)
  };
}

// A spread of archetypal inputs that each fire a different bucket. Used by the
// invariant tests to assert properties across the whole bucket space.
function archetypes(): Array<{ name: string; input: WalletTypologyInput }> {
  return [
    {
      name: "hft_bot",
      input: input({
        fingerprint: fpStub({
          sampledTrades: 15_000,
          distinctConditionIds: 12_000,
          windowDays: 30,
          medianTradeUsd: 5,
          avgTradeUsd: 8,
          sizeBuckets: { lt10: 14_000, lt100: 1_000, lt1000: 0, gt1000: 0 },
          cryptoPct: 0.95,
        }),
      }),
    },
    {
      name: "market_mover_whale",
      input: input({
        fingerprint: fpStub({
          sampledTrades: 100,
          windowDays: 30,
          medianTradeUsd: 8_000,
          avgTradeUsd: 12_000,
          sizeBuckets: { lt10: 0, lt100: 0, lt1000: 10, gt1000: 90 },
        }),
        copyability: copyStub({ observedClosed: 30, winRate: 0.5, totalPnlUsd: 1_000 }),
      }),
    },
    {
      name: "mid_run_gambler",
      input: input({
        fingerprint: fpStub({
          sampledTrades: 50,
          windowDays: 30,
          medianTradeUsd: 1000,
          avgTradeUsd: 1500,
          sizeBuckets: { lt10: 0, lt100: 0, lt1000: 20, gt1000: 30 },
        }),
        copyability: copyStub({ observedClosed: 10, winRate: 0.5, totalPnlUsd: 1_000 }),
        portfolioValueUsd: 500_000,
      }),
    },
    {
      name: "insider_pattern",
      input: input({
        fingerprint: fpStub({
          sampledTrades: 50,
          windowDays: 60,
          medianTradeUsd: 5_000,
          avgTradeUsd: 7_000,
          sizeBuckets: { lt10: 0, lt100: 0, lt1000: 5, gt1000: 45 },
        }),
        copyability: copyStub({ observedClosed: 40, winRate: 0.85, totalPnlUsd: 80_000 }),
        portfolioValueUsd: 50_000,
      }),
    },
    {
      name: "retail",
      input: input({
        fingerprint: fpStub({
          sampledTrades: 5,
          windowDays: 30,
          medianTradeUsd: 5,
          avgTradeUsd: 8,
          sizeBuckets: { lt10: 4, lt100: 1, lt1000: 0, gt1000: 0 },
        }),
        copyability: copyStub({ observedClosed: 2, winRate: 0.5, totalPnlUsd: 20 }),
        portfolioValueUsd: 50,
      }),
    },
    {
      name: "unclear",
      input: input({
        fingerprint: fpStub({
          sampledTrades: 30,
          windowDays: 30,
          medianTradeUsd: 200,
          avgTradeUsd: 300,
          sizeBuckets: { lt10: 0, lt100: 10, lt1000: 20, gt1000: 0 },
        }),
        copyability: copyStub({ observedClosed: 10, winRate: 0.5, totalPnlUsd: 100 }),
      }),
    },
  ];
}

// =========================================================================
// Structural invariants — hold for EVERY result regardless of bucket.
// =========================================================================
describe("classifyWalletTypology — structural invariants", () => {
  it("always returns at least one candidate", () => {
    for (const { input: inp } of archetypes()) {
      const t = classifyWalletTypology(inp);
      expect(t.candidates.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("candidates are sorted by weight descending", () => {
    for (const { input: inp } of archetypes()) {
      const t = classifyWalletTypology(inp);
      for (let i = 1; i < t.candidates.length; i++) {
        expect(t.candidates[i - 1].weight).toBeGreaterThanOrEqual(t.candidates[i].weight);
      }
    }
  });

  it("primaryBucket equals the top (max-weight) candidate's bucket", () => {
    for (const { input: inp } of archetypes()) {
      const t = classifyWalletTypology(inp);
      expect(t.primaryBucket).toBe(t.candidates[0].bucket);
    }
  });

  it("confidence equals the winning candidate's weight", () => {
    for (const { input: inp } of archetypes()) {
      const t = classifyWalletTypology(inp);
      expect(t.confidence).toBe(t.candidates[0].weight);
    }
  });

  it("confidence is within (0, 1] for every result", () => {
    for (const { input: inp } of archetypes()) {
      const t = classifyWalletTypology(inp);
      expect(t.confidence).toBeGreaterThan(0);
      expect(t.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("copyabilityClass is exactly the mapping of primaryBucket (no drift)", () => {
    for (const { input: inp } of archetypes()) {
      const t = classifyWalletTypology(inp);
      expect(t.copyabilityClass).toBe(COPYABILITY_BY_BUCKET[t.primaryBucket]);
    }
  });

  it("primaryBucket is always one of the seven known buckets", () => {
    for (const { input: inp } of archetypes()) {
      const t = classifyWalletTypology(inp);
      expect(ALL_BUCKETS).toContain(t.primaryBucket);
    }
  });

  it("every candidate bucket is a known bucket and every weight in (0,1]", () => {
    for (const { input: inp } of archetypes()) {
      const t = classifyWalletTypology(inp);
      for (const c of t.candidates) {
        expect(ALL_BUCKETS).toContain(c.bucket);
        expect(c.weight).toBeGreaterThan(0);
        expect(c.weight).toBeLessThanOrEqual(1);
        expect(typeof c.reason).toBe("string");
        expect(c.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("echoes the wallet address straight through", () => {
    const t = classifyWalletTypology(input({ wallet: "0xDEADBEEF" }));
    expect(t.wallet).toBe("0xDEADBEEF");
  });
});

// =========================================================================
// Determinism — same input → same output, no hidden state / clock / RNG.
// =========================================================================
describe("classifyWalletTypology — determinism", () => {
  it("produces byte-identical results across repeated calls", () => {
    for (const { input: inp } of archetypes()) {
      const a = classifyWalletTypology(inp);
      const b = classifyWalletTypology(inp);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it("does not mutate the input object", () => {
    const inp = input({ portfolioValueUsd: 500_000 });
    const snapshot = JSON.stringify(inp);
    classifyWalletTypology(inp);
    expect(JSON.stringify(inp)).toBe(snapshot);
  });

  it("is stable under a deterministic fuzz of size/cadence inputs", () => {
    const rnd = lcg(0xC0FFEE);
    for (let i = 0; i < 40; i++) {
      const inp = input({
        fingerprint: fpStub({
          sampledTrades: Math.floor(rnd() * 5000) + 1,
          distinctConditionIds: Math.floor(rnd() * 4000) + 1,
          windowDays: Math.floor(rnd() * 90) + 1,
          medianTradeUsd: Math.floor(rnd() * 9000),
          avgTradeUsd: Math.floor(rnd() * 12000),
          sizeBuckets: {
            lt10: Math.floor(rnd() * 100),
            lt100: Math.floor(rnd() * 100),
            lt1000: Math.floor(rnd() * 100),
            gt1000: Math.floor(rnd() * 100),
          },
        }),
        copyability: copyStub({
          observedClosed: Math.floor(rnd() * 300),
          winRate: rnd(),
          totalPnlUsd: Math.floor(rnd() * 200000) - 50000,
        }),
        portfolioValueUsd: rnd() < 0.5 ? null : Math.floor(rnd() * 1_000_000),
      });
      const a = classifyWalletTypology(inp);
      const b = classifyWalletTypology(inp);
      expect(a.primaryBucket).toBe(b.primaryBucket);
      expect(a.confidence).toBe(b.confidence);
      // Whatever the bucket, the mapping must hold for the fuzzed case too.
      expect(a.copyabilityClass).toBe(COPYABILITY_BY_BUCKET[a.primaryBucket]);
      // And the structural sort invariant must survive arbitrary inputs.
      for (let k = 1; k < a.candidates.length; k++) {
        expect(a.candidates[k - 1].weight).toBeGreaterThanOrEqual(a.candidates[k].weight);
      }
    }
  });
});

// =========================================================================
// Feature-extraction math — the derived features must be exact.
// =========================================================================
describe("classifyWalletTypology — feature extraction math", () => {
  it("tradesPerDay = sampledTrades / windowDays", () => {
    const t = classifyWalletTypology(
      input({ fingerprint: fpStub({ sampledTrades: 300, windowDays: 30 }) }),
    );
    expect(t.features.tradesPerDay).toBeCloseTo(10, 10);
  });

  it("tradesPerDay is 0 when windowDays is null", () => {
    const t = classifyWalletTypology(
      input({ fingerprint: fpStub({ sampledTrades: 300, windowDays: null }) }),
    );
    expect(t.features.tradesPerDay).toBe(0);
  });

  it("tradesPerDay is 0 when windowDays is 0 (no divide-by-zero blowup)", () => {
    const t = classifyWalletTypology(
      input({ fingerprint: fpStub({ sampledTrades: 300, windowDays: 0 }) }),
    );
    expect(t.features.tradesPerDay).toBe(0);
    expect(Number.isFinite(t.features.tradesPerDay)).toBe(true);
  });

  it("distinctMarketsPerDay = distinctConditionIds / windowDays", () => {
    const t = classifyWalletTypology(
      input({ fingerprint: fpStub({ distinctConditionIds: 600, windowDays: 30 }) }),
    );
    expect(t.features.distinctMarketsPerDay).toBeCloseTo(20, 10);
  });

  it("fillsPerMarket = sampledTrades / distinctConditionIds", () => {
    const t = classifyWalletTypology(
      input({ fingerprint: fpStub({ sampledTrades: 1000, distinctConditionIds: 8 }) }),
    );
    expect(t.features.fillsPerMarket).toBeCloseTo(125, 10);
  });

  it("fillsPerMarket is 0 when no distinct markets (avoids divide-by-zero)", () => {
    const t = classifyWalletTypology(
      input({ fingerprint: fpStub({ sampledTrades: 50, distinctConditionIds: 0 }) }),
    );
    expect(t.features.fillsPerMarket).toBe(0);
  });

  it("largeTradeShare = gt1000 / total sized buckets", () => {
    const t = classifyWalletTypology(
      input({
        fingerprint: fpStub({ sizeBuckets: { lt10: 10, lt100: 10, lt1000: 30, gt1000: 50 } }),
      }),
    );
    expect(t.features.largeTradeShare).toBeCloseTo(0.5, 10);
  });

  it("largeTradeShare is 0 when no sized trades exist", () => {
    const t = classifyWalletTypology(
      input({
        fingerprint: fpStub({ sizeBuckets: { lt10: 0, lt100: 0, lt1000: 0, gt1000: 0 } }),
      }),
    );
    expect(t.features.largeTradeShare).toBe(0);
  });

  it("positionsCount = open + closed positions", () => {
    const t = classifyWalletTypology(
      input({
        fingerprint: fpStub({ sampledOpenPositions: 7, sampledClosedPositions: 13 }),
      }),
    );
    expect(t.features.positionsCount).toBe(20);
  });

  it("passes through fingerprint/copyability scalars unchanged", () => {
    const t = classifyWalletTypology(
      input({
        fingerprint: fpStub({
          medianTradeUsd: 777,
          avgTradeUsd: 888,
          concentrationPct: 0.42,
          cryptoPct: 0.66,
          sampledTrades: 123,
          windowDays: 17.5,
        }),
        copyability: copyStub({ winRate: 0.71, totalPnlUsd: 31_415 }),
      }),
    );
    expect(t.features.medianTradeUsd).toBe(777);
    expect(t.features.avgTradeUsd).toBe(888);
    expect(t.features.concentrationPct).toBe(0.42);
    expect(t.features.cryptoPct).toBe(0.66);
    expect(t.features.sampleSize).toBe(123);
    expect(t.features.windowDays).toBe(17.5);
    expect(t.features.winRate).toBe(0.71);
    expect(t.features.realizedPnlUsd).toBe(31_415);
  });

  it("realizedPnlUsd falls back to 0 when copyability.totalPnlUsd is null", () => {
    const t = classifyWalletTypology(
      input({ copyability: { ...copyStub(), totalPnlUsd: null as unknown as number } }),
    );
    expect(t.features.realizedPnlUsd).toBe(0);
  });
});

// =========================================================================
// mtmToRealizedRatio — the three-way branch (number | Infinity | null).
// =========================================================================
describe("classifyWalletTypology — mtmToRealizedRatio branches", () => {
  it("is portfolio / abs(realized) when both are present and pnl != 0", () => {
    const t = classifyWalletTypology(
      input({
        copyability: copyStub({ totalPnlUsd: -20_000 }),
        portfolioValueUsd: 200_000,
      }),
    );
    expect(t.features.mtmToRealizedRatio).toBeCloseTo(10, 10); // 200k / |−20k|
  });

  it("uses absolute value of realized PnL (sign-independent magnitude)", () => {
    const pos = classifyWalletTypology(
      input({ copyability: copyStub({ totalPnlUsd: 25_000 }), portfolioValueUsd: 100_000 }),
    ).features.mtmToRealizedRatio;
    const neg = classifyWalletTypology(
      input({ copyability: copyStub({ totalPnlUsd: -25_000 }), portfolioValueUsd: 100_000 }),
    ).features.mtmToRealizedRatio;
    expect(pos).toBe(neg);
    expect(pos).toBeCloseTo(4, 10);
  });

  it("is Infinity when portfolio > 0 but realized PnL is exactly 0", () => {
    const t = classifyWalletTypology(
      input({ copyability: copyStub({ totalPnlUsd: 0 }), portfolioValueUsd: 80_000 }),
    );
    expect(t.features.mtmToRealizedRatio).toBe(Infinity);
  });

  it("is null when portfolio value is unknown (cannot compute ratio)", () => {
    const t = classifyWalletTypology(
      input({ copyability: copyStub({ totalPnlUsd: 0 }), portfolioValueUsd: null }),
    );
    expect(t.features.mtmToRealizedRatio).toBeNull();
  });

  it("is null when portfolio is 0 and realized PnL is 0 (no signal at all)", () => {
    const t = classifyWalletTypology(
      input({ copyability: copyStub({ totalPnlUsd: 0 }), portfolioValueUsd: 0 }),
    );
    expect(t.features.mtmToRealizedRatio).toBeNull();
  });

  it("the Infinity branch fires the all-unresolved mid_run_gambler candidate when book > $50k", () => {
    const t = classifyWalletTypology(
      input({
        fingerprint: fpStub({ sampledTrades: 40, windowDays: 30, avgTradeUsd: 2_000 }),
        copyability: copyStub({ observedClosed: 8, winRate: 0.5, totalPnlUsd: 0 }),
        portfolioValueUsd: 120_000,
      }),
    );
    expect(t.features.mtmToRealizedRatio).toBe(Infinity);
    expect(t.candidates.some((c) => c.bucket === "mid_run_gambler")).toBe(true);
  });
});

// =========================================================================
// Monotonicity / boundary behavior between buckets.
// =========================================================================
describe("classifyWalletTypology — boundaries & monotonicity", () => {
  it("mid_run_gambler requires the MTM/realized ratio to reach the >=5 threshold", () => {
    // ratio = 4 (below threshold) → no gambler candidate from the finite branch.
    const below = classifyWalletTypology(
      input({
        fingerprint: fpStub({ sampledTrades: 50, windowDays: 30, avgTradeUsd: 1_500 }),
        copyability: copyStub({ observedClosed: 10, totalPnlUsd: 25_000, winRate: 0.5 }),
        portfolioValueUsd: 100_000, // 100k / 25k = 4.0
      }),
    );
    expect(below.features.mtmToRealizedRatio).toBeCloseTo(4, 10);
    expect(below.candidates.some((c) => c.bucket === "mid_run_gambler")).toBe(false);

    // ratio = 5 (at threshold) → gambler candidate present.
    const at = classifyWalletTypology(
      input({
        fingerprint: fpStub({ sampledTrades: 50, windowDays: 30, avgTradeUsd: 1_500 }),
        copyability: copyStub({ observedClosed: 10, totalPnlUsd: 20_000, winRate: 0.5 }),
        portfolioValueUsd: 100_000, // 100k / 20k = 5.0
      }),
    );
    expect(at.features.mtmToRealizedRatio).toBeCloseTo(5, 10);
    expect(at.candidates.some((c) => c.bucket === "mid_run_gambler")).toBe(true);
  });

  it("market_mover_whale requires BOTH avgTrade >= $5k AND largeTradeShare >= 0.5", () => {
    // Big avg but only 40% large → no whale candidate.
    const lowShare = classifyWalletTypology(
      input({
        fingerprint: fpStub({
          avgTradeUsd: 9_000,
          sizeBuckets: { lt10: 0, lt100: 0, lt1000: 60, gt1000: 40 },
        }),
      }),
    );
    expect(lowShare.candidates.some((c) => c.bucket === "market_mover_whale")).toBe(false);

    // Big avg AND >=50% large → whale candidate present.
    const highShare = classifyWalletTypology(
      input({
        fingerprint: fpStub({
          avgTradeUsd: 9_000,
          sizeBuckets: { lt10: 0, lt100: 0, lt1000: 40, gt1000: 60 },
        }),
      }),
    );
    expect(highShare.candidates.some((c) => c.bucket === "market_mover_whale")).toBe(true);
  });

  it("the orderbook-scraper guard suppresses hft_bot even at very high cadence", () => {
    // 1000 fills on 8 markets/day → fillsPerMarket high, distinctMarkets low → scraper.
    const t = classifyWalletTypology(
      input({
        fingerprint: fpStub({
          sampledTrades: 1000,
          distinctConditionIds: 8,
          windowDays: 1,
          medianTradeUsd: 50,
          avgTradeUsd: 150,
          sizeBuckets: { lt10: 0, lt100: 200, lt1000: 700, gt1000: 100 },
        }),
      }),
    );
    expect(t.primaryBucket).not.toBe("hft_bot");
    expect(t.caveats.some((c) => c.includes("orderbook scraping"))).toBe(true);
  });

  it("conviction_trader confidence is higher when sampleSize >= 50 than under that threshold", () => {
    // The conviction rules key off `features.sampleSize`, which is the
    // fingerprint's sampledTrades (NOT copyability.observedClosed). The strong
    // path needs sampleSize >= 50 + winRate >= 0.55 + positive PnL; the weak
    // path fires at sampleSize < 50 with the low (0.4) weight. We hold the
    // copyability/PnL gates fixed and only move sampledTrades across 50 to
    // isolate the threshold effect on weight.
    const copyability = copyStub({ observedClosed: 120, winRate: 0.6, totalPnlUsd: 50_000 });
    const fpAt = (sampledTrades: number) =>
      fpStub({
        sampledTrades,
        windowDays: 60,
        avgTradeUsd: 2_000,
        medianTradeUsd: 1_500,
        sizeBuckets: { lt10: 0, lt100: 0, lt1000: 50, gt1000: 150 },
      });
    const strong = classifyWalletTypology(input({ fingerprint: fpAt(60), copyability }));
    const weak = classifyWalletTypology(input({ fingerprint: fpAt(40), copyability }));
    const strongConv = strong.candidates.find((c) => c.bucket === "conviction_trader");
    const weakConv = weak.candidates.find((c) => c.bucket === "conviction_trader");
    expect(strongConv).toBeDefined();
    expect(weakConv).toBeDefined();
    expect(strongConv!.weight).toBe(0.85);
    expect(weakConv!.weight).toBe(0.4);
    expect(strongConv!.weight).toBeGreaterThan(weakConv!.weight);
  });
});

// =========================================================================
// Caveats & resolution plan — the "what would resolve this" contract.
// =========================================================================
describe("classifyWalletTypology — caveats & resolution plan", () => {
  it("unknown portfolio stamps a caveat and a poly.userValue resolution step", () => {
    const t = classifyWalletTypology(input({ portfolioValueUsd: null }));
    expect(t.features.portfolioValueUsd).toBeNull();
    expect(t.caveats.some((c) => c.includes("portfolio value unknown"))).toBe(true);
    expect(t.resolutionPlan.some((p) => p.includes("poly.userValue"))).toBe(true);
  });

  it("small sample (N<30) and short window (<14d) each stamp a caveat", () => {
    const t = classifyWalletTypology(
      input({ fingerprint: fpStub({ sampledTrades: 12, windowDays: 7 }) }),
    );
    expect(t.caveats.some((c) => c.includes("small sample"))).toBe(true);
    expect(t.caveats.some((c) => c.includes("short observation window"))).toBe(true);
  });

  it("does NOT stamp small-sample caveat at exactly N=30", () => {
    const t = classifyWalletTypology(
      input({ fingerprint: fpStub({ sampledTrades: 30, windowDays: 30 }) }),
    );
    expect(t.caveats.some((c) => c.includes("small sample"))).toBe(false);
  });

  it("does NOT stamp short-window caveat at exactly windowDays=14", () => {
    const t = classifyWalletTypology(
      input({ fingerprint: fpStub({ sampledTrades: 100, windowDays: 14 }) }),
    );
    expect(t.caveats.some((c) => c.includes("short observation window"))).toBe(false);
  });

  it("fewer than 5 observed closes stamps the unreliable-signals caveat", () => {
    const t = classifyWalletTypology(
      input({ copyability: copyStub({ observedClosed: 4 }) }),
    );
    expect(t.caveats.some((c) => c.includes("fewer than 5 closed positions"))).toBe(true);
  });

  it("unclear fallback always ships a resolution step to gather more data", () => {
    const t = classifyWalletTypology(
      input({
        fingerprint: fpStub({
          sampledTrades: 30,
          windowDays: 30,
          medianTradeUsd: 200,
          avgTradeUsd: 300,
          sizeBuckets: { lt10: 0, lt100: 10, lt1000: 20, gt1000: 0 },
        }),
        copyability: copyStub({ observedClosed: 10, winRate: 0.5, totalPnlUsd: 100 }),
      }),
    );
    expect(t.primaryBucket).toBe("unclear");
    expect(t.resolutionPlan.some((p) => p.includes("Insufficient signal"))).toBe(true);
  });

  it("caveats and resolutionPlan are always string arrays", () => {
    for (const { input: inp } of archetypes()) {
      const t = classifyWalletTypology(inp);
      expect(Array.isArray(t.caveats)).toBe(true);
      expect(Array.isArray(t.resolutionPlan)).toBe(true);
      for (const c of [...t.caveats, ...t.resolutionPlan]) {
        expect(typeof c).toBe("string");
      }
    }
  });
});

// =========================================================================
// Degenerate / empty inputs — must not throw or emit NaN/non-finite features.
// =========================================================================
describe("classifyWalletTypology — degenerate & empty inputs", () => {
  function assertFiniteFeatures(t: WalletTypology) {
    const f = t.features;
    for (const v of [
      f.tradesPerDay,
      f.distinctMarketsPerDay,
      f.fillsPerMarket,
      f.medianTradeUsd,
      f.avgTradeUsd,
      f.sampleSize,
      f.positionsCount,
      f.realizedPnlUsd,
      f.largeTradeShare,
      f.concentrationPct,
      f.cryptoPct,
    ]) {
      expect(Number.isNaN(v)).toBe(false);
    }
    // mtmToRealizedRatio may legitimately be Infinity or null; just not NaN.
    if (f.mtmToRealizedRatio != null) {
      expect(Number.isNaN(f.mtmToRealizedRatio)).toBe(false);
    }
  }

  it("classifies an all-zero wallet as unclear without throwing", () => {
    const t = classifyWalletTypology(
      input({
        fingerprint: fpStub({
          sampledTrades: 0,
          sampledOpenPositions: 0,
          sampledClosedPositions: 0,
          distinctConditionIds: 0,
          windowDays: null,
          medianTradeUsd: 0,
          avgTradeUsd: 0,
          sizeBuckets: { lt10: 0, lt100: 0, lt1000: 0, gt1000: 0 },
          concentrationPct: 0,
          cryptoPct: 0,
        }),
        copyability: copyStub({
          observedClosed: 0,
          winRate: null,
          totalPnlUsd: 0,
        }),
        portfolioValueUsd: null,
      }),
    );
    // Tiny avg + sub-1 cadence + no portfolio matches the retail rule; either
    // way it must resolve to a known bucket and stay finite.
    expect(ALL_BUCKETS).toContain(t.primaryBucket);
    assertFiniteFeatures(t);
  });

  it("handles a null winRate (no closes) without crashing the insider/conviction rules", () => {
    const t = classifyWalletTypology(
      input({
        fingerprint: fpStub({
          sampledTrades: 60,
          windowDays: 30,
          avgTradeUsd: 6_000,
          medianTradeUsd: 5_000,
          sizeBuckets: { lt10: 0, lt100: 0, lt1000: 10, gt1000: 50 },
        }),
        copyability: copyStub({ observedClosed: 0, winRate: null, totalPnlUsd: 0 }),
        portfolioValueUsd: 60_000,
      }),
    );
    expect(t.features.winRate).toBeNull();
    // winRate-gated buckets (insider/conviction-strong) must NOT fire on null.
    expect(t.candidates.some((c) => c.bucket === "insider_pattern")).toBe(false);
    expect(ALL_BUCKETS).toContain(t.primaryBucket);
  });

  it("keeps features finite under the deterministic fuzz", () => {
    const rnd = lcg(0x1234);
    for (let i = 0; i < 30; i++) {
      const t = classifyWalletTypology(
        input({
          fingerprint: fpStub({
            sampledTrades: Math.floor(rnd() * 3000),
            distinctConditionIds: Math.floor(rnd() * 2000),
            windowDays: rnd() < 0.2 ? null : Math.floor(rnd() * 60) + 1,
            medianTradeUsd: Math.floor(rnd() * 8000),
            avgTradeUsd: Math.floor(rnd() * 10000),
            sizeBuckets: {
              lt10: Math.floor(rnd() * 50),
              lt100: Math.floor(rnd() * 50),
              lt1000: Math.floor(rnd() * 50),
              gt1000: Math.floor(rnd() * 50),
            },
          }),
          copyability: copyStub({
            observedClosed: Math.floor(rnd() * 200),
            winRate: rnd() < 0.15 ? null : rnd(),
            totalPnlUsd: Math.floor(rnd() * 100000) - 30000,
          }),
          portfolioValueUsd: rnd() < 0.4 ? null : Math.floor(rnd() * 800000),
        }),
      );
      assertFiniteFeatures(t);
      expect(ALL_BUCKETS).toContain(t.primaryBucket);
      expect(t.copyabilityClass).toBe(COPYABILITY_BY_BUCKET[t.primaryBucket]);
    }
  });
});

/**
 * Unit tests for BS implied prob + realized vol + the cross-venue context
 * enrichment. Math validated against known closed-form cases.
 */
import { describe, expect, it } from "vitest";
import { bsProbAboveStrike, normalCdf, realizedVolFromMidpoints, computeCrossVenueImpliedProbs } from "@/lib/arena/cross-venue";

describe("normalCdf", () => {
  it.each([
    [0, 0.5],
    [1.96, 0.9750],     // 95% two-sided crit
    [-1.96, 0.0250],
    [1.0, 0.8413],
    [-1.0, 0.1587],
    [2.5758, 0.9950],   // 99% two-sided crit
  ])("normalCdf(%f) ≈ %f", (x, expected) => {
    expect(normalCdf(x)).toBeCloseTo(expected, 3);
  });
});

describe("bsProbAboveStrike", () => {
  it("at-the-money, drift = vol²/2 → prob ≈ 0.5", () => {
    // When r = σ²/2, the drift term vanishes in d2, so P(S_T > S_0) → N(0) = 0.5.
    const spot = 100, strike = 100, T = 1, sigma = 0.30;
    const r = 0.5 * sigma * sigma;
    expect(bsProbAboveStrike(spot, strike, T, sigma, r)).toBeCloseTo(0.5, 3);
  });
  it("deep ITM (S₀ >> K) → prob ≈ 1", () => {
    expect(bsProbAboveStrike(200, 100, 1, 0.30, 0.04)).toBeGreaterThan(0.95);
  });
  it("deep OTM (S₀ << K) → prob ≈ 0", () => {
    expect(bsProbAboveStrike(50, 100, 1, 0.30, 0.04)).toBeLessThan(0.05);
  });
  it("returns NaN on degenerate inputs", () => {
    expect(Number.isNaN(bsProbAboveStrike(0, 100, 1, 0.3))).toBe(true);
    expect(Number.isNaN(bsProbAboveStrike(100, 0, 1, 0.3))).toBe(true);
    expect(Number.isNaN(bsProbAboveStrike(100, 100, 0, 0.3))).toBe(true);
    expect(Number.isNaN(bsProbAboveStrike(100, 100, 1, 0))).toBe(true);
  });
});

describe("realizedVolFromMidpoints", () => {
  it("constant prices → vol = 0", () => {
    expect(realizedVolFromMidpoints([100, 100, 100, 100, 100])).toBe(0);
  });
  it("known 1% daily log-return series → ≈ 0.01 × √252", () => {
    // Series with constant +1% daily log-return: std should be near 0 (no variance).
    // Use alternating ±1% for non-zero std.
    const prices = [100];
    for (let i = 1; i < 30; i++) prices.push(prices[i - 1] * Math.exp(i % 2 === 0 ? 0.01 : -0.01));
    const v = realizedVolFromMidpoints(prices);
    expect(v).toBeGreaterThan(0.10);
    expect(v).toBeLessThan(0.25);
  });
  it("returns NaN with insufficient data", () => {
    expect(Number.isNaN(realizedVolFromMidpoints([]))).toBe(true);
    expect(Number.isNaN(realizedVolFromMidpoints([100, 101]))).toBe(true);
  });
});

import { vi, beforeEach, afterEach } from "vitest";
import { makeMemoryDb } from "../helpers/db";

let memDb: ReturnType<typeof makeMemoryDb> | null = null;
vi.mock("@/lib/db/client", () => ({
  db: () => {
    if (!memDb) memDb = makeMemoryDb();
    return memDb;
  },
  closeDb: () => { memDb?.close(); memDb = null; },
}));

beforeEach(() => { memDb?.close(); memDb = null; });
afterEach(() => { memDb?.close(); memDb = null; });

describe("computeCrossVenueImpliedProbs (integration)", () => {
  it("returns bs + poly probs for an active price_threshold pairing", async () => {
    const { db } = await import("@/lib/db/client");
    const h = db();
    // Seed 35 daily CB snapshots for BTC-USD around $60k with small daily noise.
    const start = Date.now() - 35 * 86_400_000;
    for (let i = 0; i < 35; i++) {
      const price = 60_000 * Math.exp((Math.sin(i) - 0.5) * 0.005);
      h.prepare("INSERT INTO coinbase_snapshots (product_id, midpoint, captured_at) VALUES (?, ?, ?)")
        .run("BTC-USD", price, new Date(start + i * 86_400_000).toISOString());
    }
    // Seed a PM snapshot for the condition.
    h.prepare("INSERT INTO market_snapshots (condition_id, token_id, question, midpoint, captured_at) VALUES (?, ?, ?, ?, datetime('now'))")
      .run("test-cond-1", "tok-1", "q?", 0.30);
    // Seed an active pairing with expiry 90 days out.
    const expiry = new Date(Date.now() + 90 * 86_400_000).toISOString();
    h.prepare(
      `INSERT INTO cross_venue_arbs
         (poly_condition_id, poly_question, coinbase_product_id, pairing_kind,
          threshold_value, threshold_direction, expiry_iso, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run("test-cond-1", "BTC > $80k by Q3?", "BTC-USD", "price_threshold", 80_000, "gt", expiry);

    const { bsImpliedProb, polyImpliedProb } = computeCrossVenueImpliedProbs(new Date());
    expect(bsImpliedProb.get("test-cond-1")).toBeGreaterThanOrEqual(0);
    expect(bsImpliedProb.get("test-cond-1")).toBeLessThanOrEqual(1);
    expect(polyImpliedProb.get("test-cond-1")).toBeCloseTo(0.30, 6);
  });

  it("skips pairings missing expiry / spot / history", async () => {
    const { db } = await import("@/lib/db/client");
    const h = db();
    h.prepare(
      `INSERT INTO cross_venue_arbs (poly_condition_id, coinbase_product_id, pairing_kind, threshold_value, threshold_direction, expiry_iso, active)
       VALUES ('no-spot', 'BTC-USD', 'price_threshold', 100000, 'gt', ?, 1)`,
    ).run(new Date(Date.now() + 30 * 86_400_000).toISOString());
    // No CB snapshots → should skip cleanly.
    const { bsImpliedProb } = computeCrossVenueImpliedProbs(new Date());
    expect(bsImpliedProb.has("no-spot")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  detectCrossTimeframeSpread,
  type SpreadObservation,
  type TimeframeQuote,
} from "@/lib/strategies/cross-timeframe-spread";

const NOW = Date.parse("2026-05-26T12:00:00Z");
const isoNow = new Date(NOW).toISOString();

function quote(overrides: Partial<TimeframeQuote> = {}): TimeframeQuote {
  return {
    conditionId: "cond-short",
    durationMinutes: 5,
    midPrice: 0.55,
    ts: isoNow,
    ...overrides,
  };
}

function rollingSpreads(mean: number, stdev: number, count: number): SpreadObservation[] {
  // Generate synthetic samples around mean ± stdev to get the right statistics.
  const out: SpreadObservation[] = [];
  for (let i = 0; i < count; i++) {
    // Alternate to produce both positive and negative deviations
    const sign = i % 2 === 0 ? 1 : -1;
    const dev = sign * stdev * ((i % 5) / 4); // 0 .. stdev
    out.push({ spread: mean + dev, ts: new Date(NOW - (count - i) * 60_000).toISOString() });
  }
  return out;
}

describe("detectCrossTimeframeSpread", () => {
  it("returns null when fewer than minSamples", () => {
    const r = detectCrossTimeframeSpread(
      quote(),
      quote({ conditionId: "cond-long", durationMinutes: 15, midPrice: 0.50 }),
      rollingSpreads(0.03, 0.02, 10),
      { nowMs: NOW, minSamples: 30 },
    );
    expect(r).toBeNull();
  });

  it("returns null when spread is at the rolling mean (z ≈ 0)", () => {
    const samples = rollingSpreads(0.05, 0.02, 50);
    const r = detectCrossTimeframeSpread(
      quote({ midPrice: 0.55 }),
      quote({ conditionId: "cond-long", durationMinutes: 15, midPrice: 0.50 }),
      samples,
      { nowMs: NOW },
    );
    expect(r).toBeNull(); // spread = 0.05 ≈ mean 0.05 → z near 0
  });

  it("fires positive-z signal (short expensive, long cheap)", () => {
    // mean 0.03, stdev 0.025; current spread 0.12 → z = (0.12-0.03)/0.025 = 3.6
    const samples = Array.from({ length: 50 }, (_, i) => ({
      spread: 0.03 + (i % 2 === 0 ? 1 : -1) * 0.025 * (i / 50),
      ts: new Date(NOW - (50 - i) * 60_000).toISOString(),
    }));
    const r = detectCrossTimeframeSpread(
      quote({ midPrice: 0.6 }),
      quote({ conditionId: "cond-long", durationMinutes: 15, midPrice: 0.48 }),
      samples,
      { nowMs: NOW, minZScore: 2.5 },
    );
    expect(r).not.toBeNull();
    expect(r!.cheapSide).toBe("long");
    expect(r!.zScore).toBeGreaterThan(2.5);
  });

  it("fires negative-z signal (short cheap, long expensive)", () => {
    const samples = Array.from({ length: 50 }, (_, i) => ({
      spread: 0.05 + (i % 2 === 0 ? 1 : -1) * 0.02 * (i / 50),
      ts: new Date(NOW - (50 - i) * 60_000).toISOString(),
    }));
    // Current spread = -0.08, far below mean ~0.05
    const r = detectCrossTimeframeSpread(
      quote({ midPrice: 0.4 }),
      quote({ conditionId: "cond-long", durationMinutes: 15, midPrice: 0.48 }),
      samples,
      { nowMs: NOW, minZScore: 2.0 },
    );
    expect(r).not.toBeNull();
    expect(r!.cheapSide).toBe("short");
    expect(r!.zScore).toBeLessThan(-2.0);
  });

  it("returns null on stale quotes", () => {
    const longAgo = new Date(NOW - 10 * 60_000).toISOString();
    const r = detectCrossTimeframeSpread(
      quote({ ts: longAgo }),
      quote({ conditionId: "cond-long", durationMinutes: 15, midPrice: 0.48 }),
      rollingSpreads(0.05, 0.02, 50),
      { nowMs: NOW, maxStalenessSec: 60 },
    );
    expect(r).toBeNull();
  });

  it("returns null when stdev is effectively zero (no variation in spread history)", () => {
    const samples: SpreadObservation[] = Array.from({ length: 50 }, (_, i) => ({
      spread: 0.05, // constant
      ts: new Date(NOW - (50 - i) * 60_000).toISOString(),
    }));
    const r = detectCrossTimeframeSpread(
      quote({ midPrice: 0.55 }),
      quote({ conditionId: "cond-long", durationMinutes: 15, midPrice: 0.50 }),
      samples,
      { nowMs: NOW, minZScore: 1 },
    );
    expect(r).toBeNull();
  });

  it("clamps |z| to 10 to avoid blowups", () => {
    // Tiny stdev, large deviation → raw z would be huge
    const samples: SpreadObservation[] = Array.from({ length: 50 }, (_, i) => ({
      spread: 0.05 + Math.random() * 0.0001,
      ts: new Date(NOW - (50 - i) * 60_000).toISOString(),
    }));
    const r = detectCrossTimeframeSpread(
      quote({ midPrice: 0.95 }),
      quote({ conditionId: "cond-long", durationMinutes: 15, midPrice: 0.05 }),
      samples,
      { nowMs: NOW, minZScore: 2 },
    );
    expect(r).not.toBeNull();
    expect(Math.abs(r!.zScore)).toBeLessThanOrEqual(10);
  });

  it("returns null on out-of-range price (>= 1 or <= 0)", () => {
    const samples = rollingSpreads(0.05, 0.02, 50);
    expect(
      detectCrossTimeframeSpread(quote({ midPrice: 0 }), quote({ conditionId: "long" }), samples, {
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(
      detectCrossTimeframeSpread(quote({ midPrice: 1 }), quote({ conditionId: "long" }), samples, {
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("output includes marketKey pointing to cheap side", () => {
    const samples = Array.from({ length: 50 }, (_, i) => ({
      spread: 0.03 + (i % 2 === 0 ? 1 : -1) * 0.025 * (i / 50),
      ts: new Date(NOW - (50 - i) * 60_000).toISOString(),
    }));
    const r = detectCrossTimeframeSpread(
      quote({ conditionId: "SHORT-ID", midPrice: 0.6 }),
      quote({ conditionId: "LONG-ID", durationMinutes: 15, midPrice: 0.48 }),
      samples,
      { nowMs: NOW, minZScore: 2.5 },
    );
    expect(r!.cheapSide).toBe("long");
    expect(r!.marketKey).toBe("LONG-ID");
  });
});

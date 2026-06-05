import { describe, it, expect } from "vitest";
import { fundingStats } from "@/lib/exec/funding-stats";

const HOURLY = 24 * 365;

describe("fundingStats — durable (median) funding, spike-resistant", () => {
  it("steady funding: mean ≈ median ≈ durable (no spike to discount)", () => {
    const r = Array(200).fill(0.00003); // steady 0.00003/hr → ~26% APR
    const s = fundingStats(r, HOURLY);
    expect(s.meanApr).toBeCloseTo(0.00003 * HOURLY * 100, 5);
    expect(s.durableApr).toBeCloseTo(s.medianApr, 5);
    expect(s.durableApr).toBeCloseTo(s.meanApr, 5);
    expect(s.persistence).toBe(1);
  });

  it("THE TRAP: floor most hours + rare fat spikes → mean inflated, durable stays at the floor", () => {
    // 95 hours at the +11%-APR floor, 5 hours at a huge spike. Mean is dragged way up; median is the floor.
    const floor = 0.0000125;            // ~11% APR hourly floor
    const r = [...Array(95).fill(floor), ...Array(5).fill(0.001)]; // spikes ~876% APR
    const s = fundingStats(r, HOURLY);
    expect(s.medianApr).toBeCloseTo(floor * HOURLY * 100, 3);   // durable = floor ~11%
    expect(s.meanApr).toBeGreaterThan(s.medianApr * 3);          // mean badly inflated by the tail
    expect(s.durableApr).toBeCloseTo(s.medianApr, 5);            // we gate on the floor, not the spike
    expect(s.persistence).toBe(1);                              // sign is still 100% positive
  });

  it("durable carries the PERSISTENT sign even if the median sits at zero-ish", () => {
    // mostly small-negative (shorts pay) with a few positive prints; mean negative → durable negative
    const r = [...Array(70).fill(-0.00002), ...Array(30).fill(0.00001)];
    const s = fundingStats(r, HOURLY);
    expect(s.meanApr).toBeLessThan(0);
    expect(s.durableApr).toBeLessThan(0);     // direction follows where funding net pays
    expect(s.persistence).toBeCloseTo(0.7, 5);
  });

  it("recentApr tracks a regime shift the 30d mean misses", () => {
    // old window hot, recent window cold
    const r = [...Array(150).fill(0.0001), ...Array(21).fill(0.0000125)];
    const s = fundingStats(r, HOURLY, 21);
    expect(s.recentApr).toBeCloseTo(0.0000125 * HOURLY * 100, 3); // recent = cold floor
    expect(s.meanApr).toBeGreaterThan(s.recentApr);               // 30d mean still hot
  });

  it("Binance 8-hourly scaling uses 3×365 periods/yr", () => {
    const r = Array(100).fill(0.0001); // 0.01%/8h
    const s = fundingStats(r, 3 * 365);
    expect(s.durableApr).toBeCloseTo(0.0001 * 3 * 365 * 100, 4); // ~10.95% APR
  });

  it("empty series is safe (no NaN)", () => {
    const s = fundingStats([], HOURLY);
    expect(s.n).toBe(0);
    expect(Number.isFinite(s.durableApr)).toBe(true);
  });
});

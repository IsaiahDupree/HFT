import { describe, it, expect } from "vitest";
import { parseInstrument, bsDelta, ivAtDelta, expiryMetrics, termStructure, realizedVol, type OptionQuote } from "@/lib/exec/vol-surface";

describe("parseInstrument", () => {
  it("parses a Deribit option name", () => {
    const i = parseInstrument("BTC-27JUN25-100000-P")!;
    expect(i.currency).toBe("BTC");
    expect(i.strike).toBe(100000);
    expect(i.type).toBe("P");
    expect(new Date(i.expiryMs).toISOString()).toBe("2025-06-27T08:00:00.000Z");
  });
  it("rejects non-option names", () => {
    expect(parseInstrument("BTC-PERPETUAL")).toBeNull();
    expect(parseInstrument("garbage")).toBeNull();
  });
});

describe("bsDelta", () => {
  const T = 30 / 365, iv = 0.6;
  it("ATM call ≈ 0.5, ATM put ≈ −0.5", () => {
    expect(bsDelta("C", 100, 100, T, iv)).toBeGreaterThan(0.5);  // slightly >0.5 (vol drift)
    expect(bsDelta("C", 100, 100, T, iv)).toBeLessThan(0.6);
    expect(bsDelta("P", 100, 100, T, iv)).toBeLessThan(-0.4);
  });
  it("deep ITM call → ~1, deep OTM call → ~0", () => {
    expect(bsDelta("C", 100, 10, T, iv)).toBeGreaterThan(0.99);
    expect(bsDelta("C", 100, 1000, T, iv)).toBeLessThan(0.01);
  });
});

describe("ivAtDelta — interpolate the smile", () => {
  it("linearly interpolates IV between delta points", () => {
    const pts = [{ absDelta: 0.1, iv: 0.8 }, { absDelta: 0.3, iv: 0.6 }, { absDelta: 0.5, iv: 0.5 }];
    expect(ivAtDelta(pts, 0.2)).toBeCloseTo(0.7, 9);   // halfway between 0.1(0.8) and 0.3(0.6)
    expect(ivAtDelta(pts, 0.25)).toBeCloseTo(0.65, 9);
  });
  it("clamps outside the range and handles thin data", () => {
    expect(ivAtDelta([{ absDelta: 0.5, iv: 0.5 }], 0.25)).toBe(0.5);
    expect(ivAtDelta([], 0.25)).toBeNull();
  });
});

describe("expiryMetrics — ATM IV + 25Δ risk reversal", () => {
  const exp = Date.UTC(2025, 5, 27, 8) ;
  const now = exp - 30 * 86_400_000; // 30d to expiry
  // build a smile: OTM puts (low strike) richer than OTM calls (downside skew)
  const opts: OptionQuote[] = [
    { strike: 80, type: "P", iv: 0.75, expiryMs: exp },   // OTM put — rich
    { strike: 100, type: "P", iv: 0.55, expiryMs: exp },  // ATM
    { strike: 100, type: "C", iv: 0.55, expiryMs: exp },  // ATM
    { strike: 120, type: "C", iv: 0.50, expiryMs: exp },  // OTM call — cheaper
  ];
  it("computes a POSITIVE risk reversal when puts are richer than calls (crash premium)", () => {
    const m = expiryMetrics(opts, 100, now);
    expect(m.atmIv).toBeCloseTo(0.55, 2);
    expect(m.riskReversal25).not.toBeNull();
    expect(m.riskReversal25!).toBeGreaterThan(0); // puts richer ⇒ positive RR ⇒ sellable downside premium
  });
});

describe("termStructure", () => {
  it("flags contango when back IV > front IV (positive slope)", () => {
    const m = [
      { expiryMs: 1, tYears: 0.08, atmIv: 0.50, putIv25: null, callIv25: null, riskReversal25: null, nOptions: 4 },
      { expiryMs: 2, tYears: 0.50, atmIv: 0.60, putIv25: null, callIv25: null, riskReversal25: null, nOptions: 4 },
    ];
    const t = termStructure(m);
    expect(t.contango).toBe(true);
    expect(t.slope!).toBeGreaterThan(0);
  });
});

describe("realizedVol", () => {
  it("is ~0 for a flat series and positive for a volatile one", () => {
    expect(realizedVol([100, 100, 100, 100], 365)).toBe(0);
    expect(realizedVol([100, 110, 95, 120, 90], 365)).toBeGreaterThan(0);
  });
});

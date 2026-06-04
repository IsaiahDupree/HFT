import { describe, it, expect } from "vitest";
import { adviseTrade, renderTradeMemo, type AdvisorInput } from "@/lib/backtest/advisor";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0xffffffff; };
}
function noise(n: number, seed: number, mean = 0, amp = 0.02): number[] {
  const r = lcg(seed);
  return Array.from({ length: n }, () => mean + (r() - 0.5) * amp);
}
// A robust real-edge case (beats beta OOS, low PBO, high DSR).
function realEdge(extra: Partial<AdvisorInput> = {}): AdvisorInput {
  const beta = noise(400, 4, 0.0008);
  const strat = beta.map((x, i) => x + 0.0012 + (lcg(55 + i)() - 0.5) * 0.004);
  return { label: "edge", strategyReturns: strat, benchmarkReturns: beta, pbo: 0.1, dsr: 0.98, ...extra };
}

describe("adviseTrade — one voice over bull + bear", () => {
  it("BUY when there is real OOS alpha, robust, and clean data", () => {
    const m = adviseTrade(realEdge());
    expect(m.recommendation).toBe("BUY");
    expect(m.bull.some((s) => /genuine alpha over beta/.test(s))).toBe(true);
    expect(m.conviction).toBeGreaterThan(60);
  });

  it("STAND_ASIDE when a data splice is suspected — even with a real edge (data first)", () => {
    const m = adviseTrade(realEdge({ data: { spliceSuspected: true } }));
    expect(m.recommendation).toBe("STAND_ASIDE");
    expect(m.bear.some((s) => /DATA INTEGRITY/.test(s))).toBe(true);
    expect(m.voice).toMatch(/changes composition mid-sample|fix the data/);
  });

  it("TRADE_SMALL when the edge is real + robust but a second venue is suspect", () => {
    const m = adviseTrade(realEdge({ data: { crossVenueVerdict: "suspect" } }));
    expect(m.recommendation).toBe("TRADE_SMALL");
    expect(m.bear.some((s) => /second venue disagrees/.test(s))).toBe(true);
  });

  it("PAPER when the edge was found by scanning and 0 survive correction", () => {
    const m = adviseTrade(realEdge({ search: { hypothesesScanned: 195, bonferroniSurvivors: 0 } }));
    expect(m.recommendation).toBe("PAPER");
    expect(m.bear.some((s) => /scanning 195 cells and 0 survive/.test(s))).toBe(true);
  });

  it("BUY stays BUY when scanning DID surface a Bonferroni survivor", () => {
    const m = adviseTrade(realEdge({ search: { hypothesesScanned: 195, bonferroniSurvivors: 2 } }));
    expect(m.recommendation).toBe("BUY");
    expect(m.bull.some((s) => /cleared the Bonferroni bar/.test(s))).toBe(true);
  });

  it("HOLD_BETA when the strategy is just beta but the basket is attractive — the 'buy the beta' answer", () => {
    const beta = noise(400, 1, 0.0015);                    // high-Sharpe basket
    const strat = beta.map((x, i) => x - 0.0004 + (lcg(99 + i)() - 0.5) * 0.005); // lags beta
    const m = adviseTrade({ label: "relstr", strategyReturns: strat, benchmarkReturns: beta });
    expect(m.recommendation).toBe("HOLD_BETA");
    expect(m.bull.some((s) => /owning BETA is rational/.test(s))).toBe(true);
    expect(m.voice).toMatch(/buy the beta|hold equal-weight|the BASKET/);
  });

  it("STAND_ASIDE when it's beta AND the beta itself is unattractive", () => {
    const beta = noise(400, 2, 0.0);                        // ~zero Sharpe basket
    const split = Math.floor(400 * 0.7);
    const strat = beta.map((x, i) => x + (i < split ? 0.002 : -0.0006) + (lcg(7 + i)() - 0.5) * 0.001);
    const m = adviseTrade({ label: "x", strategyReturns: strat, benchmarkReturns: beta, betaAttractive: false });
    expect(m.recommendation).toBe("STAND_ASIDE");
    expect(m.voice).toMatch(/beta isn't even attractive|nothing here is worth owning/);
  });

  it("does NOT call it alpha when the strategy beats a worse benchmark but is itself net-negative OOS", () => {
    const beta = noise(400, 30, -0.004, 0.006);                   // benchmark loses badly (low noise)
    const strat = beta.map((x, i) => x + 0.0015 + (lcg(31 + i)() - 0.5) * 0.001); // loses less, still clearly negative
    const m = adviseTrade({ label: "carry", strategyReturns: strat, benchmarkReturns: beta, betaAttractive: false });
    expect(["STAND_ASIDE", "HOLD_BETA"]).toContain(m.recommendation);
    expect(m.bull.some((s) => /genuine alpha/.test(s))).toBe(false);
    expect(m.bear.some((s) => /net-negative out-of-sample/.test(s))).toBe(true);
    expect(m.advice.metrics.strategySharpeOos).toBeLessThan(0);
  });

  it("STAND_ASIDE on an artifact-concentrated return", () => {
    const strat = new Array(300).fill(0.0001); strat[10] = 2; strat[20] = 2; strat[30] = 2;
    const m = adviseTrade({ label: "spike", strategyReturns: strat, benchmarkReturns: noise(300, 3, 0.0005) });
    expect(m.recommendation).toBe("STAND_ASIDE");
    expect(m.bear.some((s) => /few bars/.test(s))).toBe(true);
  });

  it("always presents BOTH a bull and a bear voice unless genuinely empty", () => {
    const m = adviseTrade(realEdge());
    expect(m.bull.length).toBeGreaterThan(0);
    expect(m.bear.length).toBeGreaterThanOrEqual(0);
    const txt = renderTradeMemo(m);
    expect(txt).toContain("ADVOCATE (why buy / why trade):");
    expect(txt).toContain("SKEPTIC (why not):");
    expect(txt).toContain("ONE VOICE:");
  });

  it("conviction is clamped to [0,100] and the voice names the recommendation", () => {
    const broken = adviseTrade(realEdge({ data: { spliceSuspected: true, crossVenueVerdict: "suspect" } }));
    expect(broken.conviction).toBeGreaterThanOrEqual(0);
    expect(broken.conviction).toBeLessThanOrEqual(100);
    expect(broken.voice.startsWith(broken.recommendation)).toBe(true);
  });

  it("is deterministic", () => {
    const ev = realEdge();
    expect(adviseTrade(ev)).toEqual(adviseTrade(ev));
  });
});

import { describe, it, expect } from "vitest";
import { tradeAdvocate, renderTradeAdvice, DEFAULT_ADVOCATE_THRESHOLDS, type TradeCase } from "@/lib/backtest/trade-advocate";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0xffffffff; };
}
function noise(n: number, seed: number, mean = 0, amp = 0.02): number[] {
  const r = lcg(seed);
  return Array.from({ length: n }, () => mean + (r() - 0.5) * amp);
}

describe("tradeAdvocate — validates large ROI against a beta benchmark", () => {
  it("JUST_HOLD when a buy-and-hold beat the strategy (the relstr lesson: big ROI is worse-captured beta)", () => {
    const beta = noise(400, 1, 0.0015);                 // bull-market beta
    const strat = beta.map((x, i) => x - 0.0004 + (lcg(99 + i)() - 0.5) * 0.005); // lags beta
    const a = tradeAdvocate({ label: "relstr", strategyReturns: strat, benchmarkReturns: beta });
    expect(a.recommendation).toBe("JUST_HOLD");
    expect(a.roiVerdict).toBe("underperforms_beta");
    expect(a.truth[0]).toMatch(/buy-and-hold of the basket did BETTER/);
  });

  it("JUST_HOLD (beta_not_alpha) when it edges beta in-sample but has no OOS alpha", () => {
    const beta = noise(400, 2, 0.0);
    const split = Math.floor(400 * 0.7);
    const strat = beta.map((x, i) => x + (i < split ? 0.002 : -0.0006) + (lcg(7 + i)() - 0.5) * 0.001);
    const a = tradeAdvocate({ label: "x", strategyReturns: strat, benchmarkReturns: beta });
    expect(a.recommendation).toBe("JUST_HOLD");
    expect(a.roiVerdict).toBe("beta_not_alpha");
    expect(a.metrics.alphaSharpeOos).toBeLessThanOrEqual(0);
  });

  it("NO_TRADE (artifact_risk) when a few bars carry the whole return", () => {
    const strat = new Array(300).fill(0.0001);
    strat[10] = 2; strat[20] = 2; strat[30] = 2;        // three +200% bars dominate
    const beta = noise(300, 3, 0.0005);
    const a = tradeAdvocate({ label: "spike", strategyReturns: strat, benchmarkReturns: beta });
    expect(a.recommendation).toBe("NO_TRADE");
    expect(a.roiVerdict).toBe("artifact_risk");
    expect(a.truth[0]).toMatch(/data artifact/);
  });

  it("TRADE when it beats beta OOS AND is robust (low PBO, high DSR) — the affirmative reason to act", () => {
    const beta = noise(400, 4, 0.0008);
    const strat = beta.map((x, i) => x + 0.0012 + (lcg(55 + i)() - 0.5) * 0.004); // steady noisy alpha
    const a = tradeAdvocate({ label: "edge", strategyReturns: strat, benchmarkReturns: beta, pbo: 0.10, dsr: 0.98 });
    expect(a.recommendation).toBe("TRADE");
    expect(a.roiVerdict).toBe("real_edge");
    expect(a.advocate.some((s) => /BEATS buy-and-hold OUT-OF-SAMPLE/.test(s))).toBe(true);
    expect(a.metrics.alphaSharpeOos).toBeGreaterThan(0);
  });

  it("downgrades a beats-beta strategy to PAPER when PBO says the selection is overfit", () => {
    const beta = noise(400, 4, 0.0008);
    const strat = beta.map((x, i) => x + 0.0012 + (lcg(55 + i)() - 0.5) * 0.004);
    const a = tradeAdvocate({ label: "edge", strategyReturns: strat, benchmarkReturns: beta, pbo: 0.55, dsr: 0.98 });
    expect(a.recommendation).toBe("PAPER");
    expect(a.truth.some((s) => /SELECTION is overfit/.test(s))).toBe(true);
  });

  it("downgrades to PAPER when DSR isn't deflation-clean", () => {
    const beta = noise(400, 4, 0.0008);
    const strat = beta.map((x, i) => x + 0.0012 + (lcg(55 + i)() - 0.5) * 0.004);
    const a = tradeAdvocate({ label: "edge", strategyReturns: strat, benchmarkReturns: beta, pbo: 0.1, dsr: 0.7 });
    expect(a.recommendation).toBe("PAPER");
    expect(a.truth.some((s) => /not deflation-clean/.test(s))).toBe(true);
  });

  it("NO_TRADE on too few bars", () => {
    const a = tradeAdvocate({ label: "thin", strategyReturns: noise(100, 9, 0.01), benchmarkReturns: noise(100, 10, 0.001) });
    expect(a.recommendation).toBe("NO_TRADE");
    expect(a.roiVerdict).toBe("too_thin");
  });

  it("renders the advocate + truth block and is deterministic", () => {
    const beta = noise(400, 4, 0.0008);
    const strat = beta.map((x, i) => x + 0.0012 + (lcg(55 + i)() - 0.5) * 0.004);
    const ev: TradeCase = { label: "e", strategyReturns: strat, benchmarkReturns: beta, pbo: 0.1, dsr: 0.98 };
    const text = renderTradeAdvice(tradeAdvocate(ev));
    expect(text).toMatch(/^TRADE ADVOCATE: TRADE/);
    expect(text).toContain("advocate (reasons to act):");
    expect(text).toContain("\ntruth:\n- ");
    expect(tradeAdvocate(ev)).toEqual(tradeAdvocate(ev));
  });

  it("thresholds are configurable", () => {
    const beta = noise(300, 11, 0.001);
    expect(tradeAdvocate({ label: "x", strategyReturns: noise(200, 12, 0.001), benchmarkReturns: beta.slice(0, 200) }).roiVerdict).toBe("too_thin");
    expect(tradeAdvocate({ label: "x", strategyReturns: noise(200, 12, 0.001), benchmarkReturns: beta.slice(0, 200) }, { ...DEFAULT_ADVOCATE_THRESHOLDS, minBars: 100 }).roiVerdict).not.toBe("too_thin");
  });
});

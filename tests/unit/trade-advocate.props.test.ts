import { describe, it, expect } from "vitest";
import {
  tradeAdvocate,
  renderTradeAdvice,
  DEFAULT_ADVOCATE_THRESHOLDS,
  type TradeCase,
  type TradeAdvice,
  type TradeRecommendation,
  type RoiVerdict,
} from "@/lib/backtest/trade-advocate";

// ---- deterministic helpers (seeded LCG; no Math.random, no Date) --------------------------
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
/** centred noise series of length n. */
function noise(n: number, seed: number, mean = 0, amp = 0.02): number[] {
  const r = lcg(seed);
  return Array.from({ length: n }, () => mean + (r() - 0.5) * amp);
}
/** beta + steady drift + seeded jitter → a noisy-alpha strategy that beats beta OOS. */
function alphaOver(beta: number[], drift: number, seed: number, amp = 0.004): number[] {
  const r = lcg(seed);
  return beta.map((x) => x + drift + (r() - 0.5) * amp);
}

const REC_RANK: Record<TradeRecommendation, number> = { TRADE: 3, PAPER: 2, JUST_HOLD: 1, NO_TRADE: 0 };
const ALL_RECS: TradeRecommendation[] = ["TRADE", "PAPER", "JUST_HOLD", "NO_TRADE"];
const ALL_VERDICTS: RoiVerdict[] = ["real_edge", "underperforms_beta", "beta_not_alpha", "artifact_risk", "too_thin"];

function allMetricFinite(a: TradeAdvice): boolean {
  const m = a.metrics;
  return [
    m.bars, m.strategyCumPct, m.betaCumPct, m.strategySharpe, m.betaSharpe,
    m.alphaSharpeFull, m.alphaSharpeOos, m.topBarShare,
  ].every((v) => Number.isFinite(v));
}

// A canonical robust-edge case reused across properties (matches the module's TRADE path).
function makeEdge(seed = 4): { beta: number[]; strat: number[]; ev: TradeCase } {
  const beta = noise(400, seed, 0.0008);
  const strat = alphaOver(beta, 0.0012, 55);
  const ev: TradeCase = { label: "edge", strategyReturns: strat, benchmarkReturns: beta, pbo: 0.1, dsr: 0.98 };
  return { beta, strat, ev };
}

describe("tradeAdvocate — recommendation domain properties — properties", () => {
  it("recommendation is ALWAYS one of TRADE/PAPER/JUST_HOLD/NO_TRADE across many seeds", () => {
    for (let s = 1; s <= 60; s++) {
      const beta = noise(280 + (s % 50), s, 0.0008);
      const strat = beta.map((x, i) => x + (lcg(s + i)() - 0.5) * 0.01 + (s % 3 ? 0.001 : -0.001));
      const r = tradeAdvocate({ label: "x", strategyReturns: strat, benchmarkReturns: beta, pbo: lcg(s)(), dsr: lcg(s + 9)() });
      expect(ALL_RECS).toContain(r.recommendation);
    }
  });

  it("roiVerdict is ALWAYS one of the five declared verdicts across many seeds", () => {
    for (let s = 1; s <= 60; s++) {
      const beta = noise(300, s, 0.0006);
      const strat = noise(300, s + 5000, 0.0007);
      const r = tradeAdvocate({ label: "x", strategyReturns: strat, benchmarkReturns: beta, pbo: lcg(s)(), dsr: lcg(s + 3)() });
      expect(ALL_VERDICTS).toContain(r.roiVerdict);
    }
  });

  it("the four blocking verdicts each pin to exactly one recommendation (too_thin/artifact→NO_TRADE, beta verdicts→JUST_HOLD)", () => {
    const pinned: Record<Exclude<RoiVerdict, "real_edge">, TradeRecommendation> = {
      too_thin: "NO_TRADE",
      artifact_risk: "NO_TRADE",
      underperforms_beta: "JUST_HOLD",
      beta_not_alpha: "JUST_HOLD",
    };
    const spike = new Array(300).fill(0.0001); spike[10] = 2; spike[20] = 2; spike[30] = 2;
    const cases: TradeCase[] = [
      { label: "thin", strategyReturns: noise(50, 7, 0.01), benchmarkReturns: noise(50, 8, 0.001) },                            // too_thin
      { label: "spike", strategyReturns: spike, benchmarkReturns: noise(300, 3, 0.0005) },                                       // artifact_risk
      { label: "lag", strategyReturns: alphaOver(noise(400, 1, 0.0015), -0.0006, 99, 0.005), benchmarkReturns: noise(400, 1, 0.0015) }, // underperforms_beta
      { label: "id", strategyReturns: noise(400, 2, 0), benchmarkReturns: noise(400, 2, 0) },                                    // beta_not_alpha
    ];
    for (const c of cases) {
      const r = tradeAdvocate(c);
      expect(r.roiVerdict).not.toBe("real_edge");
      expect(r.recommendation).toBe(pinned[r.roiVerdict as Exclude<RoiVerdict, "real_edge">]);
    }
  });

  it("real_edge is the ONLY verdict that can carry two recommendations (TRADE when clean, PAPER when overfit)", () => {
    expect(tradeAdvocate(makeEdge(4).ev).roiVerdict).toBe("real_edge");
    expect(tradeAdvocate(makeEdge(4).ev).recommendation).toBe("TRADE");
    expect(tradeAdvocate({ ...makeEdge(4).ev, pbo: 0.6 }).roiVerdict).toBe("real_edge");
    expect(tradeAdvocate({ ...makeEdge(4).ev, pbo: 0.6 }).recommendation).toBe("PAPER");
  });
});

describe("tradeAdvocate — metrics integrity — properties", () => {
  it("ALL metric fields are finite numbers for a healthy edge", () => {
    expect(allMetricFinite(tradeAdvocate(makeEdge(4).ev))).toBe(true);
  });

  it("ALL metric fields stay finite across 40 randomized seeds (no NaN/Infinity leaks)", () => {
    for (let s = 1; s <= 40; s++) {
      const beta = noise(300, s, 0.0005);
      const strat = noise(300, s + 1000, 0.0006);
      const a = tradeAdvocate({ label: "x", strategyReturns: strat, benchmarkReturns: beta, pbo: lcg(s)(), dsr: lcg(s + 7)() });
      expect(allMetricFinite(a)).toBe(true);
    }
  });

  it("metrics.bars exactly equals the strategy series length", () => {
    for (const n of [0, 1, 50, 251, 400]) {
      const a = tradeAdvocate({ label: "n", strategyReturns: noise(n, 11, 0.001), benchmarkReturns: noise(n, 12, 0.001) });
      expect(a.metrics.bars).toBe(n);
    }
  });

  it("topBarShare is in [0,1] whenever cumulative log-growth is positive", () => {
    const { ev } = makeEdge(4);
    const share = tradeAdvocate(ev).metrics.topBarShare;
    expect(share).toBeGreaterThanOrEqual(0);
    expect(share).toBeLessThanOrEqual(1);
  });

  it("topBarShare is exactly 0 when total log-growth is non-positive (all-negative returns)", () => {
    const a = tradeAdvocate({ label: "neg", strategyReturns: new Array(300).fill(-0.001), benchmarkReturns: noise(300, 3, 0.0005) });
    expect(a.metrics.topBarShare).toBe(0);
  });

  it("topBarShare is non-decreasing as artifactTopBars (the top-K window) widens", () => {
    const { ev } = makeEdge(4);
    const k1 = tradeAdvocate(ev, { ...DEFAULT_ADVOCATE_THRESHOLDS, artifactTopBars: 1 }).metrics.topBarShare;
    const k5 = tradeAdvocate(ev, { ...DEFAULT_ADVOCATE_THRESHOLDS, artifactTopBars: 5 }).metrics.topBarShare;
    const k50 = tradeAdvocate(ev, { ...DEFAULT_ADVOCATE_THRESHOLDS, artifactTopBars: 50 }).metrics.topBarShare;
    expect(k5).toBeGreaterThanOrEqual(k1);
    expect(k50).toBeGreaterThanOrEqual(k5);
  });

  it("metrics.pbo / metrics.dsr passthrough the inputs verbatim", () => {
    const { ev } = makeEdge(4);
    const a = tradeAdvocate(ev);
    expect(a.metrics.pbo).toBe(0.1);
    expect(a.metrics.dsr).toBe(0.98);
  });

  it("metrics.pbo / metrics.dsr are undefined when not supplied", () => {
    const beta = noise(400, 4, 0.0008);
    const a = tradeAdvocate({ label: "nm", strategyReturns: alphaOver(beta, 0.0012, 55), benchmarkReturns: beta });
    expect(a.metrics.pbo).toBeUndefined();
    expect(a.metrics.dsr).toBeUndefined();
  });

  it("strategyCumPct sign matches the actual compounded product of strategy returns", () => {
    for (const seed of [21, 22, 23]) {
      const strat = noise(400, seed, 0.0009);
      const compounded = strat.reduce((e, x) => e * (1 + x), 1) - 1;
      const a = tradeAdvocate({ label: "c", strategyReturns: strat, benchmarkReturns: noise(400, seed + 1, 0.0005) });
      expect(Math.sign(a.metrics.strategyCumPct)).toBe(Math.sign(compounded));
      expect(a.metrics.strategyCumPct).toBeCloseTo(compounded, 9);
    }
  });

  it("betaCumPct equals the compounded product of the benchmark returns", () => {
    const beta = noise(400, 31, 0.0007);
    const betaCum = beta.reduce((e, x) => e * (1 + x), 1) - 1;
    const a = tradeAdvocate({ label: "b", strategyReturns: noise(400, 32, 0.0006), benchmarkReturns: beta });
    expect(a.metrics.betaCumPct).toBeCloseTo(betaCum, 9);
  });
});

describe("tradeAdvocate — no-alpha / beta cases — properties", () => {
  it("a strategy IDENTICAL to its benchmark is NEVER TRADE (zero excess ⇒ no alpha)", () => {
    for (const seed of [2, 13, 27, 40]) {
      const beta = noise(400, seed, seed % 2 ? 0.001 : 0);
      const a = tradeAdvocate({ label: "id", strategyReturns: [...beta], benchmarkReturns: beta, pbo: 0.05, dsr: 0.99 });
      expect(a.recommendation).not.toBe("TRADE");
      expect(a.recommendation).toBe("JUST_HOLD");
      expect(a.roiVerdict).toBe("beta_not_alpha");
    }
  });

  it("identical strategy/benchmark yields exactly zero OOS alpha Sharpe", () => {
    const beta = noise(400, 2, 0);
    const a = tradeAdvocate({ label: "id", strategyReturns: [...beta], benchmarkReturns: beta, pbo: 0.05, dsr: 0.99 });
    expect(a.metrics.alphaSharpeOos).toBe(0);
  });

  it("a strategy strictly dominated by beta is JUST_HOLD / underperforms_beta even with perfect pbo+dsr", () => {
    const beta = noise(400, 1, 0.0015);
    const lag = alphaOver(beta, -0.0006, 99, 0.005);
    const a = tradeAdvocate({ label: "lag", strategyReturns: lag, benchmarkReturns: beta, pbo: 0.0, dsr: 1.0 });
    expect(a.recommendation).toBe("JUST_HOLD");
    expect(a.roiVerdict).toBe("underperforms_beta");
  });

  it("beta verdicts surface a 'HOLD the basket' message in truth, never an advocate TRADE line", () => {
    const beta = noise(400, 1, 0.0015);
    const a = tradeAdvocate({ label: "lag", strategyReturns: alphaOver(beta, -0.0006, 99, 0.005), benchmarkReturns: beta });
    expect(a.truth.join("\n")).toMatch(/HOLD the basket|did BETTER/);
    expect(a.advocate.some((s) => /BEATS buy-and-hold OUT-OF-SAMPLE/.test(s))).toBe(false);
  });
});

describe("tradeAdvocate — overfit gauntlet monotonicity (pbo) — properties", () => {
  it("raising pbo above the clean threshold NEVER UPGRADES the recommendation (monotone non-increasing)", () => {
    const { ev } = makeEdge(4);
    let prevRank = Infinity;
    for (const p of [0, 0.1, 0.2, 0.29, 0.3, 0.31, 0.5, 0.7, 0.9, 1.0]) {
      const rank = REC_RANK[tradeAdvocate({ ...ev, pbo: p }).recommendation];
      expect(rank).toBeLessThanOrEqual(prevRank);
      prevRank = rank;
    }
  });

  it("a clean-pbo edge is TRADE; bumping pbo over the threshold downgrades it to PAPER", () => {
    const { ev } = makeEdge(4);
    expect(tradeAdvocate({ ...ev, pbo: 0.1 }).recommendation).toBe("TRADE");
    expect(tradeAdvocate({ ...ev, pbo: 0.5 }).recommendation).toBe("PAPER");
  });

  it("pbo exactly AT the clean threshold (>=) counts as overfit → PAPER, not TRADE", () => {
    const { ev } = makeEdge(4);
    expect(tradeAdvocate({ ...ev, pbo: DEFAULT_ADVOCATE_THRESHOLDS.pboClean }).recommendation).toBe("PAPER");
  });

  it("the PAPER-from-pbo path tags real_edge verdict and explains the SELECTION is overfit", () => {
    const { ev } = makeEdge(4);
    const a = tradeAdvocate({ ...ev, pbo: 0.55 });
    expect(a.roiVerdict).toBe("real_edge");
    expect(a.truth.some((s) => /SELECTION is overfit/.test(s))).toBe(true);
  });

  it("for every edge seed, the high-pbo rec rank ≤ the low-pbo rec rank (no upgrade from worse overfit)", () => {
    for (const seed of [4, 14, 24, 34]) {
      const beta = noise(400, seed, 0.0008);
      const strat = alphaOver(beta, 0.0012, 55);
      const lo = REC_RANK[tradeAdvocate({ label: "e", strategyReturns: strat, benchmarkReturns: beta, pbo: 0.05, dsr: 0.99 }).recommendation];
      const hi = REC_RANK[tradeAdvocate({ label: "e", strategyReturns: strat, benchmarkReturns: beta, pbo: 0.9, dsr: 0.99 }).recommendation];
      expect(hi).toBeLessThanOrEqual(lo);
    }
  });
});

describe("tradeAdvocate — deflated-sharpe gate — properties", () => {
  it("lowering dsr to/under the clean threshold downgrades TRADE → PAPER (never upgrades)", () => {
    const { ev } = makeEdge(4);
    expect(tradeAdvocate({ ...ev, dsr: 0.99 }).recommendation).toBe("TRADE");
    expect(tradeAdvocate({ ...ev, dsr: 0.96 }).recommendation).toBe("TRADE");
    expect(tradeAdvocate({ ...ev, dsr: 0.95 }).recommendation).toBe("PAPER"); // == clean → not deflation-clean (<=)
    expect(tradeAdvocate({ ...ev, dsr: 0.50 }).recommendation).toBe("PAPER");
  });

  it("dsr is monotone: rec rank never increases as dsr falls", () => {
    const { ev } = makeEdge(4);
    let prev = Infinity;
    for (const d of [1.0, 0.98, 0.96, 0.95, 0.8, 0.1]) {
      const rank = REC_RANK[tradeAdvocate({ ...ev, dsr: d }).recommendation];
      expect(rank).toBeLessThanOrEqual(prev);
      prev = rank;
    }
  });

  it("the PAPER-from-dsr path explains it is not deflation-clean", () => {
    const { ev } = makeEdge(4);
    const a = tradeAdvocate({ ...ev, pbo: 0.1, dsr: 0.7 });
    expect(a.recommendation).toBe("PAPER");
    expect(a.truth.some((s) => /not deflation-clean/.test(s))).toBe(true);
  });

  it("omitting pbo and dsr entirely lets a genuine OOS edge reach TRADE (null-guarded gates)", () => {
    const beta = noise(400, 4, 0.0008);
    const a = tradeAdvocate({ label: "e", strategyReturns: alphaOver(beta, 0.0012, 55), benchmarkReturns: beta });
    expect(a.recommendation).toBe("TRADE");
    expect(a.roiVerdict).toBe("real_edge");
  });
});

describe("tradeAdvocate — too-thin & artifact gates — properties", () => {
  it("any series shorter than minBars is NO_TRADE / too_thin regardless of how good it looks", () => {
    for (const n of [0, 1, 10, 100, 249]) {
      const a = tradeAdvocate({ label: "t", strategyReturns: noise(n, 9, 0.02), benchmarkReturns: noise(n, 10, 0.0005), pbo: 0, dsr: 1 });
      expect(a.recommendation).toBe("NO_TRADE");
      expect(a.roiVerdict).toBe("too_thin");
    }
  });

  it("at exactly minBars the too-thin gate no longer fires (boundary is n < minBars)", () => {
    const n = DEFAULT_ADVOCATE_THRESHOLDS.minBars;
    const beta = noise(n, 4, 0.0008);
    const a = tradeAdvocate({ label: "edge", strategyReturns: alphaOver(beta, 0.0012, 55), benchmarkReturns: beta, pbo: 0.1, dsr: 0.98 });
    expect(a.roiVerdict).not.toBe("too_thin");
  });

  it("empty input arrays are handled gracefully → too_thin with all-finite, zeroed metrics", () => {
    const a = tradeAdvocate({ label: "empty", strategyReturns: [], benchmarkReturns: [] });
    expect(a.recommendation).toBe("NO_TRADE");
    expect(a.roiVerdict).toBe("too_thin");
    expect(a.metrics.bars).toBe(0);
    expect(a.metrics.strategyCumPct).toBe(0);
    expect(a.metrics.topBarShare).toBe(0);
    expect(allMetricFinite(a)).toBe(true);
  });

  it("a return concentrated in a few huge bars (cum>1, high top-K share) is NO_TRADE / artifact_risk", () => {
    const strat = new Array(300).fill(0.0001);
    strat[10] = 2; strat[20] = 2; strat[30] = 2; // three +200% bars dominate the log-growth
    const a = tradeAdvocate({ label: "spike", strategyReturns: strat, benchmarkReturns: noise(300, 3, 0.0005) });
    expect(a.recommendation).toBe("NO_TRADE");
    expect(a.roiVerdict).toBe("artifact_risk");
    expect(a.metrics.strategyCumPct).toBeGreaterThan(1);
    expect(a.metrics.topBarShare).toBeGreaterThan(DEFAULT_ADVOCATE_THRESHOLDS.artifactShare);
  });

  it("the artifact gate requires BOTH cum>1 AND concentration — high concentration but small cum does NOT trip it", () => {
    const strat = new Array(300).fill(-0.001);
    strat[10] = 0.5; // concentrated but tiny total cumulative return
    const a = tradeAdvocate({ label: "a2", strategyReturns: strat, benchmarkReturns: noise(300, 3, 0.0005) });
    expect(a.metrics.strategyCumPct).toBeLessThanOrEqual(1);
    expect(a.roiVerdict).not.toBe("artifact_risk");
  });

  it("the too-thin gate takes priority over the artifact gate when both could apply", () => {
    const strat = new Array(100).fill(0.0001);
    strat[5] = 3; strat[6] = 3; // would be an artifact at length≥minBars, but too short
    const a = tradeAdvocate({ label: "short-spike", strategyReturns: strat, benchmarkReturns: noise(100, 3, 0.0005) });
    expect(a.roiVerdict).toBe("too_thin");
  });
});

describe("tradeAdvocate — thresholds configurable — properties", () => {
  it("raising minBars above the series length forces too_thin on a previously-tradeable case", () => {
    const { ev } = makeEdge(4);
    expect(tradeAdvocate(ev).roiVerdict).not.toBe("too_thin");
    expect(tradeAdvocate(ev, { ...DEFAULT_ADVOCATE_THRESHOLDS, minBars: 500 }).roiVerdict).toBe("too_thin");
  });

  it("lowering minBars lets a short series clear the too-thin gate", () => {
    const beta = noise(200, 11, 0.001);
    const c: TradeCase = { label: "x", strategyReturns: noise(200, 12, 0.001), benchmarkReturns: beta };
    expect(tradeAdvocate(c).roiVerdict).toBe("too_thin");
    expect(tradeAdvocate(c, { ...DEFAULT_ADVOCATE_THRESHOLDS, minBars: 100 }).roiVerdict).not.toBe("too_thin");
  });

  it("tightening pboClean can flip a TRADE into a PAPER (overfit gate is threshold-driven)", () => {
    const { ev } = makeEdge(4); // pbo 0.1
    expect(tradeAdvocate(ev).recommendation).toBe("TRADE");
    expect(tradeAdvocate(ev, { ...DEFAULT_ADVOCATE_THRESHOLDS, pboClean: 0.05 }).recommendation).toBe("PAPER");
  });

  it("relaxing pboClean above the input pbo can keep a borderline case as TRADE", () => {
    const { beta, strat } = makeEdge(4);
    const c: TradeCase = { label: "e", strategyReturns: strat, benchmarkReturns: beta, pbo: 0.4, dsr: 0.99 };
    expect(tradeAdvocate(c).recommendation).toBe("PAPER"); // 0.4 >= default 0.3
    expect(tradeAdvocate(c, { ...DEFAULT_ADVOCATE_THRESHOLDS, pboClean: 0.5 }).recommendation).toBe("TRADE");
  });

  it("tightening dsrClean above the input dsr flips TRADE → PAPER", () => {
    const { ev } = makeEdge(4); // dsr 0.98
    expect(tradeAdvocate(ev).recommendation).toBe("TRADE");
    expect(tradeAdvocate(ev, { ...DEFAULT_ADVOCATE_THRESHOLDS, dsrClean: 0.99 }).recommendation).toBe("PAPER");
  });

  it("lowering artifactShare can convert a moderately-concentrated cum>1 case into artifact_risk", () => {
    const strat = new Array(300).fill(0.001);
    strat[5] = 1.0; strat[6] = 1.0; // concentrated, cum>1, but under the default 0.5 share
    const lenient = tradeAdvocate(strat[0] === undefined ? { label: "x", strategyReturns: strat, benchmarkReturns: noise(300, 3, 0) } : { label: "m", strategyReturns: strat, benchmarkReturns: noise(300, 3, 0.0005) }, { ...DEFAULT_ADVOCATE_THRESHOLDS, artifactShare: 0.99 });
    const strict = tradeAdvocate({ label: "m", strategyReturns: strat, benchmarkReturns: noise(300, 3, 0.0005) }, { ...DEFAULT_ADVOCATE_THRESHOLDS, artifactShare: 0.01 });
    expect(strict.roiVerdict).toBe("artifact_risk");
    expect(lenient.roiVerdict).not.toBe("artifact_risk");
  });

  it("DEFAULT_ADVOCATE_THRESHOLDS exposes the documented default values", () => {
    expect(DEFAULT_ADVOCATE_THRESHOLDS).toEqual({ minBars: 250, pboClean: 0.3, dsrClean: 0.95, artifactTopBars: 5, artifactShare: 0.5 });
  });

  it("passing an explicit copy of the defaults yields the identical advice as the default arg", () => {
    const { ev } = makeEdge(4);
    expect(tradeAdvocate(ev, { ...DEFAULT_ADVOCATE_THRESHOLDS })).toEqual(tradeAdvocate(ev));
  });
});

describe("tradeAdvocate — oosFrac behaviour — properties", () => {
  it("oosFrac changes the OOS split → can change alphaSharpeOos for the same series", () => {
    const { beta, strat } = makeEdge(4);
    const a = tradeAdvocate({ label: "o", strategyReturns: strat, benchmarkReturns: beta, oosFrac: 0.3 });
    const b = tradeAdvocate({ label: "o", strategyReturns: strat, benchmarkReturns: beta, oosFrac: 0.5 });
    expect(a.metrics.alphaSharpeOos).not.toBe(b.metrics.alphaSharpeOos);
    expect(Number.isFinite(a.metrics.alphaSharpeOos)).toBe(true);
    expect(Number.isFinite(b.metrics.alphaSharpeOos)).toBe(true);
  });

  it("the default oosFrac (0.3) equals an explicit oosFrac of 0.3", () => {
    const { beta, strat } = makeEdge(4);
    const def = tradeAdvocate({ label: "o", strategyReturns: strat, benchmarkReturns: beta, pbo: 0.1, dsr: 0.98 });
    const exp = tradeAdvocate({ label: "o", strategyReturns: strat, benchmarkReturns: beta, pbo: 0.1, dsr: 0.98, oosFrac: 0.3 });
    expect(def).toEqual(exp);
  });
});

describe("tradeAdvocate — advocate/truth narrative — properties", () => {
  it("a TRADE recommendation always includes the explicit 'BEATS buy-and-hold OUT-OF-SAMPLE' advocate line", () => {
    const { ev } = makeEdge(4);
    const a = tradeAdvocate(ev);
    expect(a.recommendation).toBe("TRADE");
    expect(a.advocate.some((s) => /BEATS buy-and-hold OUT-OF-SAMPLE/.test(s))).toBe(true);
  });

  it("a clean positive edge lists the cumulative-return and Sharpe positives in advocate", () => {
    const { ev } = makeEdge(4);
    const a = tradeAdvocate(ev);
    expect(a.advocate.some((s) => /^cumulative/.test(s))).toBe(true);
    expect(a.advocate.some((s) => /ann\.Sharpe/.test(s))).toBe(true);
  });

  it("a supplied clean PBO and DSR each surface their own affirmative advocate line", () => {
    const { ev } = makeEdge(4);
    const a = tradeAdvocate(ev);
    expect(a.advocate.some((s) => /Deflated-Sharpe .*survives multiple-testing/.test(s))).toBe(true);
    expect(a.advocate.some((s) => /PBO .*low overfit/.test(s))).toBe(true);
  });

  it("every terminal case populates at least one truth line (the honest caveat is never empty)", () => {
    const cases: TradeCase[] = [
      makeEdge(4).ev,
      { ...makeEdge(4).ev, pbo: 0.6 },
      { label: "lag", strategyReturns: alphaOver(noise(400, 1, 0.0015), -0.0006, 99, 0.005), benchmarkReturns: noise(400, 1, 0.0015) },
      { label: "thin", strategyReturns: noise(50, 7, 0.01), benchmarkReturns: noise(50, 8, 0.001) },
    ];
    for (const c of cases) expect(tradeAdvocate(c).truth.length).toBeGreaterThan(0);
  });
});

describe("renderTradeAdvice — structure & sections — properties", () => {
  it("output ALWAYS contains the advocate header and the truth section", () => {
    for (const c of [makeEdge(4).ev, { ...makeEdge(4).ev, pbo: 0.6 }, { label: "thin", strategyReturns: noise(50, 7, 0.01), benchmarkReturns: noise(50, 8, 0.001) }] as TradeCase[]) {
      const text = renderTradeAdvice(tradeAdvocate(c));
      expect(text).toContain("advocate (reasons to act):");
      expect(text).toContain("\ntruth:");
    }
  });

  it("the first line echoes the recommendation and roiVerdict verbatim", () => {
    const a = tradeAdvocate(makeEdge(4).ev);
    const first = renderTradeAdvice(a).split("\n")[0];
    expect(first).toBe(`TRADE ADVOCATE: ${a.recommendation}  (${a.roiVerdict})`);
  });

  it("when advocate is empty (too-thin) the render shows the placeholder, not a stray '+' line", () => {
    const a = tradeAdvocate({ label: "thin", strategyReturns: noise(50, 7, 0.01), benchmarkReturns: noise(50, 8, 0.001) });
    const text = renderTradeAdvice(a);
    expect(a.advocate.length).toBe(0);
    expect(text).toContain("+ (nothing genuinely cleared its bar)");
  });

  it("every advocate line is rendered as a '+ ' bullet and every truth line as a '- ' bullet", () => {
    const a = tradeAdvocate(makeEdge(4).ev);
    const text = renderTradeAdvice(a);
    for (const s of a.advocate) expect(text).toContain(`+ ${s}`);
    for (const s of a.truth) expect(text).toContain(`- ${s}`);
  });

  it("render embeds the strategy-vs-beta summary line with the OOS alpha-Sharpe figure", () => {
    const a = tradeAdvocate(makeEdge(4).ev);
    const text = renderTradeAdvice(a);
    expect(text).toMatch(/strategy .* vs {2}beta .* · OOS alpha-Sharpe /);
  });
});

describe("tradeAdvocate — determinism — properties", () => {
  it("repeated calls with identical input are deeply equal (pure function)", () => {
    const { ev } = makeEdge(4);
    expect(tradeAdvocate(ev)).toEqual(tradeAdvocate(ev));
  });

  it("determinism holds across a sweep of distinct seeds (no hidden global state)", () => {
    for (let s = 1; s <= 12; s++) {
      const beta = noise(300, s, 0.0007);
      const c: TradeCase = { label: "d", strategyReturns: alphaOver(beta, 0.001, s + 100), benchmarkReturns: beta, pbo: lcg(s)(), dsr: lcg(s + 4)() };
      expect(tradeAdvocate(c)).toEqual(tradeAdvocate(c));
    }
  });

  it("renderTradeAdvice is deterministic and a left-inverse of nothing but stable string output", () => {
    const a = tradeAdvocate(makeEdge(4).ev);
    expect(renderTradeAdvice(a)).toBe(renderTradeAdvice(a));
  });

  it("tradeAdvocate does NOT mutate its input case or the passed thresholds object", () => {
    const { beta, strat } = makeEdge(4);
    const thr = { ...DEFAULT_ADVOCATE_THRESHOLDS };
    const thrSnapshot = JSON.stringify(thr);
    const c: TradeCase = { label: "im", strategyReturns: strat, benchmarkReturns: beta, pbo: 0.1, dsr: 0.98 };
    const stratSnapshot = JSON.stringify(strat);
    const betaSnapshot = JSON.stringify(beta);
    tradeAdvocate(c, thr);
    expect(JSON.stringify(strat)).toBe(stratSnapshot);
    expect(JSON.stringify(beta)).toBe(betaSnapshot);
    expect(JSON.stringify(thr)).toBe(thrSnapshot);
    expect(c.label).toBe("im");
  });
});

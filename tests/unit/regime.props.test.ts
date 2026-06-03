/**
 * Property tests for src/lib/backtest/candle/regime.ts.
 *
 * These assert INVARIANTS of the regime labelers + conditional-alpha machinery rather than
 * specific numbers: label-array length == input, only the documented label vocabulary is
 * emitted, warmup bars are UNKNOWN, every labeler is NO-LOOKAHEAD (perturbing a far-future
 * close cannot change an earlier label), combineLabels propagates UNKNOWN, regimeConditionalAlpha
 * skips UNKNOWN with nOos<=nFull and a tStat whose sign matches the excess and that scales ~√nOos,
 * and multipleTestingReport's Bonferroni critical t rises with the hypothesis count while
 * survivors must clear it.
 *
 * All randomness comes from a seeded LCG below — no platform random, no wall-clock — so a
 * regression flips a concrete assertion deterministically.
 */
import { describe, it, expect } from "vitest";
import {
  UNKNOWN,
  volRegimeLabels,
  trendRegimeLabels,
  breadthRegimeLabels,
  combineLabels,
  regimeConditionalAlpha,
  candidateConditionalEdges,
  multipleTestingReport,
  type ConditionalAlpha,
} from "@/lib/backtest/candle/regime";
import { sharpe, normalInv } from "@/lib/backtest/candle/stats";
import type { PriceSeries } from "@/lib/backtest/candle/xsection";

// ---------------------------------------------------------------------------
// Seeded deterministic helpers (LCG — Numerical Recipes constants).
// ---------------------------------------------------------------------------
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000; // [0,1)
  };
}

/** A geometric random walk of `n` closes, all strictly positive. Deterministic given `seed`. */
function walk(n: number, seed: number, drift = 0, volPct = 0.02): number[] {
  const rnd = lcg(seed);
  const out: number[] = [100];
  for (let i = 1; i < n; i++) {
    const step = drift + (rnd() - 0.5) * 2 * volPct;
    out.push(out[i - 1] * (1 + step));
  }
  return out;
}

/** A walk whose volatility doubles in the back half — guarantees both vol buckets appear. */
function regimeShiftWalk(n: number, seed: number): number[] {
  const rnd = lcg(seed);
  const out: number[] = [100];
  for (let i = 1; i < n; i++) {
    const vol = i < n / 2 ? 0.005 : 0.05;
    out.push(out[i - 1] * (1 + (rnd() - 0.5) * 2 * vol));
  }
  return out;
}

/** Build a PriceSeries from arrays keyed by coin; day index = array index. */
function mk(prices: Record<string, number[]>): { coins: string[]; data: PriceSeries; days: number[] } {
  const coins = Object.keys(prices);
  const data: PriceSeries = {};
  const allDays = new Set<number>();
  for (const c of coins) {
    const m = new Map<number, number>();
    prices[c].forEach((p, i) => { m.set(i, p); allDays.add(i); });
    data[c] = m;
  }
  return { coins, data, days: [...allDays].sort((a, b) => a - b) };
}

const VOL_VOCAB = new Set([UNKNOWN, "HIGH_VOL", "LOW_VOL"]);
const TREND_VOCAB = new Set([UNKNOWN, "BULL", "BEAR", "CHOP"]);
const BREADTH_VOCAB = new Set([UNKNOWN, "RISK_ON", "RISK_OFF"]);

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

// Build a strategy/bench/labels triple where every regime has plenty of OOS bars.
function buildAlphaFixture(n: number, seed: number) {
  const rnd = lcg(seed);
  const strat: number[] = [];
  const bench: number[] = [];
  const labels: string[] = [];
  const names = ["BULL", "BEAR", "CHOP"];
  for (let i = 0; i < n; i++) {
    const b = (rnd() - 0.5) * 0.02;
    // give the strategy a small positive excess so signs are deterministic
    const ex = 0.001 + (rnd() - 0.5) * 0.004;
    bench.push(b);
    strat.push(b + ex);
    // cycle labels so each appears with both IS and OOS bars; sprinkle UNKNOWN early
    labels.push(i < 6 ? UNKNOWN : names[i % names.length]);
  }
  return { strat, bench, labels };
}

// ===========================================================================
describe("volRegimeLabels — properties", () => {
  it("returns exactly one label per input close", () => {
    const closes = walk(200, 1);
    expect(volRegimeLabels(closes)).toHaveLength(closes.length);
  });

  it("emits only the documented vol vocabulary {UNKNOWN, HIGH_VOL, LOW_VOL}", () => {
    const labels = volRegimeLabels(regimeShiftWalk(300, 2), 14, 80);
    for (const l of labels) expect(VOL_VOCAB.has(l)).toBe(true);
  });

  it("marks every bar before realized-vol exists (i <= volN) as UNKNOWN", () => {
    const volN = 14;
    const labels = volRegimeLabels(walk(120, 3), volN, 60);
    // realizedVol[i] is NaN for i <= volN, so those bars cannot be classified.
    for (let i = 0; i <= volN; i++) expect(labels[i]).toBe(UNKNOWN);
  });

  it("a vol regime shift makes BOTH HIGH_VOL and LOW_VOL appear", () => {
    const labels = volRegimeLabels(regimeShiftWalk(400, 5), 14, 100);
    expect(labels).toContain("HIGH_VOL");
    expect(labels).toContain("LOW_VOL");
  });

  it("NO LOOKAHEAD — perturbing a mid-far-future close (index k) leaves labels < k unchanged", () => {
    const closes = regimeShiftWalk(260, 7);
    const k = 200;
    const base = volRegimeLabels(closes, 14, 80);
    const pert = [...closes]; pert[k] *= 0.4;
    const after = volRegimeLabels(pert, 14, 80);
    // realizedVol[i] depends only on closes <= i, so any label with i < k is untouched.
    expect(after.slice(0, k)).toEqual(base.slice(0, k));
  });

  it("a too-short series (length <= volN) is entirely UNKNOWN", () => {
    const labels = volRegimeLabels(walk(10, 9), 14, 50);
    expect(labels.every((l) => l === UNKNOWN)).toBe(true);
  });
});

// ===========================================================================
describe("trendRegimeLabels — properties", () => {
  it("returns exactly one label per input close", () => {
    const closes = walk(200, 21);
    expect(trendRegimeLabels(closes, 50)).toHaveLength(closes.length);
  });

  it("emits only the documented trend vocabulary {UNKNOWN, BULL, BEAR, CHOP}", () => {
    const labels = trendRegimeLabels(walk(300, 22), 40);
    for (const l of labels) expect(TREND_VOCAB.has(l)).toBe(true);
  });

  it("marks all warmup bars (i < n) as UNKNOWN", () => {
    const n = 50;
    const labels = trendRegimeLabels(walk(200, 23), n);
    for (let i = 0; i < n; i++) expect(labels[i]).toBe(UNKNOWN);
  });

  it("a steady uptrend produces BULL after warmup", () => {
    const closes = Array.from({ length: 160 }, (_, i) => 100 * 1.01 ** i); // monotone rising
    const labels = trendRegimeLabels(closes, 30);
    expect(labels.slice(40).some((l) => l === "BULL")).toBe(true);
    expect(labels).not.toContain("BEAR");
  });

  it("a steady downtrend produces BEAR after warmup", () => {
    const closes = Array.from({ length: 160 }, (_, i) => 1000 * 0.99 ** i); // monotone falling
    const labels = trendRegimeLabels(closes, 30);
    expect(labels.slice(40).some((l) => l === "BEAR")).toBe(true);
    expect(labels).not.toContain("BULL");
  });

  it("a noisy sideways series yields at least some CHOP", () => {
    const labels = trendRegimeLabels(walk(400, 24, 0, 0.05), 30);
    expect(labels).toContain("CHOP");
  });

  it("NO LOOKAHEAD — perturbing the final close leaves earlier labels unchanged", () => {
    const closes = walk(220, 25);
    const base = trendRegimeLabels(closes, 50);
    const pert = [...closes]; pert[pert.length - 1] *= 2;
    expect(trendRegimeLabels(pert, 50).slice(0, -1)).toEqual(base.slice(0, -1));
  });

  it("NO LOOKAHEAD — perturbing close k leaves labels < k unchanged", () => {
    const closes = walk(240, 26);
    const k = 180;
    const base = trendRegimeLabels(closes, 50);
    const pert = [...closes]; pert[k] *= 0.3;
    // ma[i] for i < k uses closes <= i only; label[k-1] reads ma[k-1] & ma[k-2] & close[k-1].
    expect(trendRegimeLabels(pert, 50).slice(0, k)).toEqual(base.slice(0, k));
  });

  it("a series shorter than the SMA window is entirely UNKNOWN", () => {
    const labels = trendRegimeLabels(walk(20, 28), 50);
    expect(labels.every((l) => l === UNKNOWN)).toBe(true);
  });
});

// ===========================================================================
describe("breadthRegimeLabels — properties", () => {
  function manyCoins(nCoins: number, nDays: number, seed: number): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (let c = 0; c < nCoins; c++) out[`C${c}`] = walk(nDays, seed + c * 97, 0.001, 0.03);
    return out;
  }

  it("returns exactly one label per day", () => {
    const { coins, data, days } = mk(manyCoins(8, 120, 31));
    expect(breadthRegimeLabels(coins, data, days, 30, 5)).toHaveLength(days.length);
  });

  it("emits only the documented breadth vocabulary {UNKNOWN, RISK_ON, RISK_OFF}", () => {
    const { coins, data, days } = mk(manyCoins(8, 180, 32));
    for (const l of breadthRegimeLabels(coins, data, days, 30, 5)) expect(BREADTH_VOCAB.has(l)).toBe(true);
  });

  it("returns UNKNOWN on every day when fewer than minCoins are eligible", () => {
    const { coins, data, days } = mk(manyCoins(3, 120, 33)); // only 3 coins < minCoins 5
    expect(breadthRegimeLabels(coins, data, days, 30, 5).every((l) => l === UNKNOWN)).toBe(true);
  });

  it("a broadly rising market resolves to RISK_ON after warmup", () => {
    const prices: Record<string, number[]> = {};
    for (let c = 0; c < 8; c++) prices[`C${c}`] = Array.from({ length: 120 }, (_, i) => 100 * 1.01 ** i);
    const { coins, data, days } = mk(prices);
    const labels = breadthRegimeLabels(coins, data, days, 20, 5);
    expect(labels.slice(40).some((l) => l === "RISK_ON")).toBe(true);
    expect(labels).not.toContain("RISK_OFF");
  });

  it("a broadly falling market resolves to RISK_OFF after warmup", () => {
    const prices: Record<string, number[]> = {};
    for (let c = 0; c < 8; c++) prices[`C${c}`] = Array.from({ length: 120 }, (_, i) => 1000 * 0.99 ** i);
    const { coins, data, days } = mk(prices);
    const labels = breadthRegimeLabels(coins, data, days, 20, 5);
    expect(labels.slice(40).some((l) => l === "RISK_OFF")).toBe(true);
    expect(labels).not.toContain("RISK_ON");
  });

  it("NO LOOKAHEAD — perturbing every coin's final close leaves earlier labels unchanged", () => {
    const prices = manyCoins(8, 150, 34);
    const base = (() => { const { coins, data, days } = mk(prices); return breadthRegimeLabels(coins, data, days, 30, 5); })();
    const pert: Record<string, number[]> = {};
    for (const c of Object.keys(prices)) { pert[c] = [...prices[c]]; pert[c][pert[c].length - 1] *= 1.8; }
    const after = (() => { const { coins, data, days } = mk(pert); return breadthRegimeLabels(coins, data, days, 30, 5); })();
    expect(after.slice(0, -1)).toEqual(base.slice(0, -1));
  });

  it("NO LOOKAHEAD — perturbing coin closes at day k leaves labels < k unchanged", () => {
    const prices = manyCoins(8, 160, 35);
    const k = 120;
    const base = (() => { const { coins, data, days } = mk(prices); return breadthRegimeLabels(coins, data, days, 30, 5); })();
    const pert: Record<string, number[]> = {};
    for (const c of Object.keys(prices)) { pert[c] = [...prices[c]]; pert[c][k] *= 0.5; }
    const after = (() => { const { coins, data, days } = mk(pert); return breadthRegimeLabels(coins, data, days, 30, 5); })();
    // each coin's day-i SMA uses that coin's closes <= day i, so labels before k are immune.
    expect(after.slice(0, k)).toEqual(base.slice(0, k));
  });

  it("days with too few present bars (gaps) are UNKNOWN even with enough coins", () => {
    const prices = manyCoins(8, 100, 37);
    // delete day 0..40 closes for all but 4 coins → on early days only 4 eligible < minCoins 5
    const { coins, data, days } = mk(prices);
    for (let c = 4; c < 8; c++) for (let d = 0; d <= 60; d++) data[`C${c}`].delete(d);
    const labels = breadthRegimeLabels(coins, data, days, 30, 5);
    // on day 35 only 4 coins have data (< minCoins 5) → eligibility too low
    expect(labels[35]).toBe(UNKNOWN);
    // by day 80 all 8 coins are present again → resolvable
    expect(labels.slice(70).some((l) => l !== UNKNOWN)).toBe(true);
  });
});

// ===========================================================================
describe("combineLabels — properties", () => {
  it("returns one composite label per index", () => {
    const a = ["BULL", "BEAR", UNKNOWN];
    const b = ["HIGH_VOL", "LOW_VOL", "HIGH_VOL"];
    expect(combineLabels(a, b)).toHaveLength(a.length);
  });

  it("propagates UNKNOWN when the FIRST label is UNKNOWN", () => {
    expect(combineLabels([UNKNOWN], ["HIGH_VOL"])).toEqual([UNKNOWN]);
  });

  it("propagates UNKNOWN when the SECOND label is UNKNOWN", () => {
    expect(combineLabels(["BULL"], [UNKNOWN])).toEqual([UNKNOWN]);
  });

  it("composite labels never contain the bare UNKNOWN token where both inputs were known", () => {
    const vol = volRegimeLabels(regimeShiftWalk(300, 41), 14, 80);
    const trend = trendRegimeLabels(regimeShiftWalk(300, 41), 40);
    const combo = combineLabels(vol, trend);
    for (let i = 0; i < combo.length; i++) {
      if (vol[i] !== UNKNOWN && trend[i] !== UNKNOWN) expect(combo[i]).toBe(`${vol[i]}|${trend[i]}`);
      else expect(combo[i]).toBe(UNKNOWN);
    }
  });

  it("an empty pair yields an empty result", () => {
    expect(combineLabels([], [])).toEqual([]);
  });

  it("NO LOOKAHEAD — combining no-lookahead labelers stays no-lookahead", () => {
    const closes = regimeShiftWalk(250, 43);
    const base = combineLabels(volRegimeLabels(closes, 14, 80), trendRegimeLabels(closes, 40));
    const pert = [...closes]; pert[pert.length - 1] *= 1.6;
    const after = combineLabels(volRegimeLabels(pert, 14, 80), trendRegimeLabels(pert, 40));
    expect(after.slice(0, -1)).toEqual(base.slice(0, -1));
  });
});

// ===========================================================================
describe("regimeConditionalAlpha — properties", () => {
  it("never emits a cell for the UNKNOWN label", () => {
    const { strat, bench, labels } = buildAlphaFixture(300, 51);
    const cells = regimeConditionalAlpha(strat, bench, labels);
    expect(cells.some((c) => c.label === UNKNOWN)).toBe(false);
  });

  it("emits one cell per distinct non-UNKNOWN label", () => {
    const { strat, bench, labels } = buildAlphaFixture(300, 52);
    const distinct = new Set(labels.filter((l) => l !== UNKNOWN));
    expect(regimeConditionalAlpha(strat, bench, labels).map((c) => c.label).sort())
      .toEqual([...distinct].sort());
  });

  it("nOos <= nFull for every regime cell", () => {
    const { strat, bench, labels } = buildAlphaFixture(400, 54);
    for (const c of regimeConditionalAlpha(strat, bench, labels, { oosFrac: 0.3 })) {
      expect(c.nOos).toBeLessThanOrEqual(c.nFull);
    }
  });

  it("the sum of cell nOos never exceeds the count of non-UNKNOWN bars", () => {
    const { strat, bench, labels } = buildAlphaFixture(360, 57);
    const cells = regimeConditionalAlpha(strat, bench, labels, { oosFrac: 0.3 });
    const nonUnknown = labels.filter((l) => l !== UNKNOWN).length;
    expect(sum(cells.map((c) => c.nOos))).toBeLessThanOrEqual(nonUnknown);
    expect(sum(cells.map((c) => c.nFull))).toBe(nonUnknown);
  });

  it("tStatOos sign matches the sign of the OOS excess Sharpe (per regime)", () => {
    const { strat, bench, labels } = buildAlphaFixture(400, 58);
    for (const c of regimeConditionalAlpha(strat, bench, labels, { oosFrac: 0.4 })) {
      if (c.nOos > 1) expect(Math.sign(c.tStatOos)).toBe(Math.sign(c.excessSharpeOos));
    }
  });

  it("a strictly-positive excess makes tStatOos positive for a populated regime", () => {
    const n = 200;
    const strat = new Array(n).fill(0.002);
    const bench = new Array(n).fill(0.001); // excess = +0.001 every bar
    // perturb so std>0 (Sharpe needs dispersion) but keep mean excess positive
    const rnd = lcg(59);
    for (let i = 0; i < n; i++) { const j = (rnd() - 0.5) * 0.0002; strat[i] += j; bench[i] -= j; }
    const labels = new Array(n).fill("BULL");
    const [cell] = regimeConditionalAlpha(strat, bench, labels, { oosFrac: 0.3 });
    expect(cell.tStatOos).toBeGreaterThan(0);
    expect(cell.excessSharpeOos).toBeGreaterThan(0);
  });

  it("tStatOos == per-bar OOS Sharpe · √nOos (the documented identity)", () => {
    const { strat, bench, labels } = buildAlphaFixture(400, 61);
    for (const c of regimeConditionalAlpha(strat, bench, labels, { oosFrac: 0.35 })) {
      const oosExcess: number[] = [];
      // reconstruct OOS excess for this label using the same split rule
      const split = Math.floor(strat.length * (1 - 0.35));
      for (let i = 0; i < strat.length; i++) if (labels[i] === c.label && i >= split) oosExcess.push(strat[i] - bench[i]);
      const expected = sharpe(oosExcess) * Math.sqrt(oosExcess.length);
      expect(c.tStatOos).toBeCloseTo(expected, 9);
    }
  });

  it("|tStatOos| scales ~√nOos: doubling identical OOS bars multiplies the t-stat by ≈√2", () => {
    // Same per-bar excess distribution, different OOS sample sizes → t-stat ∝ √n.
    const make = (oosBars: number) => {
      const isBars = 40;
      const n = isBars + oosBars;
      const strat: number[] = [], bench: number[] = [], labels: string[] = [];
      const rnd = lcg(62);
      for (let i = 0; i < n; i++) {
        const b = (rnd() - 0.5) * 0.01;
        const ex = 0.0008 + (rnd() - 0.5) * 0.003;
        bench.push(b); strat.push(b + ex); labels.push("BULL");
      }
      // oosFrac chosen so split = isBars exactly
      const oosFrac = oosBars / n;
      const [cell] = regimeConditionalAlpha(strat, bench, labels, { oosFrac });
      return cell;
    };
    const small = make(100);
    const large = make(400);
    const ratio = Math.abs(large.tStatOos) / Math.abs(small.tStatOos);
    // 400 vs 100 OOS bars → √4 = 2.0; allow tolerance for the differing random draws
    expect(ratio).toBeGreaterThan(1.4);
    expect(ratio).toBeLessThan(2.8);
  });

  it("excessSharpeOos is computed only from OOS bars (changing IS bars leaves it fixed)", () => {
    const { strat, bench, labels } = buildAlphaFixture(300, 63);
    const split = Math.floor(strat.length * (1 - 0.3));
    const base = regimeConditionalAlpha(strat, bench, labels, { oosFrac: 0.3 });
    const stratMut = [...strat];
    for (let i = 0; i < split; i++) stratMut[i] += 5; // wreck IS only
    const mut = regimeConditionalAlpha(stratMut, bench, labels, { oosFrac: 0.3 });
    const byLabel = (cs: ConditionalAlpha[]) => Object.fromEntries(cs.map((c) => [c.label, c.excessSharpeOos]));
    // OOS bars are untouched → every regime's OOS Sharpe is identical despite wrecked IS.
    expect(byLabel(mut)).toEqual(byLabel(base));
  });

  it("returns an empty array when every bar is UNKNOWN", () => {
    const n = 100;
    expect(regimeConditionalAlpha(new Array(n).fill(0.01), new Array(n).fill(0.005), new Array(n).fill(UNKNOWN)))
      .toEqual([]);
  });

  it("a regime with zero OOS bars reports nOos 0 and a 0 t-stat", () => {
    // label only appears in the IS portion → no OOS bars
    const n = 200;
    const strat: number[] = [], bench: number[] = [], labels: string[] = [];
    const rnd = lcg(64);
    const split = Math.floor(n * 0.7);
    for (let i = 0; i < n; i++) { const b = (rnd() - 0.5) * 0.01; bench.push(b); strat.push(b + 0.001); labels.push(i < split - 5 ? "EARLY" : "LATE"); }
    const early = regimeConditionalAlpha(strat, bench, labels, { oosFrac: 0.3 }).find((c) => c.label === "EARLY")!;
    expect(early.nOos).toBe(0);
    expect(early.tStatOos).toBe(0); // sharpe([]) = 0 → 0·√0
  });
});

// ===========================================================================
describe("candidateConditionalEdges — properties", () => {
  const cell = (over: Partial<ConditionalAlpha> & { label: string }): ConditionalAlpha => ({
    label: over.label, nFull: over.nFull ?? 200, nOos: over.nOos ?? 80,
    excessSharpeFull: over.excessSharpeFull ?? 0,
    excessSharpeOos: over.excessSharpeOos ?? 0,
    tStatOos: over.tStatOos ?? 0,
    stratSharpeOos: 0, betaSharpeOos: 0, stratCumOos: 0, betaCumOos: 0,
  });

  it("keeps only cells with excessSharpeOos strictly above minExcessOos", () => {
    const cells = [cell({ label: "A", excessSharpeOos: 0.5 }), cell({ label: "B", excessSharpeOos: 0.2 })];
    const out = candidateConditionalEdges(cells, { minExcessOos: 0.3, minOosBars: 60 });
    expect(out.map((c) => c.label)).toEqual(["A"]);
  });

  it("drops cells with too few OOS bars even if the Sharpe clears the bar", () => {
    const cells = [cell({ label: "A", excessSharpeOos: 2, nOos: 30 })];
    expect(candidateConditionalEdges(cells, { minExcessOos: 0.3, minOosBars: 60 })).toEqual([]);
  });

  it("sorts survivors by excessSharpeOos descending", () => {
    const cells = [
      cell({ label: "A", excessSharpeOos: 0.4 }),
      cell({ label: "B", excessSharpeOos: 0.9 }),
      cell({ label: "C", excessSharpeOos: 0.6 }),
    ];
    expect(candidateConditionalEdges(cells, { minExcessOos: 0.3 }).map((c) => c.label)).toEqual(["B", "C", "A"]);
  });

  it("the boundary value (== minExcessOos) is excluded (strict >)", () => {
    const cells = [cell({ label: "A", excessSharpeOos: 0.3 })];
    expect(candidateConditionalEdges(cells, { minExcessOos: 0.3 })).toEqual([]);
  });
});

// ===========================================================================
describe("multipleTestingReport — properties", () => {
  const cell = (label: string, nOos: number, tStat: number): ConditionalAlpha => ({
    label, nFull: nOos + 10, nOos, excessSharpeFull: 0, excessSharpeOos: 0,
    tStatOos: tStat, stratSharpeOos: 0, betaSharpeOos: 0, stratCumOos: 0, betaCumOos: 0,
  });

  it("counts only cells with at least minOosBars as hypotheses", () => {
    const cells = [cell("A", 100, 1), cell("B", 30, 1), cell("C", 80, 1)];
    expect(multipleTestingReport(cells, { alpha: 0.05, minOosBars: 60 }).nHypotheses).toBe(2);
  });

  it("critT equals the one-sided Bonferroni normalInv(1 - alpha/m)", () => {
    const cells = [cell("A", 100, 1), cell("B", 100, 1), cell("C", 100, 1)]; // m = 3
    const rep = multipleTestingReport(cells, { alpha: 0.05, minOosBars: 60 });
    expect(rep.critT).toBeCloseTo(normalInv(1 - 0.05 / 3), 9);
  });

  it("critT RISES as the number of hypotheses rises (harder bar with more tests)", () => {
    const mk2 = (m: number) => Array.from({ length: m }, (_, i) => cell(`L${i}`, 100, 1));
    const c2 = multipleTestingReport(mk2(2), { alpha: 0.05, minOosBars: 60 }).critT;
    const c20 = multipleTestingReport(mk2(20), { alpha: 0.05, minOosBars: 60 }).critT;
    const c200 = multipleTestingReport(mk2(200), { alpha: 0.05, minOosBars: 60 }).critT;
    expect(c20).toBeGreaterThan(c2);
    expect(c200).toBeGreaterThan(c20);
  });

  it("survivors all have tStatOos strictly greater than critT", () => {
    const rep = multipleTestingReport(
      [cell("A", 100, 5), cell("B", 100, 0.5), cell("C", 100, 4)],
      { alpha: 0.05, minOosBars: 60 },
    );
    for (const s of rep.survivors) expect(s.tStatOos).toBeGreaterThan(rep.critT);
  });

  it("a huge t-stat survives even with a strict (many-hypothesis) correction", () => {
    const cells = [cell("WIN", 100, 50), ...Array.from({ length: 50 }, (_, i) => cell(`N${i}`, 100, 0.3))];
    const rep = multipleTestingReport(cells, { alpha: 0.05, minOosBars: 60 });
    expect(rep.survivors.map((s) => s.label)).toContain("WIN");
  });

  it("a high-t cell with too few OOS bars is excluded from survivors (not a counted test)", () => {
    const cells = [cell("BIG_TOO_FEW", 20, 99), cell("OK", 100, 99)];
    const rep = multipleTestingReport(cells, { alpha: 0.05, minOosBars: 60 });
    expect(rep.survivors.every((s) => s.nOos >= 60)).toBe(true);
    expect(rep.survivors.map((s) => s.label)).not.toContain("BIG_TOO_FEW");
  });

  it("expectedFalse == alpha · nHypotheses", () => {
    const cells = [cell("A", 100, 1), cell("B", 100, 1), cell("C", 100, 1), cell("D", 30, 1)];
    const rep = multipleTestingReport(cells, { alpha: 0.05, minOosBars: 60 });
    expect(rep.expectedFalse).toBeCloseTo(0.05 * rep.nHypotheses, 12);
  });

  it("with zero tested cells m floors to 1 so critT stays finite", () => {
    const rep = multipleTestingReport([cell("A", 10, 5)], { alpha: 0.05, minOosBars: 60 });
    expect(rep.nHypotheses).toBe(0);
    expect(Number.isFinite(rep.critT)).toBe(true);
    expect(rep.critT).toBeCloseTo(normalInv(1 - 0.05), 9);
  });

  it("an empty cell set yields zero hypotheses and no survivors", () => {
    const rep = multipleTestingReport([], { alpha: 0.05 });
    expect(rep.nHypotheses).toBe(0);
    expect(rep.survivors).toEqual([]);
  });
});

// ===========================================================================
describe("end-to-end labeler → conditional alpha — properties", () => {
  it("a regime built from real labelers feeds regimeConditionalAlpha without producing UNKNOWN cells", () => {
    const n = 400;
    const closes = regimeShiftWalk(n, 71);
    const labels = combineLabels(volRegimeLabels(closes, 14, 80), trendRegimeLabels(closes, 40));
    // synthetic aligned returns (n-1 bars would be typical; here use n for a clean align)
    const rnd = lcg(72);
    const bench: number[] = [], strat: number[] = [];
    for (let i = 0; i < n; i++) { const b = (rnd() - 0.5) * 0.02; bench.push(b); strat.push(b + 0.0005); }
    const cells = regimeConditionalAlpha(strat, bench, labels, { oosFrac: 0.3 });
    expect(cells.some((c) => c.label === UNKNOWN)).toBe(false);
    expect(cells.every((c) => c.nOos <= c.nFull)).toBe(true);
  });

  it("the multiple-testing report over real-labeler cells never reports more survivors than hypotheses", () => {
    const n = 500;
    const closes = regimeShiftWalk(n, 73);
    const labels = combineLabels(volRegimeLabels(closes, 14, 80), trendRegimeLabels(closes, 40));
    const rnd = lcg(74);
    const bench: number[] = [], strat: number[] = [];
    for (let i = 0; i < n; i++) { const b = (rnd() - 0.5) * 0.02; bench.push(b); strat.push(b + (rnd() - 0.5) * 0.004); }
    const cells = regimeConditionalAlpha(strat, bench, labels, { oosFrac: 0.3 });
    const rep = multipleTestingReport(cells, { alpha: 0.05, minOosBars: 30 });
    expect(rep.survivors.length).toBeLessThanOrEqual(rep.nHypotheses);
  });
});

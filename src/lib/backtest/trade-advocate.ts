/**
 * Trade Advocate — makes the AFFIRMATIVE case to trade (reasons to act), but speaks the
 * TRUTH about large ROI. A big cumulative number is not a reason to buy; it can be:
 *   • a DATA ARTIFACT      — a few bars carry the whole return (single-name luck / bad tick)
 *   • market BETA          — a buy-and-hold of the basket did as well or BETTER
 *   • a real EDGE (alpha)  — beats buy-and-hold OUT-OF-SAMPLE and survives the overfit gauntlet
 *
 * So this validates ROI against a BETA BENCHMARK + a concentration check before it will
 * advocate a trade. The reason to buy is genuine out-of-sample alpha over beta — never the
 * size of the in-sample number. Pure + deterministic.
 */
import { sharpe } from "./candle/stats";

export type TradeCase = {
  label: string;
  /** Per-bar strategy returns. */
  strategyReturns: number[];
  /** Per-bar BETA benchmark returns (e.g. equal-weight buy-and-hold of the same universe). */
  benchmarkReturns: number[];
  /** Overfit-gauntlet metrics (optional but needed to clear the robustness bar). */
  pbo?: number;
  dsr?: number;
  /** Out-of-sample tail fraction for the alpha check (default 0.3). */
  oosFrac?: number;
};

export type RoiVerdict = "real_edge" | "underperforms_beta" | "beta_not_alpha" | "artifact_risk" | "too_thin";
export type TradeRecommendation = "TRADE" | "PAPER" | "JUST_HOLD" | "NO_TRADE";

export type TradeAdvice = {
  recommendation: TradeRecommendation;
  roiVerdict: RoiVerdict;
  advocate: string[]; // affirmative, TRUTHFUL reasons to act
  truth: string[];    // what the ROI really is / honest caveats
  metrics: {
    bars: number; strategyCumPct: number; betaCumPct: number;
    strategySharpe: number; betaSharpe: number;
    alphaSharpeFull: number; alphaSharpeOos: number; topBarShare: number;
    pbo?: number; dsr?: number;
  };
};

export type AdvocateThresholds = {
  minBars: number; pboClean: number; dsrClean: number;
  artifactTopBars: number; artifactShare: number;
};
export const DEFAULT_ADVOCATE_THRESHOLDS: AdvocateThresholds = {
  minBars: 250, pboClean: 0.3, dsrClean: 0.95, artifactTopBars: 5, artifactShare: 0.5,
};

const ann = (s: number) => s * Math.sqrt(365);
const cum = (a: number[]) => a.reduce((e, x) => e * (1 + x), 1) - 1;
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;

export function tradeAdvocate(c: TradeCase, thr: AdvocateThresholds = DEFAULT_ADVOCATE_THRESHOLDS): TradeAdvice {
  const s = c.strategyReturns, b = c.benchmarkReturns;
  const n = s.length;
  const split = Math.floor(n * (1 - (c.oosFrac ?? 0.3)));
  const excess = s.map((x, i) => x - (b[i] ?? 0));
  const sCum = cum(s), bCum = cum(b);
  const sSh = ann(sharpe(s)), bSh = ann(sharpe(b));
  const alphaFull = ann(sharpe(excess)), alphaOos = ann(sharpe(excess.slice(split)));
  // ROI concentration via log-growth share of the top-K bars (a data spike → high share)
  const g = s.map((x) => Math.log(1 + Math.max(-0.99, x)));
  const totalG = g.reduce((a, x) => a + x, 0);
  const topBarShare = totalG > 0 ? [...g].sort((a, x) => x - a).slice(0, thr.artifactTopBars).reduce((a, x) => a + x, 0) / totalG : 0;
  const metrics = {
    bars: n, strategyCumPct: sCum, betaCumPct: bCum, strategySharpe: sSh, betaSharpe: bSh,
    alphaSharpeFull: alphaFull, alphaSharpeOos: alphaOos, topBarShare, pbo: c.pbo, dsr: c.dsr,
  };

  const advocate: string[] = [], truth: string[] = [];
  const done = (recommendation: TradeRecommendation, roiVerdict: RoiVerdict): TradeAdvice => ({ recommendation, roiVerdict, advocate, truth, metrics });

  if (n < thr.minBars) {
    truth.push(`only ${n} bars — too short to validate a ${pct(sCum)} return`);
    return done("NO_TRADE", "too_thin");
  }

  // (1) ARTIFACT: a handful of bars carry the whole return → don't trust it, audit the data.
  if (sCum > 1 && topBarShare > thr.artifactShare) {
    truth.push(`${(topBarShare * 100).toFixed(0)}% of the ${pct(sCum)} growth is in just ${thr.artifactTopBars} bars — likely a data artifact or single-name luck; AUDIT the source before believing it`);
    return done("NO_TRADE", "artifact_risk");
  }

  // the truthful affirmative positives (stated regardless, so the case is balanced)
  if (sCum > 0) advocate.push(`cumulative ${pct(sCum)} over ${n} bars`);
  if (sSh > 0) advocate.push(`ann.Sharpe ${sSh.toFixed(2)}`);
  if (c.dsr != null && c.dsr > thr.dsrClean) advocate.push(`Deflated-Sharpe ${c.dsr.toFixed(2)} > ${thr.dsrClean} (survives multiple-testing)`);
  if (c.pbo != null && c.pbo < thr.pboClean) advocate.push(`PBO ${c.pbo.toFixed(2)} < ${thr.pboClean} (low overfit)`);

  // (2) BETA: a buy-and-hold did as well or better → the ROI is beta, hold the basket.
  if (sCum < bCum || sSh < bSh) {
    truth.push(`a buy-and-hold of the basket did BETTER (${pct(bCum)} vs ${pct(sCum)}, Sharpe ${bSh.toFixed(2)} vs ${sSh.toFixed(2)}) — the big number is (worse-captured) market BETA, not edge. The reason to "buy" is to HOLD the basket, not run this.`);
    return done("JUST_HOLD", "underperforms_beta");
  }
  if (alphaOos <= 0) {
    truth.push(`no alpha out-of-sample: excess-over-beta OOS Sharpe ${alphaOos.toFixed(2)} ≤ 0 — the return is market beta; HOLD the basket, the strategy adds nothing`);
    return done("JUST_HOLD", "beta_not_alpha");
  }

  // (3) beats beta OOS → check overfit before advocating a live trade.
  if (c.pbo != null && c.pbo >= thr.pboClean) {
    truth.push(`beats beta OOS but PBO ${c.pbo.toFixed(2)} ≥ ${thr.pboClean} — the config SELECTION is overfit; PAPER it first, don't size it live`);
    return done("PAPER", "real_edge");
  }
  if (c.dsr != null && c.dsr <= thr.dsrClean) {
    truth.push(`beats beta OOS but Deflated-Sharpe ${c.dsr.toFixed(2)} ≤ ${thr.dsrClean} — not deflation-clean across the trials; PAPER it`);
    return done("PAPER", "real_edge");
  }

  // (4) the real, affirmative reason to trade.
  advocate.push(`BEATS buy-and-hold OUT-OF-SAMPLE: excess-over-beta OOS Sharpe ${alphaOos.toFixed(2)} > 0 — genuine alpha, not beta`);
  truth.push("no audit blocker; still size small + monitor — a real edge can decay");
  return done("TRADE", "real_edge");
}

export function renderTradeAdvice(a: TradeAdvice): string {
  const m = a.metrics;
  const lines = [
    `TRADE ADVOCATE: ${a.recommendation}  (${a.roiVerdict})`,
    `strategy ${pct(m.strategyCumPct)} / Sharpe ${m.strategySharpe.toFixed(2)}  vs  beta ${pct(m.betaCumPct)} / Sharpe ${m.betaSharpe.toFixed(2)}  · OOS alpha-Sharpe ${m.alphaSharpeOos.toFixed(2)}`,
    "",
    "advocate (reasons to act):",
  ];
  if (a.advocate.length) for (const x of a.advocate) lines.push(`+ ${x}`);
  else lines.push("+ (nothing genuinely cleared its bar)");
  lines.push("", "truth:");
  for (const x of a.truth) lines.push(`- ${x}`);
  return lines.join("\n");
}

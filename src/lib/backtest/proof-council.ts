/**
 * Proof Council — an ADVOCATE / SKEPTIC / VERDICT evaluator for a backtested edge.
 *
 * Instead of only listing reasons to avoid a strategy, it tries to PROVE the edge is
 * real from the honest-gauntlet metrics (net-fee PnL → walk-forward OOS Sharpe → PBO →
 * Deflated-Sharpe), while a SKEPTIC surfaces ONLY the evidence gaps that matter for the
 * verdict (not a laundry list). Pure + deterministic — the structured counterpart to the
 * "HARDENED / arena-worthy / not robust" string the backtest scripts already print.
 *
 *   ADVOCATE_APPROVED — robustness-clean → promote to a monitored paper/live-smoke
 *                       candidate with stake caps.
 *   PROVE_IT          — promising, but a robustness gap remains (DSR short, PBO
 *                       borderline, single regime, no forward continuation) → research.
 *   REPAIR_FIRST      — an artifact voids the edge claim (faded OOS, overfit PBO,
 *                       negative net-fee PnL, too-short sample) → fix before deploy.
 */

export type StrategyEvidence = {
  label: string;
  /** Sample length; unit named by `sampleUnit` (default "bars"). */
  bars: number;
  sampleUnit?: string;
  /** Fee assumption the PnL is net of (bps). */
  feeBps: number;
  /** Walk-forward out-of-sample annualized Sharpe. */
  oosSharpeAnn?: number;
  fullSharpeAnn?: number;
  /** # variants that held OOS, out of `variants` tried. */
  oosHold?: number;
  variants?: number;
  /** Probability of backtest overfit (0..1). */
  pbo?: number;
  /** Deflated Sharpe — P(true SR > 0) after multiple-testing + non-normality (0..1). */
  dsr?: number;
  /** Cumulative PnL %, net of fees. */
  cumPnlPct?: number;
  /** Distinct market regimes covered by the sample. */
  regimesCovered?: number;
  /** Forward paper/live-smoke continuation accrued so far. */
  liveSmokeBars?: number;
  /** Optional discrete-outcome evidence → a Wilson win-rate floor advocate line. */
  winRate?: number;
  nTrades?: number;
};

export type ProofVerdict = "ADVOCATE_APPROVED" | "PROVE_IT" | "REPAIR_FIRST";
export type ProofCouncilResult = { verdict: ProofVerdict; action: string; advocate: string[]; skeptic: string[] };

export type ProofThresholds = {
  minBars: number; pboHard: number; pboClean: number; dsrClean: number;
  minRegimes: number; minOosHoldFrac: number;
};
export const DEFAULT_PROOF_THRESHOLDS: ProofThresholds = {
  minBars: 60, pboHard: 0.5, pboClean: 0.3, dsrClean: 0.95, minRegimes: 2, minOosHoldFrac: 0.5,
};

/** Wilson score lower bound for a binomial win rate (z = 1.96 ≈ 95%). Pure. */
export function wilsonLowerBound(wins: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = Math.max(0, Math.min(1, wins / n)), z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, Math.min(1, (centre - margin) / (1 + z2 / n)));
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

/** Render the council's structured verdict to the canonical text block. */
export function renderProofCouncil(r: ProofCouncilResult): string {
  const lines = [`PROOF COUNCIL: ${r.verdict}`, `action: ${r.action}`, "", "advocate:"];
  if (r.advocate.length) for (const a of r.advocate) lines.push(`+ ${a}`);
  else lines.push("+ (no metric cleared its bar)");
  lines.push("", "skeptic:");
  for (const s of r.skeptic) lines.push(`- ${s}`);
  return lines.join("\n");
}

export function proofCouncil(ev: StrategyEvidence, thr: ProofThresholds = DEFAULT_PROOF_THRESHOLDS): ProofCouncilResult {
  const unit = ev.sampleUnit ?? "bars";
  const holdFrac = ev.variants && ev.variants > 0 ? (ev.oosHold ?? 0) / ev.variants : undefined;

  // ── blockers: artifacts that make the edge claim meaningless (→ REPAIR_FIRST) ──
  const blockers: string[] = [];
  if (ev.bars < thr.minBars) blockers.push(`sample only ${ev.bars} ${unit} (< ${thr.minBars}) — too short to test an edge`);
  if (ev.oosSharpeAnn != null && ev.oosSharpeAnn <= 0) blockers.push(`OOS Sharpe ${ev.oosSharpeAnn.toFixed(2)} ≤ 0 — the edge FADED out-of-sample`);
  if (ev.cumPnlPct != null && ev.cumPnlPct < 0) blockers.push(`cumulative PnL ${pct(ev.cumPnlPct)} is negative net of ${ev.feeBps}bps fees`);
  if (ev.pbo != null && ev.pbo > thr.pboHard) blockers.push(`PBO ${ev.pbo.toFixed(2)} > ${thr.pboHard} — backtest is overfit (IS-best underperforms OOS)`);
  if (holdFrac != null && (ev.variants ?? 0) > 1 && holdFrac <= thr.minOosHoldFrac) blockers.push(`only ${ev.oosHold}/${ev.variants} variants held OOS (≤ half) — selection looks like noise`);

  // ── advocate: what the metrics PROVE (cleared bars only) ──
  const advocate: string[] = [];
  if (ev.cumPnlPct != null && ev.cumPnlPct > 0) advocate.push(`cumulative PnL ${pct(ev.cumPnlPct)} net of ${ev.feeBps}bps fees over ${ev.bars} ${unit}`);
  if (ev.oosSharpeAnn != null && ev.oosSharpeAnn > 0) advocate.push(`OOS ann.Sharpe ${ev.oosSharpeAnn.toFixed(2)} HELD out-of-sample (walk-forward)`);
  if (holdFrac != null && holdFrac > thr.minOosHoldFrac) advocate.push(`${ev.oosHold}/${ev.variants} variants held OOS (majority-robust selection)`);
  if (ev.pbo != null && ev.pbo < thr.pboClean) advocate.push(`PBO ${ev.pbo.toFixed(2)} < ${thr.pboClean} — low backtest-overfit probability`);
  if (ev.dsr != null && ev.dsr > thr.dsrClean) advocate.push(`Deflated-Sharpe ${ev.dsr.toFixed(2)} > ${thr.dsrClean} — survives multiple-testing deflation`);
  if (ev.winRate != null && ev.nTrades && ev.nTrades > 0) {
    const floor = wilsonLowerBound(Math.round(ev.winRate * ev.nTrades), ev.nTrades);
    advocate.push(`win ${(ev.winRate * 100).toFixed(1)}% on ${ev.nTrades} trades, Wilson floor ${(floor * 100).toFixed(1)}%`);
  }

  if (blockers.length) {
    return { verdict: "REPAIR_FIRST", action: "do NOT deploy — fix the blocker(s) before the edge claim is meaningful", advocate, skeptic: blockers };
  }

  // ── no blockers → at least PROVE_IT; promote only when robustness-clean ──
  const gaps: string[] = [];
  if (ev.oosSharpeAnn == null) gaps.push("no walk-forward OOS Sharpe computed — out-of-sample not yet proven");
  if (ev.pbo == null) gaps.push("PBO not computed — overfit not yet ruled out");
  else if (ev.pbo >= thr.pboClean) gaps.push(`PBO ${ev.pbo.toFixed(2)} ≥ ${thr.pboClean} — borderline overfit`);
  if (ev.dsr == null) gaps.push("Deflated-Sharpe not computed — multiple-testing not ruled out");
  else if (ev.dsr <= thr.dsrClean) gaps.push(`Deflated-Sharpe ${ev.dsr.toFixed(2)} short of ${thr.dsrClean} — multiple-testing not fully ruled out`);
  if (ev.regimesCovered != null && ev.regimesCovered > 0 && ev.regimesCovered < thr.minRegimes) {
    gaps.push(`only ${ev.regimesCovered} market regime(s) in the sample — unproven across regimes`);
  }

  if (gaps.length === 0) {
    const next = ev.liveSmokeBars ? `forward paper/live-smoke continuation (${ev.liveSmokeBars} ${unit} so far)` : "forward paper/live-smoke continuation";
    return {
      verdict: "ADVOCATE_APPROVED",
      action: "promote to monitored paper/live-smoke candidate with stake caps",
      advocate,
      skeptic: [`no audit blockers; next proof is ${next}`],
    };
  }
  return { verdict: "PROVE_IT", action: "keep in research — close the gap(s) below before promotion", advocate, skeptic: gaps };
}

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
  /**
   * What the strategy is TRYING to do, so it is judged on the right axis:
   *   "edge"       — ROI-max / convexity: "how much can we make?" → Sharpe → walk-forward
   *                  → PBO → Deflated-Sharpe (the default).
   *   "penny_lock" — high-confidence certainty: "can we keep winning and still be net
   *                  positive?" → win rate + Wilson CI-low + net-positive, NOT ROI size.
   *                  A $2→$2.01 trade should not be judged against convexity strategies.
   */
  objective?: "edge" | "penny_lock";
  /** Sample length; unit named by `sampleUnit` (default "bars"). */
  bars: number;
  sampleUnit?: string;
  /** Fee assumption the PnL is net of (bps). */
  feeBps: number;
  // ── penny-lock evidence ──
  /** Realized net ROI %, net of fees (can be tiny — that is the point). */
  netRoiPct?: number;
  /** Average win / average loss per trade (% magnitudes) → the break-even win rate. */
  avgWinPct?: number;
  avgLossPct?: number;
  /** Max drawdown fraction (0..1) — a universal risk blocker if it breaches `ddCeil`. */
  maxDdPct?: number;
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
  /** Max-drawdown ceiling (fraction) — breaching it is a universal REPAIR_FIRST blocker. */
  ddCeil: number;
  // penny-lock objective
  pennyMinTrades: number;  // min trades to establish a high win rate
  pennyWinFloor: number;   // CI-low floor when no payoff given (high-confidence assumption)
  pennyMargin: number;     // required CI-low margin over break-even for approval
};
export const DEFAULT_PROOF_THRESHOLDS: ProofThresholds = {
  minBars: 60, pboHard: 0.5, pboClean: 0.3, dsrClean: 0.95, minRegimes: 2, minOosHoldFrac: 0.5,
  ddCeil: 0.25, pennyMinTrades: 100, pennyWinFloor: 0.9, pennyMargin: 0.02,
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
  if (ev.objective === "penny_lock") return pennyLockCouncil(ev, thr);
  const unit = ev.sampleUnit ?? "bars";
  const holdFrac = ev.variants && ev.variants > 0 ? (ev.oosHold ?? 0) / ev.variants : undefined;

  // ── blockers: artifacts that make the edge claim meaningless (→ REPAIR_FIRST) ──
  const blockers: string[] = [];
  if (ev.bars < thr.minBars) blockers.push(`sample only ${ev.bars} ${unit} (< ${thr.minBars}) — too short to test an edge`);
  if (ev.oosSharpeAnn != null && ev.oosSharpeAnn <= 0) blockers.push(`OOS Sharpe ${ev.oosSharpeAnn.toFixed(2)} ≤ 0 — the edge FADED out-of-sample`);
  if (ev.cumPnlPct != null && ev.cumPnlPct < 0) blockers.push(`cumulative PnL ${pct(ev.cumPnlPct)} is negative net of ${ev.feeBps}bps fees`);
  if (ev.pbo != null && ev.pbo > thr.pboHard) blockers.push(`PBO ${ev.pbo.toFixed(2)} > ${thr.pboHard} — backtest is overfit (IS-best underperforms OOS)`);
  if (holdFrac != null && (ev.variants ?? 0) > 1 && holdFrac <= thr.minOosHoldFrac) blockers.push(`only ${ev.oosHold}/${ev.variants} variants held OOS (≤ half) — selection looks like noise`);
  if (ev.maxDdPct != null && ev.maxDdPct > thr.ddCeil) blockers.push(`max drawdown ${(ev.maxDdPct * 100).toFixed(1)}% > ${(thr.ddCeil * 100).toFixed(0)}% ceiling — risk too high to deploy`);

  // ── advocate: what the metrics PROVE (cleared bars only) ──
  const advocate: string[] = [];
  if (ev.cumPnlPct != null && ev.cumPnlPct > 0) advocate.push(`cumulative PnL ${pct(ev.cumPnlPct)} net of ${ev.feeBps}bps fees over ${ev.bars} ${unit}`);
  if (ev.maxDdPct != null && ev.maxDdPct <= thr.ddCeil) advocate.push(`max drawdown ${(ev.maxDdPct * 100).toFixed(1)}% within the ${(thr.ddCeil * 100).toFixed(0)}% ceiling`);
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

/**
 * Penny-Lock Certainty — judge a high-confidence, tiny-edge strategy on ITS OWN objective:
 * "can we keep winning AND stay net positive?" A $2→$2.01 trade is evaluated on win rate
 * (Wilson CI-low) clearing its break-even + a positive realized net ROI — NOT on ROI size.
 * The skeptic guards the real risk: the left-tail asymmetry (small wins, occasional big
 * loss) → require the CI-low win rate comfortably above break-even.
 */
function pennyLockCouncil(ev: StrategyEvidence, thr: ProofThresholds): ProofCouncilResult {
  const unit = ev.sampleUnit ?? "trades";
  const n = ev.nTrades ?? 0;
  const wr = Math.max(0, Math.min(1, ev.winRate ?? 0));
  const ciLow = wilsonLowerBound(Math.round(wr * n), n);
  // break-even win rate from the payoff asymmetry (avgLoss / (avgWin + avgLoss)), if given;
  // else assume a high-confidence win floor (you didn't tell me the payoff).
  const breakEven = (ev.avgWinPct != null && ev.avgLossPct != null && ev.avgWinPct + ev.avgLossPct > 0)
    ? ev.avgLossPct / (ev.avgWinPct + ev.avgLossPct) : undefined;
  const winBar = breakEven ?? thr.pennyWinFloor;
  const barName = breakEven != null ? "break-even" : `${(thr.pennyWinFloor * 100).toFixed(0)}% win floor`;

  // advocate — penny-lock framing: keep winning + net positive (NOT how much)
  const advocate: string[] = [];
  if (ev.netRoiPct != null && ev.netRoiPct > 0) advocate.push(`net ROI ${pct(ev.netRoiPct)} on ${n} ${unit} — net positive even if tiny (the penny-lock objective)`);
  if (n > 0) advocate.push(`win ${(wr * 100).toFixed(1)}% on ${n} ${unit}, Wilson CI-low ${(ciLow * 100).toFixed(1)}%`);
  if (breakEven != null) advocate.push(`CI-low ${(ciLow * 100).toFixed(1)}% clears the ${(breakEven * 100).toFixed(1)}% break-even for a +${ev.avgWinPct}%/−${ev.avgLossPct}% payoff`);
  if (ev.maxDdPct != null && ev.maxDdPct <= thr.ddCeil) advocate.push(`max drawdown ${(ev.maxDdPct * 100).toFixed(1)}% within the ${(thr.ddCeil * 100).toFixed(0)}% ceiling`);

  // blockers (→ REPAIR_FIRST): fails the penny-lock objective itself
  const blockers: string[] = [];
  if (n < thr.pennyMinTrades) blockers.push(`sample only ${n} ${unit} (< ${thr.pennyMinTrades}) — a high win rate is not yet established`);
  if (ev.netRoiPct != null && ev.netRoiPct <= 0) blockers.push(`net ROI ${pct(ev.netRoiPct)} ≤ 0 — a penny-lock that isn't net positive fails its own objective`);
  if (n >= thr.pennyMinTrades && ciLow <= winBar) blockers.push(`Wilson CI-low ${(ciLow * 100).toFixed(1)}% not above the ${(winBar * 100).toFixed(1)}% ${barName} — not provably a repeatable win`);
  if (ev.maxDdPct != null && ev.maxDdPct > thr.ddCeil) blockers.push(`max drawdown ${(ev.maxDdPct * 100).toFixed(1)}% > ${(thr.ddCeil * 100).toFixed(0)}% ceiling — risk too high to deploy`);
  if (blockers.length) return { verdict: "REPAIR_FIRST", action: "do NOT deploy — the penny-lock objective (keep winning + stay net positive) is not met", advocate, skeptic: blockers };

  // gaps (→ PROVE_IT)
  const gaps: string[] = [];
  if (ev.netRoiPct == null) gaps.push("net ROI not measured — net-positive (the objective) not yet confirmed");
  if (breakEven != null && ciLow - breakEven < thr.pennyMargin) {
    gaps.push(`CI-low margin over break-even is only ${((ciLow - breakEven) * 100).toFixed(1)} pts — a small win-rate decay flips it negative; widen the sample`);
  }
  if (gaps.length) return { verdict: "PROVE_IT", action: "keep in research — confirm the win rate holds (tighter CI / payoff) before promotion", advocate, skeptic: gaps };

  const note = breakEven == null ? ` (payoff not given → assumed the ${(thr.pennyWinFloor * 100).toFixed(0)}% floor)` : "";
  return {
    verdict: "ADVOCATE_APPROVED",
    action: "promote as a high-confidence penny-lock candidate — TIGHT stake caps + a left-tail kill (wins are small; one fat loss erases many)",
    advocate,
    skeptic: [`no audit blockers${note}; next proof is forward live-smoke continuation — watch for win-rate decay below ${(winBar * 100).toFixed(1)}%`],
  };
}

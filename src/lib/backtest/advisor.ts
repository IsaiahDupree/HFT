/**
 * advisor — ONE VOICE that holds both sides. An advocate makes the affirmative case (why BUY,
 * why TRADE); a skeptic makes the case against (why not); then a single judgment weighs them and
 * lands on one recommendation, the way an honest PM memo does. It composes everything the stack
 * knows about a strategy:
 *   • beta-vs-alpha          (tradeAdvocate — is the ROI edge, beta, or a concentration artifact?)
 *   • the overfit gauntlet   (PBO / Deflated-Sharpe / OOS)
 *   • DATA INTEGRITY         (warehouse splice + cross-venue agreement — can we trust the inputs?)
 *   • MULTIPLE TESTING       (was the "edge" found by scanning N cells? then correct for N)
 *
 * The point of the affirmative voice: when there IS a reason to act it says so plainly — and the
 * most common honest "why buy" is "buy the BETA: the basket compounds, the strategy doesn't add
 * to it." STAND_ASIDE is reserved for when the data itself can't be trusted. Pure + deterministic.
 */
import { tradeAdvocate, type TradeCase, type TradeAdvice, type AdvocateThresholds, DEFAULT_ADVOCATE_THRESHOLDS } from "./trade-advocate";

export type DataIntegrity = {
  /** A composition cliff in the universe (universeHealth.spliceSuspected) → the benchmark changes mid-sample. */
  spliceSuspected?: boolean;
  /** Second-source agreement (crossVenueAgreement.verdict). "suspect" = a venue disagrees on price. */
  crossVenueVerdict?: "agree" | "minor_drift" | "suspect";
};

export type SearchContext = {
  /** How many hypotheses were scanned to surface this (e.g. strategy×regime cells). */
  hypothesesScanned?: number;
  /** How many cleared a multiple-testing (Bonferroni) bar. */
  bonferroniSurvivors?: number;
};

export type AdvisorInput = TradeCase & {
  /** Optionally override the "is buy-and-hold itself worth owning?" judgment (else derived from beta Sharpe). */
  betaAttractive?: boolean;
  data?: DataIntegrity;
  search?: SearchContext;
};

export type Recommendation = "BUY" | "TRADE_SMALL" | "PAPER" | "HOLD_BETA" | "STAND_ASIDE";

export type TradeMemo = {
  recommendation: Recommendation;
  conviction: number; // 0-100, how strongly the evidence points at the recommendation
  bull: string[];     // the advocate: why BUY / why TRADE
  bear: string[];     // the skeptic: why not
  voice: string;      // ONE synthesized paragraph weighing both sides
  advice: TradeAdvice; // the underlying beta/alpha verdict
};

const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));

export function adviseTrade(input: AdvisorInput, thr: AdvocateThresholds = DEFAULT_ADVOCATE_THRESHOLDS): TradeMemo {
  const advice = tradeAdvocate(input, thr);
  const m = advice.metrics;
  const data = input.data ?? {};
  const search = input.search ?? {};
  const betaAttractive = input.betaAttractive ?? m.betaSharpe > 0.5; // a basket that compounds is worth holding
  const scanned = search.hypothesesScanned ?? 0;
  const survivors = search.bonferroniSurvivors ?? 0;
  const dataBroken = data.spliceSuspected === true;
  const dataSuspect = data.crossVenueVerdict === "suspect";

  const bull: string[] = [];
  const bear: string[] = [];
  let conviction = 50;

  // ---- BULL: why buy / why trade ----
  if (m.alphaSharpeOos > 0 && advice.roiVerdict === "real_edge") { bull.push(`genuine alpha over beta out-of-sample (excess Sharpe ${m.alphaSharpeOos.toFixed(2)})`); conviction += 22; }
  if (input.pbo != null && input.pbo < thr.pboClean) { bull.push(`low overfit (PBO ${input.pbo.toFixed(2)} < ${thr.pboClean})`); conviction += 10; }
  if (input.dsr != null && input.dsr > thr.dsrClean) { bull.push(`survives multiple-testing deflation (DSR ${input.dsr.toFixed(2)})`); conviction += 10; }
  if (survivors > 0) { bull.push(`${survivors} cell(s) cleared the Bonferroni bar`); conviction += 14; }
  if (betaAttractive) bull.push(`the basket itself compounds (buy-and-hold Sharpe ${m.betaSharpe.toFixed(2)}) — owning BETA is rational even if the strategy adds nothing`);
  if (m.strategyCumPct > 0 && m.strategySharpe > 0) bull.push(`positive history: ${m.strategyCumPct >= 0 ? "+" : ""}${(m.strategyCumPct * 100).toFixed(0)}% cum at Sharpe ${m.strategySharpe.toFixed(2)}`);
  if (!dataBroken && !dataSuspect && data.crossVenueVerdict) { bull.push(`inputs corroborated by a second venue (${data.crossVenueVerdict})`); conviction += 4; }

  // ---- BEAR: why not ----
  if (dataBroken) { bear.push(`DATA INTEGRITY: a universe splice changes the benchmark mid-sample — the comparison itself can't be trusted`); conviction -= 40; }
  if (dataSuspect) { bear.push(`a second venue disagrees on price (cross-venue: suspect) — inputs may be corrupted`); conviction -= 15; }
  if (advice.roiVerdict === "artifact_risk") { bear.push(`${(m.topBarShare * 100).toFixed(0)}% of the return is in a few bars — likely an artifact, audit the data`); conviction -= 30; }
  if (advice.roiVerdict === "too_thin") { bear.push(`sample too short (${m.bars} bars) to validate anything`); conviction -= 30; }
  if (advice.roiVerdict === "underperforms_beta") { bear.push(`buy-and-hold did BETTER (${(m.betaCumPct * 100).toFixed(0)}% vs ${(m.strategyCumPct * 100).toFixed(0)}%) — the ROI is worse-captured beta`); conviction -= 25; }
  if (advice.roiVerdict === "beta_not_alpha") { bear.push(`no alpha out-of-sample (excess-over-beta Sharpe ${m.alphaSharpeOos.toFixed(2)} ≤ 0) — it's market beta`); conviction -= 25; }
  if (input.pbo != null && input.pbo >= thr.pboClean) { bear.push(`overfit config selection (PBO ${input.pbo.toFixed(2)} ≥ ${thr.pboClean})`); conviction -= 12; }
  if (input.dsr != null && input.dsr <= thr.dsrClean) { bear.push(`not deflation-clean (DSR ${input.dsr.toFixed(2)} ≤ ${thr.dsrClean})`); conviction -= 6; }
  if (scanned > 0 && survivors === 0) { bear.push(`the "edge" was found by scanning ${scanned} cells and 0 survive multiple-testing correction`); conviction -= 20; }

  // ---- ONE VOICE: synthesize a single recommendation ----
  let recommendation: Recommendation;
  let decisive: string;
  if (dataBroken || advice.roiVerdict === "artifact_risk" || advice.roiVerdict === "too_thin") {
    recommendation = "STAND_ASIDE";
    decisive = dataBroken
      ? "I can't make a call on a benchmark that changes composition mid-sample — fix the data first."
      : "the numbers aren't trustworthy enough to act on; this is a data problem, not a trade.";
  } else if (advice.roiVerdict === "real_edge") {
    const robust = (input.pbo == null || input.pbo < thr.pboClean) && (input.dsr == null || input.dsr > thr.dsrClean) && advice.recommendation === "TRADE";
    const scanClean = scanned === 0 || survivors > 0;
    if (robust && scanClean && !dataSuspect) { recommendation = "BUY"; decisive = "it beats holding the basket out-of-sample and clears the overfit + data checks — the affirmative case stands."; }
    else if (robust && scanClean) { recommendation = "TRADE_SMALL"; decisive = "the edge is real but a data caveat remains — size small and monitor."; }
    else { recommendation = "PAPER"; decisive = scanned > 0 && survivors === 0 ? "it beats beta in-window but was found by scanning and doesn't survive correction — paper it before risking capital." : "promising but not robust enough to size live yet — paper it."; }
  } else {
    // underperforms_beta / beta_not_alpha → it's beta. The honest "why buy" is: buy the beta.
    if (betaAttractive) { recommendation = "HOLD_BETA"; decisive = "the strategy is just (worse-captured) beta, so the real reason to buy is the BASKET — hold equal-weight, skip the machinery."; }
    else { recommendation = "STAND_ASIDE"; decisive = "it's beta and the beta isn't even attractive — nothing here is worth owning right now."; }
  }
  conviction = clamp(conviction);

  const top = (xs: string[], n: number) => xs.slice(0, n).join("; ") || "—";
  const voice = `${recommendation} (conviction ${conviction}/100). The case to act: ${top(bull, 2)}. The case against: ${top(bear, 2)}. Net: ${decisive}`;

  return { recommendation, conviction, bull, bear, voice, advice };
}

export function renderTradeMemo(memo: TradeMemo): string {
  const lines = [
    `ADVISOR — ${memo.recommendation}  (conviction ${memo.conviction}/100)`,
    "",
    "ADVOCATE (why buy / why trade):",
    ...(memo.bull.length ? memo.bull.map((x) => `  + ${x}`) : ["  + (nothing genuinely cleared its bar)"]),
    "",
    "SKEPTIC (why not):",
    ...(memo.bear.length ? memo.bear.map((x) => `  - ${x}`) : ["  - (no material objection)"]),
    "",
    "ONE VOICE:",
    `  ${memo.voice}`,
  ];
  return lines.join("\n");
}

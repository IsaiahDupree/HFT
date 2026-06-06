/**
 * continuation-ev — the GO-WITH-THE-MARKET core of the evolved policy. The strategy is NOT "prove the market
 * wrong" (pure value betting on true-prob vs implied-prob); it is riding a move that is ALREADY happening when
 * the target/stop math is favorable and the edge hasn't been arbitraged away. This implements the policy's exact
 * continuation-EV formulas for a binary share bought at entry E:
 *
 *   reward = T − E ,  loss = E − S
 *   EV_continuation = q_continue · reward − (1 − q_continue) · loss − C        (price units)
 *   EV_ROI          = EV_continuation / E
 *   q_break_even    = loss / (reward + loss)
 *
 * where T = target exit (or 1.0 to hold to a win), S = stop/failure exit, C = spread+slippage+fees+delay,
 * q_continue = P(the move continues far enough for the plan to profit). Pure + deterministic. The break-even
 * continuation prob IS the odds-implied probability, so Kelly sizing reuses kellyFraction(q_continue, q_break_even).
 */
import { kellyFraction, suggestSize, type FinalAction } from "./recommendation";

export type ContinuationInputs = {
  entry: number;       // E — executable entry price ∈ (0,1)
  target: number;      // T — target exit (≤1)
  stop: number;        // S — stop/failure exit (≥0)
  qContinue: number;   // probability the move continues far enough
  costs?: number;      // C — spread+slippage+fees+delay, in price units (default 0)
};

export type ContinuationEv = {
  reward: number; loss: number; rewardToLoss: number;
  breakEvenQ: number;        // loss/(reward+loss) — the odds-implied continuation prob
  evContinuation: number;    // price units
  evRoi: number;             // EV_continuation / E
  edgeQ: number;             // q_continue − q_break_even (margin above break-even)
};

export function continuationEv(i: ContinuationInputs): ContinuationEv {
  const reward = i.target - i.entry, loss = i.entry - i.stop, C = i.costs ?? 0;
  const q = Math.max(0, Math.min(1, i.qContinue));
  const rewardToLoss = loss > 0 ? reward / loss : reward > 0 ? Infinity : 0;
  const breakEvenQ = reward + loss > 0 ? loss / (reward + loss) : 1;
  const evContinuation = q * reward - (1 - q) * loss - C;
  return {
    reward, loss, rewardToLoss, breakEvenQ,
    evContinuation, evRoi: i.entry > 0 ? evContinuation / i.entry : 0,
    edgeQ: q - breakEvenQ,
  };
}

export type ContinuationRecommendation = {
  market: string; side: "BUY" | "SELL"; entry: number; target: number; stop: number;
  qContinue: number; rewardToLoss: number; breakEvenQ: number; evContinuation: number; evRoi: number;
  confidence: number; liquidityUsd: number | null; suggestedSizeUsd: number;
  reasoning: string; tailRisk: string; copySignal: string | null; finalAction: FinalAction;
};

export type ContinuationRecInput = ContinuationInputs & {
  market: string; side?: "BUY" | "SELL"; bankrollUsd: number; liquidityUsd?: number | null;
  minEvRoi?: number; minEdgeQ?: number; copySignal?: string | null; tailRisk?: string;
};

/**
 * Build a continuation trade recommendation. BUY when EV_ROI clears the bar AND q_continue sits a margin above
 * break-even AND the trade is liquid; size by fractional-Kelly on the reward/loss odds, confidence-scaled.
 */
export function continuationRecommendation(c: ContinuationRecInput): ContinuationRecommendation {
  const ev = continuationEv(c);
  const minEvRoi = c.minEvRoi ?? 0.05, minEdgeQ = c.minEdgeQ ?? 0.05;
  const kelly = kellyFraction(c.qContinue, ev.breakEvenQ);          // break-even prob = odds-implied prob
  const confidence = Math.max(0, Math.min(1, ev.edgeQ / 0.3));      // edge of +30pts over break-even ≈ full confidence
  const ok = ev.evRoi >= minEvRoi && ev.edgeQ >= minEdgeQ && ev.reward > 0 && ev.loss > 0;
  const size = ok ? suggestSize(kelly, confidence, { bankrollUsd: c.bankrollUsd }) : 0;
  const finalAction: FinalAction = ok && size > 0 ? "DEPLOY" : ev.evRoi > 0 ? "WATCH" : "STAND_ASIDE";
  return {
    market: c.market, side: c.side ?? "BUY", entry: c.entry, target: c.target, stop: c.stop,
    qContinue: c.qContinue, rewardToLoss: ev.rewardToLoss, breakEvenQ: ev.breakEvenQ,
    evContinuation: ev.evContinuation, evRoi: ev.evRoi, confidence, liquidityUsd: c.liquidityUsd ?? null,
    suggestedSizeUsd: size,
    reasoning: `continuation: entry ${c.entry.toFixed(2)} → target ${c.target.toFixed(2)} (R/L ${ev.rewardToLoss.toFixed(1)}), q_continue ${(c.qContinue * 100).toFixed(0)}% vs break-even ${(ev.breakEvenQ * 100).toFixed(0)}% → EV_ROI ${(ev.evRoi * 100).toFixed(0)}%`,
    tailRisk: c.tailRisk ?? "the move stalls/reverses before target; thin book can't exit at the stop; resolution-rule surprise",
    copySignal: c.copySignal ?? null, finalAction,
  };
}

/** Pretty-print in the policy's continuation decision format. */
export function formatContinuation(r: ContinuationRecommendation): string {
  return [
    `- Market: ${r.market}`,
    `- Side: ${r.side}`,
    `- Entry price: ${r.entry.toFixed(3)}`,
    `- Target exit/resolution: ${r.target.toFixed(3)}`,
    `- Stop/failure exit: ${r.stop.toFixed(3)}`,
    `- Continuation probability: ${(r.qContinue * 100).toFixed(0)}%`,
    `- Reward-to-loss ratio: ${r.rewardToLoss === Infinity ? "∞" : r.rewardToLoss.toFixed(2)}`,
    `- Break-even continuation probability: ${(r.breakEvenQ * 100).toFixed(0)}%`,
    `- EV_continuation: ${r.evContinuation >= 0 ? "+" : ""}${r.evContinuation.toFixed(3)}`,
    `- EV_ROI: ${r.evRoi >= 0 ? "+" : ""}${(r.evRoi * 100).toFixed(0)}%`,
    `- Confidence: ${(r.confidence * 100).toFixed(0)}%`,
    `- Liquidity/spread: ${r.liquidityUsd == null ? "—" : `$${(r.liquidityUsd / 1000).toFixed(0)}k`}`,
    `- Suggested size: $${r.suggestedSizeUsd}`,
    `- Reasoning: ${r.reasoning}`,
    `- What could make this wrong: ${r.tailRisk}`,
    `- Copy-trade signal, if any: ${r.copySignal ?? "none"}`,
    `- Final action: ${r.finalAction === "DEPLOY" ? "buy" : r.finalAction === "WATCH" ? "wait" : "skip"}`,
  ].join("\n");
}

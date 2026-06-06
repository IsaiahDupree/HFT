/**
 * strategy-selector — the META decision: given the current market regime, which carry/structural strategy
 * should we DEPLOY next? This is the pure, testable core of the agent-loop-design investigation: a realistic
 * economic ground-truth (net expected APR per strategy, encoding the real constraints — unhedgeable funding,
 * fees, tail risk, the T-bill floor), plus the two non-LLM CONTROLS every agent loop must be measured against:
 *   • deterministicSelect — argmax of the SAME net-return model applied to the (noisy) observed features.
 *     A strong, principled baseline. The §7.6 discipline: an LLM loop only earns its place if it beats THIS.
 *   • naiveSelect — "pick the biggest raw signal", ignoring constraints. The weak control that TRAP regimes
 *     (fat funding but no hedge; fat signal but high tail risk) are designed to fool.
 * No I/O, no LLM — the loop designs (single/ensemble/debate/reflexion) live in the bench script and are scored
 * against these.
 */

export const STRATEGIES = ["funding_carry", "calendar_basis", "vol_risk_premium", "staking_hedged", "sit_out"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export type MarketFeatures = {
  fundingApr: number;          // durable (median) funding APR on the best hedgeable name, % (signed)
  fundingPersistence: number;  // 0.5..1 sign-stability
  hedgeAvailable: boolean;     // is there a real, same-venue, deep spot hedge? (false ⇒ funding carry undeployable)
  basisAnnApr: number;         // best quarterly annualized dated-futures basis, %
  ivMinusRv: number;           // implied − realized vol, vol points (the VRP signal)
  stakeApy: number;            // best staking yield, %
  tailRisk: number;            // 0..1, elevated ⇒ haircut every risky sleeve / prefer sit-out
  riskFreeApr: number;         // T-bill, % — the opportunity-cost floor (sit_out's payoff)
};

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Net expected APR per strategy — the economic ground-truth. Encodes the real frictions + constraints. */
export function strategyNetReturns(f: MarketFeatures): Record<Strategy, number> {
  const tail = 1 - 0.7 * clamp(f.tailRisk, 0, 1);                                   // tail haircut on risky sleeves
  return {
    // funding carry needs a real hedge; nets |funding| − ~3% fee drag, persistence-weighted, tail-hit
    funding_carry: f.hedgeAvailable ? Math.max(0, Math.abs(f.fundingApr) - 3) * f.fundingPersistence * tail : -100,
    // calendar basis nets basis − ~1.5% all-in fees, tail-hit (convergence locked, so lighter tail than VRP)
    calendar_basis: Math.max(0, f.basisAnnApr - 1.5) * tail,
    // VRP harvests ~60% of the iv−rv gap but pays a steep penalty in a high-tail regime (sell-vol left tail)
    vol_risk_premium: Math.max(0, f.ivMinusRv * 0.6) * tail - (f.tailRisk > 0.6 ? 5 : 0),
    // staking yield + a slice of positive funding; less tail-sensitive but carries its own (unbond/slash) drag
    staking_hedged: Math.max(0, (f.stakeApy + Math.max(0, f.fundingApr) * 0.3) * tail - 1),
    // the floor: take the risk-free rate, deploy nothing
    sit_out: f.riskFreeApr,
  };
}

const argmax = (net: Record<Strategy, number>): Strategy => STRATEGIES.reduce((best, s) => (net[s] > net[best] ? s : best), STRATEGIES[0]);

/** Ground truth: the strategy with the highest net expected return (computed on CLEAN, noise-free features). */
export function groundTruthBest(cleanFeatures: MarketFeatures): Strategy { return argmax(strategyNetReturns(cleanFeatures)); }

/** Strong control: apply the correct net-return model to the OBSERVED (noisy) features and take the argmax. */
export function deterministicSelect(observed: MarketFeatures): Strategy { return argmax(strategyNetReturns(observed)); }

/** Weak control: pick the biggest RAW signal, blind to hedge availability / tail risk / the T-bill floor. */
export function naiveSelect(f: MarketFeatures): Strategy {
  const raw: Record<Strategy, number> = {
    funding_carry: Math.abs(f.fundingApr), calendar_basis: f.basisAnnApr, vol_risk_premium: f.ivMinusRv,
    staking_hedged: f.stakeApy, sit_out: f.riskFreeApr,
  };
  return argmax(raw);
}

/** Majority vote (ties → the candidate appearing earliest in STRATEGIES order, for determinism). */
export function majorityVote(picks: readonly Strategy[]): Strategy {
  const counts = new Map<Strategy, number>();
  for (const p of picks) counts.set(p, (counts.get(p) ?? 0) + 1);
  let best: Strategy = STRATEGIES[0], bestN = -1;
  for (const s of STRATEGIES) { const n = counts.get(s) ?? 0; if (n > bestN) { best = s; bestN = n; } }
  return best;
}

export type Scored = { accuracy: number; meanRegretApr: number; n: number };
/**
 * Score a set of picks vs ground truth. accuracy = exact-match rate; regret = mean (bestNet − pickedNet) in APR
 * points using each regime's CLEAN net returns (you're judged on the real outcome, not the noisy view).
 */
export function scoreRun(picks: readonly Strategy[], truths: readonly Strategy[], cleanNets: ReadonlyArray<Record<Strategy, number>>): Scored {
  let correct = 0, regret = 0;
  for (let i = 0; i < picks.length; i++) {
    if (picks[i] === truths[i]) correct++;
    const net = cleanNets[i];
    regret += net[truths[i]] - net[picks[i]];
  }
  const n = picks.length || 1;
  return { accuracy: correct / n, meanRegretApr: regret / n, n: picks.length };
}

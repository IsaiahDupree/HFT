/**
 * carry-triggers — the pure "should I care yet?" logic for the carry monitor. Both carries are real but
 * REGIME-GATED: today neither beats T-bills (HYPE funding sits at the +11% floor → ~+8% net; the BTC/ETH
 * basis is ~3% gross, below risk-free). They only become deployable when the regime fattens. This maps a
 * candidate's gross yield + executability to one of three states, and detects an ESCALATION worth alerting:
 *   • off   — yield too thin to care (the normal state)
 *   • watch — yield crossed the "regime is forming" line (gross ≥ watch bar)
 *   • armed — yield is fat AND the trade is actually executable (real hedge, no blockers) → deploy candidate
 *
 * Thresholds come from the 2026-06-05 deep-dive: funding deploy trigger ≈ durable funding > +16% APR;
 * calendar deploy trigger ≈ quarterly gross ≥ 9.5% (risk-free ~4.5% + a ~3% real risk spread), watch at the
 * ~6.3% risk-free-parity line. Pure + deterministic; no I/O.
 */

export type TriggerState = "off" | "watch" | "armed";

export type TriggerCfg = {
  armGrossApr: number;    // gross APR at/above which the regime is fat enough to DEPLOY (if executable)
  watchGrossApr: number;  // gross APR at/above which to start WATCHING (regime forming)
};

/** Funding carry: gross = |durable (median) funding APR|. Arm at +16% (deep-dive trigger); watch at +13%,
 *  deliberately ABOVE Hyperliquid's ~+11% funding FLOOR so the boring baseline never trips an alert. */
export const FUNDING_TRIGGER: TriggerCfg = { armGrossApr: 16, watchGrossApr: 13 };
/** Calendar basis: gross = annualized basis. Arm at 9.5% (RF+3% spread), watch at 6.3% (RF parity). */
export const CALENDAR_TRIGGER: TriggerCfg = { armGrossApr: 9.5, watchGrossApr: 6.3 };

const RANK: Record<TriggerState, number> = { off: 0, watch: 1, armed: 2 };

/**
 * Map a candidate to a trigger state.
 * @param grossApr the regime signal — |durable funding APR| (funding) or annualized basis (calendar)
 * @param executable true ⇒ the executor produced a plan with NO blockers (real hedge, clears the net bar)
 */
export function triggerState(grossApr: number, executable: boolean, cfg: TriggerCfg): { state: TriggerState; reason: string } {
  const g = Math.abs(grossApr);
  if (g >= cfg.armGrossApr && executable) return { state: "armed", reason: `gross ${g.toFixed(1)}% ≥ arm ${cfg.armGrossApr}% AND executable — DEPLOY CANDIDATE` };
  if (g >= cfg.armGrossApr && !executable) return { state: "watch", reason: `gross ${g.toFixed(1)}% ≥ arm ${cfg.armGrossApr}% but NOT executable (hedge/borrow/depth blocker) — watching` };
  if (g >= cfg.watchGrossApr) return { state: "watch", reason: `gross ${g.toFixed(1)}% ≥ watch ${cfg.watchGrossApr}% — regime forming` };
  return { state: "off", reason: `gross ${g.toFixed(1)}% < watch ${cfg.watchGrossApr}% — thin` };
}

/** An ESCALATION (rank increased) is worth alerting; a de-escalation or no-change is not. prev=null ⇒ first sighting: alert only if already ≥ watch. */
export function isEscalation(prev: TriggerState | null, cur: TriggerState): boolean {
  if (prev === null) return RANK[cur] >= RANK.watch;
  return RANK[cur] > RANK[prev];
}

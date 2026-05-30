/**
 * Release stages for strategy_versions. Borrowed from TradingBot/src/marketplace/release_stage.py
 * and adapted to the Polymarket workspace where stages are explicit on a
 * version rather than derived from a generation count.
 *
 * Stages:
 *   sim            — never trades real capital; runs against snapshots only
 *   paper          — submits but only through a paper/sim venue adapter
 *   live_eligible  — backtest passed, awaiting capsule binding
 *   live           — actively trades against allocated capsule capital
 *   restricted     — flagged (high drawdown, broken auth, manual hold)
 */

export type ReleaseStage = "sim" | "paper" | "live_eligible" | "live" | "restricted";

export const STAGES_ALLOW_LIVE: ReadonlySet<ReleaseStage> = new Set<ReleaseStage>(["live"]);
export const STAGES_ALLOW_PAPER: ReadonlySet<ReleaseStage> = new Set<ReleaseStage>(["paper", "live_eligible", "live"]);

/** Promotion ladder — each stage may only advance to one of these. */
export const NEXT_STAGES: Record<ReleaseStage, ReleaseStage[]> = {
  sim: ["paper", "restricted"],
  paper: ["live_eligible", "sim", "restricted"],
  live_eligible: ["live", "paper", "restricted"],
  live: ["paper", "restricted"],
  restricted: ["sim"],
};

export function canPromoteTo(from: ReleaseStage, to: ReleaseStage): boolean {
  return NEXT_STAGES[from]?.includes(to) ?? false;
}

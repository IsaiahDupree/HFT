/**
 * EV + Kelly safety wrapper for arena entry signals.
 *
 * The Lunar article distilled the only-2 filters that actually matter for
 * binary prediction markets:
 *   1. Expected Value gate — skip if `EV < 5%` (`SKIP` or no-recommendation)
 *   2. Quarter Kelly sizing — never bet more than `kellyFraction(...).betUsd`
 *
 * This module wraps any genome's entry signal in those rails *when the genome
 * opts in* via `risk_rails: "ev_kelly"`. The rail is OFF by default so
 * existing genomes don't change behavior, and so Coinbase entries (continuous-
 * price markets, no binary-outcome semantics) don't get false-positive gates.
 *
 * Coinbase entries always pass through unchanged — EV math only applies to
 * binary outcomes (sim-poly).
 *
 * Spec: `docs/prds/lunar-inspired-arena-strategies.md` §6.1.R1 +
 *        `docs/prds/IMPLEMENTATION-PLAN.md` Phase 2.
 */
import { expectedValue, kellyFraction } from "@/lib/quant/formulas";
import type { LiveAgent, Signal, TickContext } from "./types";

export type RiskRailsResult =
  | { kept: true; signal: Signal; ev?: number; kellyBetUsd?: number; sizeAdjusted: boolean; engaged: boolean }
  | { kept: false; reason: string; ev?: number };

/**
 * Apply EV+Kelly rails to an entry signal. The rail engages automatically when
 * the signal carries a `pTrueEstimate` — that's the opt-in mechanism. Genomes
 * without a probability model (momentum, mean-reversion, etc.) leave it
 * unset and this is a pass-through. Coinbase entries also pass through (no
 * binary-outcome semantics).
 *
 * Returns:
 *   - kept=true, engaged=false → pass-through (no pTrue or not sim-poly)
 *   - kept=true, engaged=true  → rail ran; size may have been clamped
 *   - kept=false               → rail refused; genome holds this tick
 */
export function applyRiskRails(
  signal: Signal,
  ctx: TickContext,
  agent: LiveAgent,
  opts: {
    /** Override the default EV gate (5% per the article). */
    minEv?: number;
    /** Override the default Quarter Kelly fraction. */
    kellyFractionMultiplier?: number;
  } = {},
): RiskRailsResult {
  if (signal.kind !== "entry") return { kept: true, signal, sizeAdjusted: false, engaged: false };
  // Continuous-price venues don't have binary-outcome semantics — Kelly + EV
  // math don't apply meaningfully. Pass through.
  if (signal.venue !== "sim-poly") return { kept: true, signal, sizeAdjusted: false, engaged: false };
  // No pTrue estimate → genome didn't opt in. Pass through.
  if (!signal.pTrueEstimate) return { kept: true, signal, sizeAdjusted: false, engaged: false };

  const win = ctx.snapshots.get(signal.market_id);
  if (!win) return { kept: false, reason: "no market snapshot at decision time" };
  const pMarket = win.latest.price; // poly midpoint IS the implied probability
  if (pMarket <= 0 || pMarket >= 1) {
    return { kept: false, reason: `degenerate pMarket=${pMarket}` };
  }
  const pT = signal.pTrueEstimate.pTrue;

  // Bug #1 (Base Rate Neglect) guardrail: extreme-probability claims need
  // confidence='high' AND a size cap, to keep the system from sizing huge
  // off a single LLM prediction at 5% or 95%+. Per PRD §6.6.R6.
  const EXTREME_LO = 0.05;
  const EXTREME_HI = 0.95;
  const EXTREME_CAP_USD = 10;
  const isExtreme = pT < EXTREME_LO || pT > EXTREME_HI;
  if (isExtreme && signal.pTrueEstimate.confidence !== "high") {
    return { kept: false, reason: `extreme pTrue=${pT.toFixed(2)} requires confidence=high (have ${signal.pTrueEstimate.confidence ?? "unspecified"})` };
  }

  // For SELL entries (shorting YES = buying NO), our pTrue belief should
  // exceed the implied prob of NO, i.e. pTrue < pMarket. Translate by mirroring
  // before the EV gate so the math always evaluates the side we're taking.
  const pTrueForSide = signal.side === "BUY" ? pT : 1 - pT;
  const pMarketForSide = signal.side === "BUY" ? pMarket : 1 - pMarket;

  const ev = expectedValue({ pTrue: pTrueForSide, pMarket: pMarketForSide });
  const minEv = opts.minEv ?? 0.05;
  if (ev.evPerDollar < minEv) {
    return { kept: false, reason: `EV ${(ev.evPerDollar * 100).toFixed(1)}% below ${(minEv * 100).toFixed(1)}% gate`, ev: ev.evPerDollar };
  }

  const kelly = kellyFraction({
    pTrue: pTrueForSide,
    pMarket: pMarketForSide,
    bankrollUsd: agent.cash_usd_current,
    fraction: opts.kellyFractionMultiplier ?? 0.25,
  });
  if (kelly.side === "SKIP" || kelly.betUsd <= 0) {
    return { kept: false, reason: "Kelly recommends SKIP", ev: ev.evPerDollar };
  }
  // Use the smaller of genome-requested size and Kelly-suggested size — the
  // rail can only shrink positions, never grow them. Extreme-probability
  // claims get an additional hard cap (Bug #1 guardrail).
  let adjustedSize = Math.min(signal.size_usd, kelly.betUsd);
  if (isExtreme) adjustedSize = Math.min(adjustedSize, EXTREME_CAP_USD);
  const sizeAdjusted = adjustedSize !== signal.size_usd;
  const newSignal: Signal = sizeAdjusted ? { ...signal, size_usd: adjustedSize } : signal;
  return { kept: true, signal: newSignal, ev: ev.evPerDollar, kellyBetUsd: kelly.betUsd, sizeAdjusted, engaged: true };
}

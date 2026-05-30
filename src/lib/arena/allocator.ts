/**
 * Capital allocator — the ensemble brain that decides **which agents get a
 * capsule of money and why**.
 *
 * Pure + deterministic: given the arena's ranked paper-agents and a capital
 * pool, it produces an allocation plan with a written rationale per agent. The
 * `scripts/arena-allocate.ts` runner does the DB I/O (logging to evolution_log,
 * optionally creating/sizing capsules) — this module stays side-effect-free so
 * it is trivially unit-testable and identical in sim and live.
 *
 * Allocation policy (survivable by construction):
 *   1. Eligibility — an agent must be alive, have ≥ `minTrades` (proof it acts),
 *      and fitness ≥ `minFitness` (no funding negative-edge agents).
 *   2. Selection  — top `maxCapsules` eligible agents by arena fitness.
 *   3. Sizing     — weight ∝ (fitness − minFitness); capped at `maxShare` of the
 *      pool so no single agent dominates; remainder redistributed to the
 *      uncapped. This is the "why" made quantitative — better risk-adjusted
 *      performance earns more capital, but concentration is bounded.
 */
import type { PaperAgentRow } from "./types";
import { rankAgents, type Score } from "./score";

export type AllocationInput = {
  /** Total sim/paper capital to distribute across funded agents. */
  totalBudgetUsd: number;
  /** Fund at most this many agents (one capsule each). */
  maxCapsules: number;
  /** Don't fund any agent below this arena fitness. */
  minFitness: number;
  /** Require at least this many trades (proof the agent actually acts). */
  minTrades: number;
  /** Cap any single capsule at this fraction of the pool (0..1). */
  maxShare: number;
};

export const DEFAULT_ALLOCATION: AllocationInput = {
  totalBudgetUsd: 10_000,
  maxCapsules: 10,
  minFitness: 0,
  minTrades: 1,
  maxShare: 0.25,
};

export type AllocationDecision = {
  agentId: number;
  agentName: string;
  rank: number;
  fitness: number;
  pnlPct: number;
  maxDdPct: number;
  winRate: number;
  trades: number;
  funded: boolean;
  grantUsd: number;
  share: number; // grantUsd / totalBudgetUsd
  reason: string; // the audit-trail "why"
};

export type AllocationPlan = {
  decisions: AllocationDecision[]; // every ranked agent, funded or not
  funded: AllocationDecision[]; // funded subset, largest grant first
  totalAllocatedUsd: number;
  totalBudgetUsd: number;
  generatedAt: string | null; // stamped by the caller (scripts can't use Date.now in workflows)
};

function pct(n: number): number {
  return Math.round(n * 1000) / 10; // 0.1234 -> 12.3
}

/**
 * Distribute `budget` across `weights` (already non-negative), capping any
 * single share at `maxShare` and redistributing the overflow to the uncapped
 * entries proportionally. Iterates to a fixed point so multiple caps settle.
 */
function cappedProportional(weights: number[], budget: number, maxShare: number): number[] {
  const cap = budget * maxShare;
  const grants = new Array(weights.length).fill(0);
  const active = weights.map((w) => w > 0);
  let remaining = budget;
  let wsum = weights.reduce((s, w, i) => s + (active[i] ? w : 0), 0);

  for (let iter = 0; iter < weights.length + 1 && remaining > 1e-6 && wsum > 0; iter++) {
    let cappedThisPass = false;
    const snapshotRemaining = remaining;
    const snapshotWsum = wsum;
    for (let i = 0; i < weights.length; i++) {
      if (!active[i]) continue;
      const want = grants[i] + (weights[i] / snapshotWsum) * snapshotRemaining;
      if (want >= cap) {
        remaining -= cap - grants[i];
        grants[i] = cap;
        active[i] = false;
        wsum -= weights[i];
        cappedThisPass = true;
      }
    }
    if (!cappedThisPass) {
      // No new caps — assign the rest proportionally and stop.
      for (let i = 0; i < weights.length; i++) {
        if (!active[i]) continue;
        grants[i] += (weights[i] / wsum) * remaining;
      }
      remaining = 0;
      break;
    }
  }
  return grants.map((g) => Math.round(g * 100) / 100);
}

export function planAllocations(agents: PaperAgentRow[], input: AllocationInput): AllocationPlan {
  const ranked = rankAgents(agents);

  const eligibleIdx: number[] = [];
  ranked.forEach((r, i) => {
    if (r.agent.alive === 1 && r.score.trades_count >= input.minTrades && r.score.fitness >= input.minFitness) {
      eligibleIdx.push(i);
    }
  });
  const fundedIdx = new Set(eligibleIdx.slice(0, Math.max(0, input.maxCapsules)));

  // Weights for the funded set (shift so the weakest funded agent gets a small,
  // non-zero base weight rather than zero).
  const fundedOrder = [...fundedIdx];
  const weights = fundedOrder.map((i) => Math.max(ranked[i].score.fitness - input.minFitness, 0) + 0.01);
  const grants = cappedProportional(weights, input.totalBudgetUsd, input.maxShare);
  const grantByIdx = new Map<number, number>();
  fundedOrder.forEach((i, k) => grantByIdx.set(i, grants[k]));

  const decisions: AllocationDecision[] = ranked.map((r, i) => {
    const s: Score = r.score;
    const grant = grantByIdx.get(i) ?? 0;
    const funded = grant > 0;
    let reason: string;
    if (funded) {
      reason =
        `funded $${grant.toFixed(2)} (${pct(grant / input.totalBudgetUsd)}% of pool): rank #${i + 1}, ` +
        `fitness ${s.fitness.toFixed(3)} (pnl ${pct(s.pnl_pct)}%, maxDD ${pct(s.max_dd_pct)}%, ` +
        `win ${pct(s.win_rate)}%, ${s.trades_count} trades) — earned capital on risk-adjusted performance.`;
    } else if (r.agent.alive !== 1) {
      reason = "not funded: agent retired/dead.";
    } else if (s.trades_count < input.minTrades) {
      reason = `not funded: only ${s.trades_count} trades (< ${input.minTrades} required — no proof it acts).`;
    } else if (s.fitness < input.minFitness) {
      reason = `not funded: fitness ${s.fitness.toFixed(3)} below floor ${input.minFitness} — negative/insufficient edge.`;
    } else {
      reason = `not funded: outside top ${input.maxCapsules} eligible (rank #${i + 1}).`;
    }
    return {
      agentId: r.agent.id,
      agentName: r.agent.name,
      rank: i + 1,
      fitness: Math.round(s.fitness * 1000) / 1000,
      pnlPct: pct(s.pnl_pct),
      maxDdPct: pct(s.max_dd_pct),
      winRate: pct(s.win_rate),
      trades: s.trades_count,
      funded,
      grantUsd: grant,
      share: input.totalBudgetUsd > 0 ? grant / input.totalBudgetUsd : 0,
      reason,
    };
  });

  const funded = decisions.filter((d) => d.funded).sort((a, b) => b.grantUsd - a.grantUsd);
  const totalAllocatedUsd = Math.round(funded.reduce((s, d) => s + d.grantUsd, 0) * 100) / 100;

  return { decisions, funded, totalAllocatedUsd, totalBudgetUsd: input.totalBudgetUsd, generatedAt: null };
}

/**
 * Championship + capsule promotion.
 *
 * When a paper-agent lineage wins top-1 in the last N (default 3) consecutive
 * sealed generations, `arena:evolve` writes a `championship_log` row with
 * status='eligible'. The operator visits /capsules and either activates
 * (creates a real-money capsule in 'paper' stage) or rejects.
 *
 * This module is a thin coordination layer between `championship_log` and the
 * already-shipped capsule store at `@/lib/capsules/store`. We don't duplicate
 * capsule persistence here — `createCapsule` + `setStatus` from the store do it.
 */
import { db } from "@/lib/db/client";
import { createCapsule, setStatus, listCapsules as listAllCapsules, getCapsule as getCapsuleRow } from "@/lib/capsules/store";
import { attachCapsuleToChampionship, getPaperAgent } from "./db";
import { insertEvolutionEvent } from "@/lib/db/queries";
import { parseGenome } from "./genome";
import { computeReplayFitness, type ReplayFitnessResult } from "./replay-fitness";

export type EligibleChampionship = {
  id: number;
  paper_agent_id: number;
  consecutive_gen_wins: number;
  capsule_id: string | null;
  status: "eligible" | "proposed" | "activated" | "rejected" | "expired";
  rationale: string | null;
  created_at: string;
};

export function listEligibleChampionships(): EligibleChampionship[] {
  return db().prepare(
    `SELECT * FROM championship_log WHERE status IN ('eligible', 'proposed') ORDER BY id DESC`,
  ).all() as EligibleChampionship[];
}

/**
 * Propose a capsule for a championship. Creates a draft capsule via the
 * existing store, then flips its status to 'paper' (paper-trading stage —
 * not yet live with real money). Returns the new capsule id.
 *
 * Conservative defaults — caller can override via opts.
 */
export function proposeCapsuleForChampionship(
  championshipId: number,
  opts: { capital_usd?: number; daily_loss_cap_usd?: number; total_dd_cap_usd?: number; max_position_pct?: number; max_open_positions?: number; max_trades_per_day?: number; allowed_venues?: ("polymarket" | "coinbase")[] } = {},
): { capsuleId: string } {
  const champ = db().prepare(`SELECT * FROM championship_log WHERE id = ?`).get(championshipId) as EligibleChampionship | undefined;
  if (!champ) throw new Error(`championship ${championshipId} not found`);
  if (champ.status !== "eligible") throw new Error(`championship ${championshipId} is not eligible (status=${champ.status})`);
  const agent = getPaperAgent(champ.paper_agent_id);
  if (!agent) throw new Error(`paper_agent ${champ.paper_agent_id} not found`);

  const cap = opts.capital_usd ?? 25;
  const capsule = createCapsule({
    name: `${agent.name}-capsule`,
    capitalUsd: cap,
    allowedVenues: opts.allowed_venues ?? ["polymarket", "coinbase"],
    maxDailyLossUsd: opts.daily_loss_cap_usd ?? Math.max(2, cap * 0.10),
    maxTotalDrawdownUsd: opts.total_dd_cap_usd ?? Math.max(5, cap * 0.30),
    maxPositionPct: opts.max_position_pct ?? 0.5,
    maxOpenPositions: opts.max_open_positions ?? 3,
    maxTradesPerDay: opts.max_trades_per_day ?? 20,
  });
  // Bind to the paper_agent lineage so the live-capsule bridge can route
  // its decisions through the unified ExecutionRouter once activated.
  db().prepare(`UPDATE capsules SET paper_agent_id = ? WHERE id = ?`).run(agent.id, capsule.id);
  // Move from draft → paper so the capsule UI shows it as paper-trading.
  setStatus(capsule.id, "paper");
  attachCapsuleToChampionship(championshipId, capsule.id, "proposed");

  insertEvolutionEvent({
    event_type: "capsule-proposed",
    summary: `Capsule ${capsule.id.slice(0, 8)} proposed (paper) for paper_agent ${agent.id} ($${cap})`,
    payload_json: JSON.stringify({ championship_id: championshipId, paper_agent_id: agent.id, capsule_id: capsule.id, capital_usd: cap }),
  });
  return { capsuleId: capsule.id };
}

export type ActivationGateResult =
  | { ok: true }
  | { ok: false; reason: string; backtest?: ReplayFitnessResult };

/**
 * Pre-flight backtest gate. Runs the bound paper_agent's genome over the
 * last `ARENA_ACTIVATE_WINDOW_DAYS` (default 14) of snapshots and refuses
 * activation if PnL% < min or DD% > max (env-tunable, defaults below).
 * Use `bypass=true` to skip the gate (for ops emergencies — logged separately).
 */
export function activateCapsule(
  capsuleId: string,
  activatedBy: string,
  opts: { bypass?: boolean; windowDays?: number; minPnlPct?: number; maxDdPct?: number } = {},
): ActivationGateResult {
  const cap = getCapsuleRow(capsuleId);
  if (!cap) return { ok: false, reason: "capsule not found" };
  if (cap.status !== "paper") return { ok: false, reason: `cannot activate: status=${cap.status}` };

  // Look up bound paper_agent for the gate.
  const binding = db().prepare(`SELECT paper_agent_id FROM capsules WHERE id = ?`).get(capsuleId) as { paper_agent_id: number | null } | undefined;
  const paperAgentId = binding?.paper_agent_id ?? null;

  if (!opts.bypass && paperAgentId != null) {
    const agent = getPaperAgent(paperAgentId);
    if (agent) {
      const windowDays = opts.windowDays ?? Number(process.env.ARENA_ACTIVATE_WINDOW_DAYS ?? "14");
      const minPnlPct = opts.minPnlPct ?? Number(process.env.ARENA_ACTIVATE_MIN_PNL_PCT ?? "-0.02"); // -2%
      const maxDdPct = opts.maxDdPct ?? Number(process.env.ARENA_ACTIVATE_MAX_DD_PCT ?? "0.25");      // 25%
      try {
        const genome = parseGenome(agent.genome_json);
        const startIso = new Date(Date.now() - windowDays * 86_400_000).toISOString();
        const endIso = new Date().toISOString();
        const bt = computeReplayFitness(genome, { startIso, endIso });
        if (bt.pnl_pct < minPnlPct) {
          insertEvolutionEvent({
            event_type: "capsule-activation-blocked",
            summary: `Capsule ${capsuleId.slice(0, 8)} BLOCKED: backtest PnL ${(bt.pnl_pct * 100).toFixed(2)}% < threshold ${(minPnlPct * 100).toFixed(2)}%`,
            payload_json: JSON.stringify({ capsule_id: capsuleId, backtest: bt, threshold: { minPnlPct, maxDdPct, windowDays } }),
          });
          return { ok: false, reason: `pre-flight backtest pnl ${(bt.pnl_pct * 100).toFixed(2)}% below floor ${(minPnlPct * 100).toFixed(2)}%`, backtest: bt };
        }
        if (bt.max_dd_pct > maxDdPct) {
          insertEvolutionEvent({
            event_type: "capsule-activation-blocked",
            summary: `Capsule ${capsuleId.slice(0, 8)} BLOCKED: backtest DD ${(bt.max_dd_pct * 100).toFixed(2)}% > ceiling ${(maxDdPct * 100).toFixed(2)}%`,
            payload_json: JSON.stringify({ capsule_id: capsuleId, backtest: bt, threshold: { minPnlPct, maxDdPct, windowDays } }),
          });
          return { ok: false, reason: `pre-flight backtest drawdown ${(bt.max_dd_pct * 100).toFixed(2)}% above ceiling ${(maxDdPct * 100).toFixed(2)}%`, backtest: bt };
        }
        insertEvolutionEvent({
          event_type: "capsule-activation-gate-passed",
          summary: `Capsule ${capsuleId.slice(0, 8)} pre-flight OK: pnl=${(bt.pnl_pct * 100).toFixed(2)}%, dd=${(bt.max_dd_pct * 100).toFixed(2)}%, ${bt.trades_count} trades`,
          payload_json: JSON.stringify({ capsule_id: capsuleId, backtest: bt }),
        });
      } catch (err) {
        return { ok: false, reason: `pre-flight backtest crashed: ${(err as Error).message}` };
      }
    }
  }

  setStatus(capsuleId, "live");
  db().prepare(`UPDATE championship_log SET status = 'activated' WHERE capsule_id = ?`).run(capsuleId);
  insertEvolutionEvent({
    event_type: "capsule-activated",
    summary: `Capsule ${capsuleId.slice(0, 8)} activated to LIVE by ${activatedBy}${opts.bypass ? " (BYPASS gate)" : ""}`,
    payload_json: JSON.stringify({ capsule_id: capsuleId, activated_by: activatedBy, bypass: !!opts.bypass }),
  });
  return { ok: true };
}

export function rejectChampionship(championshipId: number, reason: string): void {
  db().prepare(`UPDATE championship_log SET status = 'rejected', rationale = COALESCE(rationale, '') || ' | rejected: ' || ? WHERE id = ?`).run(reason, championshipId);
  insertEvolutionEvent({
    event_type: "championship-rejected",
    summary: `Championship ${championshipId} rejected: ${reason}`,
    payload_json: JSON.stringify({ championship_id: championshipId, reason }),
  });
}

/** Engage capsule kill-switch: flip 'live' → 'paused'. Reversible via /api/capsules POST setStatus. */
export function pauseCapsule(capsuleId: string, reason: string): void {
  setStatus(capsuleId, "paused");
  insertEvolutionEvent({
    event_type: "capsule-paused",
    summary: `Capsule ${capsuleId.slice(0, 8)} PAUSED: ${reason}`,
    payload_json: JSON.stringify({ capsule_id: capsuleId, reason }),
  });
}

// Re-exports for symmetric API of arena/capsule pages.
export { listAllCapsules as listCapsules, getCapsuleRow as getCapsule };

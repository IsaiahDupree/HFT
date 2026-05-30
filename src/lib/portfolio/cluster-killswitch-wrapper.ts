/**
 * DB-side wrapper around the pure `cluster-killswitch.ts` module.
 *
 * Loads live + paper capsules with their diversity columns, calls the pure
 * `checkClusters()`, persists pause actions to `capsules.status` and logs
 * every trip to `evolution_log`. Returns a summary for the EvolveResult.
 *
 * Wired into `arena/evolve.ts` after the per-capsule circuit-breaker so a
 * cluster trip pauses every member of the cluster atomically rather than
 * waiting for each capsule's individual daily cap to fire one at a time.
 *
 * Capsules already in 'paused' status are SKIPPED — the killswitch doesn't
 * re-pause already-paused capsules (no-op). Reduce-size actions are
 * journaled but the size-multiplier itself is consumed downstream by the
 * decision pipeline (Phase 9), not applied directly here — this module
 * only pauses; sizing modulation lives one layer up.
 */
import { db } from "@/lib/db/client";
import { insertEvolutionEvent } from "@/lib/db/queries";
import {
  checkClusters,
  readThresholdsFromEnv,
  type ClusterInputCapsule,
} from "./cluster-killswitch";

export type ApplyClusterResult = {
  inspected: number;
  paused: { capsule_id: string; capsule_name: string; reason: string; summary: string }[];
  risk_off: { capsule_id: string; capsule_name: string; size_multiplier: number }[];
  global_kill_switch: boolean;
};

type CapsuleRow = ClusterInputCapsule & { /* placeholder for future fields */ };

export function applyClusterKillSwitches(): ApplyClusterResult {
  const dbHandle = db();
  // Read every active capsule. Cluster math uses ALL active capsules (live
  // + paper) so a sim cluster gives a meaningful denominator even with
  // few real-money capsules. Paused capsules excluded — they're already off.
  const capsules = dbHandle
    .prepare(
      `SELECT id, name, status, strategy_family, asset_class,
              capital_allocated_usd, daily_pnl_usd
         FROM capsules
        WHERE status IN ('live', 'paper')`,
    )
    .all() as CapsuleRow[];

  if (capsules.length === 0) {
    return { inspected: 0, paused: [], risk_off: [], global_kill_switch: false };
  }

  const thresholds = readThresholdsFromEnv();
  const decisions = checkClusters(capsules, thresholds);

  const paused: ApplyClusterResult["paused"] = [];
  const risk_off: ApplyClusterResult["risk_off"] = [];
  let globalKill = false;

  const updateStatus = dbHandle.prepare(
    `UPDATE capsules SET status = 'paused', updated_at = datetime('now') WHERE id = ?`,
  );

  for (const d of decisions) {
    if (d.action === "pause" && d.reason) {
      updateStatus.run(d.capsule_id);
      paused.push({
        capsule_id: d.capsule_id,
        capsule_name: d.capsule_name,
        reason: d.reason,
        summary: d.summary,
      });
      if (d.reason === "global_kill_switch") globalKill = true;
      insertEvolutionEvent({
        event_type: "cluster-killswitch-trip",
        summary: `Capsule ${d.capsule_id.slice(0, 8)} (${d.capsule_name.slice(0, 30)}) → pause · ${d.reason} · ${d.summary}`,
        payload_json: JSON.stringify({
          capsule_id: d.capsule_id,
          action: d.action,
          reason: d.reason,
          summary: d.summary,
          size_multiplier: d.size_multiplier,
        }),
      });
    } else if (d.action === "reduce_size") {
      risk_off.push({
        capsule_id: d.capsule_id,
        capsule_name: d.capsule_name,
        size_multiplier: d.size_multiplier,
      });
      insertEvolutionEvent({
        event_type: "cluster-killswitch-trip",
        summary: `Capsule ${d.capsule_id.slice(0, 8)} (${d.capsule_name.slice(0, 30)}) → reduce_size × ${d.size_multiplier} · ${d.reason} · ${d.summary}`,
        payload_json: JSON.stringify({
          capsule_id: d.capsule_id,
          action: d.action,
          reason: d.reason,
          summary: d.summary,
          size_multiplier: d.size_multiplier,
        }),
      });
    }
  }

  return { inspected: capsules.length, paused, risk_off, global_kill_switch: globalKill };
}

/**
 * JSON snapshot endpoint for the portfolio governance view. Backs the
 * /portfolio UI's auto-refresh + offline analysis.
 *
 *   GET /api/portfolio  → { reserve, capsules, correlations, loss_overlap }
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { readGovernorThresholdsFromEnv } from "@/lib/portfolio/governor";
import { lossOverlapScore } from "@/lib/portfolio/loss-overlap";
import type { DailyPnlPoint } from "@/lib/portfolio/correlation";

export const dynamic = "force-dynamic";

export async function GET() {
  const dbHandle = db();
  const thresholds = readGovernorThresholdsFromEnv();
  const totalAccountUsd = Number(process.env.ARENA_TOTAL_ACCOUNT_USD ?? "0");

  const capsules = dbHandle
    .prepare(
      `SELECT id, name, status, strategy_family, asset_class,
              regime_dependency, time_horizon, directional_bias,
              capital_allocated_usd, daily_pnl_usd, current_pnl_usd
         FROM capsules
        WHERE status IN ('live', 'paper', 'paused')
        ORDER BY status, capital_allocated_usd DESC`,
    )
    .all();

  const latestSnapshot = (dbHandle
    .prepare("SELECT MAX(snapshot_date) AS d FROM capsule_correlations")
    .get() as { d: string | null })?.d;
  const correlations = latestSnapshot
    ? dbHandle
        .prepare(
          `SELECT capsule_a, capsule_b, pnl_corr, asset_overlap,
                  strategy_family_match, loss_overlap, drawdown_overlap,
                  sample_days, verdict, low_confidence, snapshot_date
             FROM capsule_correlations
            WHERE snapshot_date = ?`,
        )
        .all(latestSnapshot)
    : [];

  const pnlRows = dbHandle
    .prepare(
      `SELECT capsule_id, pnl_date, daily_pnl_usd
         FROM capsule_pnl_daily
        WHERE pnl_date >= date('now', '-30 days')
        ORDER BY pnl_date ASC`,
    )
    .all() as { capsule_id: string; pnl_date: string; daily_pnl_usd: number }[];

  const seriesByCapsule = new Map<string, DailyPnlPoint[]>();
  for (const r of pnlRows) {
    const list = seriesByCapsule.get(r.capsule_id) ?? [];
    list.push({ date: r.pnl_date, pnl: r.daily_pnl_usd });
    seriesByCapsule.set(r.capsule_id, list);
  }

  const activeCapsules = (capsules as Array<Record<string, unknown>>).filter(
    (c) => c.strategy_family !== "reserve" && c.status !== "paused" && c.status !== "stopped",
  ) as Array<{ id: string }>;

  const lossOverlap = activeCapsules.map((cap) => {
    const target = seriesByCapsule.get(cap.id) ?? [];
    const others = activeCapsules
      .filter((c) => c.id !== cap.id)
      .map((c) => ({ capsuleId: c.id, series: seriesByCapsule.get(c.id) ?? [] }));
    return {
      capsule_id: cap.id,
      ...lossOverlapScore({ targetSeries: target, others, windowDays: 30 }),
    };
  });

  const reserve = (capsules as Array<{ strategy_family: string | null; capital_allocated_usd: number }>).find(
    (c) => c.strategy_family === "reserve",
  );

  return NextResponse.json({
    snapshot_ts: new Date().toISOString(),
    total_account_usd: totalAccountUsd,
    reserve: {
      pct_floor: thresholds.reservePct,
      capital_usd: reserve?.capital_allocated_usd ?? 0,
    },
    capsules,
    correlations,
    correlations_snapshot_date: latestSnapshot,
    loss_overlap: lossOverlap,
  });
}
